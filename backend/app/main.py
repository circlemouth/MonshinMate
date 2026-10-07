"""FastAPI バックエンドのエントリポイント。

問診テンプレート取得やチャット応答を含む簡易 API を提供する。
"""
from __future__ import annotations
from typing import Any, Iterable, Literal
from uuid import uuid4
import time
from datetime import datetime, timedelta, UTC
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import os
import io
import zipfile
import re
import csv
import json
import base64
import hashlib
import secrets
import mimetypes
import unicodedata
import threading
from urllib.parse import quote, urlparse
from pathlib import Path
try:
    from dotenv import load_dotenv
except Exception:  # ランタイム環境に dotenv が無い場合でも起動を継続
    def load_dotenv(*_args, **_kwargs):  # type: ignore
        return False

# .env の読み込み（リポジトリルートのみ）
_BASE_DIR = Path(__file__).resolve().parents[1]
_PROJECT_ROOT = _BASE_DIR.parent
load_dotenv(_PROJECT_ROOT / ".env")

from fastapi import FastAPI, HTTPException, Response, Request, BackgroundTasks, Query, UploadFile, File, Form, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import sqlite3
from pydantic import BaseModel, Field
import pyotp
from jose import JWTError, jwt

from .llm_gateway import (
    LLMGateway,
    LLMSettings,
    ProviderProfile,
    DEFAULT_FOLLOWUP_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
)
from .llm_provider_registry import (
    get_provider_meta_list,
    get_provider_registry,
    ProviderMetaSchema,
)
from .llm_settings_security import (
    sanitize_llm_settings_for_read,
    sanitize_llm_settings_for_storage,
)
from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings
from .db import (
    init_db,
    upsert_template,
    get_template as db_get_template,
    list_templates,
    delete_template,
    rename_template,
    save_session,
    list_sessions as db_list_sessions,
    list_sessions_page as db_list_sessions_page,
    get_session as db_get_session,
    list_sessions_finalized_after,
    upsert_summary_prompt,
    get_summary_prompt,
    get_summary_config,
    upsert_followup_prompt,
    get_followup_prompt,
    get_followup_config,
    save_llm_settings,
    load_llm_settings,
    save_app_settings,
    load_app_settings,
    get_user_by_username,
    update_password,
    verify_password,
    update_totp_secret,
    set_totp_status,
    get_totp_mode,
    set_totp_mode,
    DEFAULT_DB_PATH,
    couch_db,
    COUCHDB_URL,
    check_firestore_health,
    get_current_persistence_backend,
    export_questionnaire_settings,
    import_questionnaire_settings,
    export_sessions_data,
    import_sessions_data,
    delete_session as db_delete_session,
    delete_sessions as db_delete_sessions,
    save_binary_asset,
    load_binary_asset,
    delete_binary_asset,
    list_binary_assets,
    save_push_subscription,
    delete_push_subscription,
    list_push_subscriptions,
)
from .validator import Validator
from .session_fsm import SessionFSM
from .structured_context import StructuredContextManager
from .pdf_layout import PDFLayoutMode
from .personal_info import (
    format_lines as format_personal_info_lines,
    format_multiline as format_personal_info_multiline,
)
from .postal_code_lookup import (
    PostalCodeImportError,
    get_postal_dictionary_info,
    import_postal_csv,
    lookup_postal_code,
)
from .secret_manager import load_secrets
import logging
from logging.handlers import RotatingFileHandler


def _render_session_pdf(*args: Any, **kwargs: Any) -> bytes:
    """PDF機能を使う時だけReportLabを読み込み、通常起動を軽くする。"""

    from .pdf_renderer import render_session_pdf

    return render_session_pdf(*args, **kwargs)

load_secrets()
_settings = get_settings()


def _resolve_allowed_origins() -> list[str]:
    env_value = os.getenv("FRONTEND_ALLOWED_ORIGINS", "")
    origins = [origin.strip() for origin in env_value.split(",") if origin.strip()]
    if origins:
        return origins
    if _settings.environment.lower() == "local":
        return [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ]
    return []


def _external_url_for(request: Request, route_name: str) -> str:
    """Cloud Run などのプロキシ環境でも外向きに合わせたスキームで URL を返す。"""

    url = request.url_for(route_name)
    forwarded_proto = request.headers.get("X-Forwarded-Proto")
    if forwarded_proto and forwarded_proto.lower() in {"http", "https"}:
        return str(url.replace(scheme=forwarded_proto.lower()))
    env = os.getenv("MONSHINMATE_ENV", "").lower()
    if env and env != "local":
        return str(url.replace(scheme="https"))
    return str(url)

# Purpose-bound JWTs and persistent revocation are owned by admin_security.
from . import admin_security
from .security_config import SECRET_KEY
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
ADMIN_PUSH_TOKEN_EXPIRE_MINUTES = 15


def _decode_admin_access_token(authorization: str | None) -> dict[str, Any]:
    return admin_security.decode_access(authorization)


def require_admin_access(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """管理者JWTを検証するFastAPI dependency。"""

    claims = _decode_admin_access_token(authorization)
    scopes = set(str(claims.get("scope") or "").split())
    if "admin" not in scopes:
        raise HTTPException(status_code=403, detail="insufficient scope")
    return claims

init_db()
from .api_policy import protected_route_class, RequestBoundaryMiddleware
from .patient_security import issue_capability, finalize_receipt, rate_limit

app = FastAPI(title="MonshinMate API", docs_url=None, redoc_url=None, openapi_url=None)
app.router.route_class = protected_route_class(require_admin_access)
app.add_middleware(RequestBoundaryMiddleware)

_allowed_origins = _resolve_allowed_origins()
_allowed_origin_regex = os.getenv("FRONTEND_ALLOWED_ORIGIN_REGEX")
# Extension origins must be listed explicitly; do not authorize every installed extension.
if _allowed_origins or _allowed_origin_regex:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins or [],
        allow_origin_regex=_allowed_origin_regex,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# 問診項目画像の保存先を初期化し、静的配信を行う
IMAGE_DIR = Path(__file__).resolve().parent / "questionnaire_item_images"
# System logo/icon storage
LOGO_DIR = Path(__file__).resolve().parent / "system_logo"

# カテゴリ識別子（DB 永続化用）
QUESTIONNAIRE_IMAGE_CATEGORY = "questionnaire_item_image"
SYSTEM_LOGO_CATEGORY = "system_logo_image"

logger = logging.getLogger("api")

PATIENT_SUMMARY_API_HEADER = "X-MonshinMate-Api-Key"

# サマリー生成用のデフォルトプロンプト
DEFAULT_SUMMARY_PROMPT = (
    "あなたは医療記録作成の専門家です。"
    "以下の問診項目と回答をもとに、患者情報を正確かつ簡潔な日本語のサマリーにまとめてください。"
    "主訴と発症時期などの重要事項を冒頭に記載し、その後に関連情報を読みやすく整理してください。"
    "推測や不要な前置きは避け、医療従事者がすぐ理解できる表現を用いてください。"
)


def _ensure_default_prompts() -> None:
    """デフォルトテンプレートのプロンプトを欠損時のみ初期化する。"""

    for visit_type in ("initial", "followup"):
        if get_summary_config("default", visit_type) is None:
            upsert_summary_prompt("default", visit_type, DEFAULT_SUMMARY_PROMPT, False)
        if get_followup_config("default", visit_type) is None:
            upsert_followup_prompt("default", visit_type, DEFAULT_FOLLOWUP_PROMPT, False)


from .transfer_security import (
    MAX_ASSET_BYTES, MAX_IMPORT_BYTES, MAX_IMPORT_RECORDS, SAFE_HEADERS,
    SafeCSVWriter, clean_raster, read_import, portable_app_settings,
    portable_session, validate_assets, validate_questionnaires, validate_sessions,
    atomic_import,
)

EXPORT_PBKDF_ITERATIONS = 390_000
IMAGE_FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
IMAGE_STORAGE_SEGMENT = "questionnaire-item-images/files/"
SYSTEM_LOGO_STORAGE_SEGMENT = "system-logo/files/"


def _build_export_envelope(data: Any, export_type: str, password: str | None) -> dict[str, Any]:
    """エクスポートデータを暗号化設定付きの包みにまとめる。"""

    envelope: dict[str, Any] = {
        "version": 1,
        "type": export_type,
        "exported_at": datetime.now(UTC).isoformat(),
    }
    if password:
        if len(password) > 1024:
            raise HTTPException(status_code=400, detail="invalid_password")
        salt = secrets.token_bytes(16)
        key_material = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, EXPORT_PBKDF_ITERATIONS, dklen=32
        )
        fernet_key = base64.urlsafe_b64encode(key_material)
        cipher = Fernet(fernet_key)
        plaintext = json.dumps(data, ensure_ascii=False).encode("utf-8")
        ciphertext = cipher.encrypt(plaintext)
        envelope["encryption"] = {
            "algorithm": "fernet",
            "kdf": "pbkdf2_hmac",
            "salt": base64.b64encode(salt).decode("ascii"),
            "iterations": EXPORT_PBKDF_ITERATIONS,
        }
        envelope["payload"] = base64.b64encode(ciphertext).decode("ascii")
    else:
        envelope["encryption"] = None
        envelope["payload"] = data
    return envelope


def _parse_import_envelope(raw_bytes: bytes, password: str | None) -> tuple[str, Any]:
    """エクスポートファイルを復号し、中身の種別とデータを返す。"""

    if len(raw_bytes) > MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="import_too_large")
    if password and len(password) > 1024:
        raise HTTPException(status_code=400, detail="invalid_password")
    try:
        try:
            text = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            text = raw_bytes.decode("utf-8-sig")
        if text.startswith("\ufeff"):
            text = text.lstrip("\ufeff")
        envelope = json.loads(text)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid_export_file")
    if (not isinstance(envelope, dict) or type(envelope.get("version")) is not int
            or envelope.get("version") != 1 or envelope.get("type") not in {"questionnaire_settings", "session_data"}
            or "payload" not in envelope or "encryption" not in envelope):
        raise HTTPException(status_code=400, detail="invalid_export_file")
    export_type = envelope.get("type")
    encryption = envelope.get("encryption")
    payload = envelope.get("payload")
    if encryption is not None:
        if (not isinstance(encryption, dict) or encryption.get("algorithm") != "fernet"
                or encryption.get("kdf") != "pbkdf2_hmac"
                or type(encryption.get("iterations")) is not int
                or encryption.get("iterations") != EXPORT_PBKDF_ITERATIONS
                or not isinstance(encryption.get("salt"), str)
                or not isinstance(payload, str)):
            raise HTTPException(status_code=400, detail="invalid_export_encryption")
        try:
            salt = base64.b64decode(encryption["salt"], validate=True)
            ciphertext = base64.b64decode(payload, validate=True)
            if len(salt) != 16 or len(ciphertext) < 100:
                raise ValueError("invalid encryption metadata")
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="invalid_export_encryption")
        if not password:
            raise HTTPException(status_code=400, detail="password_required")
        try:
            key_material = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), salt, EXPORT_PBKDF_ITERATIONS, dklen=32
            )
            cipher = Fernet(base64.urlsafe_b64encode(key_material))
            decrypted = cipher.decrypt(ciphertext)
            payload_data = json.loads(decrypted.decode("utf-8"))
        except InvalidToken:
            raise HTTPException(status_code=400, detail="invalid_password")
        except Exception:
            raise HTTPException(status_code=400, detail="invalid_export_payload")
    else:
        payload_data = payload
    return str(export_type or ""), payload_data


def _extract_storage_filename(raw_url: str | None, segment: str) -> str | None:
    if not raw_url:
        return None
    value = raw_url.strip()
    if not value or value.startswith("data:"):
        return None
    parsed = urlparse(value)
    candidates = [parsed.path or "", value]
    for candidate in candidates:
        idx = candidate.find(segment)
        if idx == -1:
            if candidate.startswith("/" + segment):
                idx = 1
            elif candidate.startswith(segment):
                idx = 0
        if idx != -1:
            remainder = candidate[idx + len(segment) :]
            filename = remainder.split("/")[0].split("?")[0].split("#")[0]
            if filename:
                return filename
    return None


def _extract_image_filename(image_url: str | None) -> str | None:
    return _extract_storage_filename(image_url, IMAGE_STORAGE_SEGMENT)


def _extract_logo_filename(logo_url: str | None) -> str | None:
    return _extract_storage_filename(logo_url, SYSTEM_LOGO_STORAGE_SEGMENT)


def _sanitize_image_filename(name: str) -> str:
    sanitized = Path(name or "").name
    if sanitized and IMAGE_FILENAME_PATTERN.fullmatch(sanitized):
        return sanitized

    stem = Path(sanitized or "image").stem or "image"
    suffix = Path(sanitized or "image").suffix.lower()
    if not suffix or not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        suffix = ".png"
    stem_ascii = re.sub(r"[^A-Za-z0-9_-]", "_", stem)[:32] or "image"
    fallback = f"{stem_ascii}_{uuid4().hex[:8]}{suffix}"
    if not IMAGE_FILENAME_PATTERN.fullmatch(fallback):
        fallback = f"image_{uuid4().hex[:8]}{suffix}"
    return fallback


def _canonicalize_image_field(image: Any, bucket: set[str]) -> str | None:
    if not isinstance(image, str):
        return None
    trimmed = image.strip()
    if not trimmed:
        return ""
    filename = _extract_image_filename(trimmed)
    if not filename:
        return trimmed
    sanitized = _sanitize_image_filename(filename)
    bucket.add(sanitized)
    return f"/{IMAGE_STORAGE_SEGMENT}{sanitized}"


def _normalize_items_for_transfer(items: list[Any], bucket: set[str]) -> list[Any]:
    normalized: list[Any] = []
    for item in items:
        if not isinstance(item, dict):
            normalized.append(item)
            continue
        item_copy: dict[str, Any] = dict(item)
        normalized_image = _canonicalize_image_field(item_copy.get("image"), bucket)
        if normalized_image is None:
            pass
        elif normalized_image == "":
            item_copy.pop("image", None)
        else:
            item_copy["image"] = normalized_image
        followups = item_copy.get("followups")
        if isinstance(followups, dict):
            normalized_followups: dict[str, Any] = {}
            for key, children in followups.items():
                if isinstance(children, list):
                    normalized_followups[key] = _normalize_items_for_transfer(children, bucket)
                else:
                    normalized_followups[key] = children
            item_copy["followups"] = normalized_followups
        normalized.append(item_copy)
    return normalized


def _normalize_templates_for_transfer(
    templates: list[dict[str, Any]] | None,
) -> tuple[list[dict[str, Any]], set[str]]:
    if not templates:
        return [], set()
    bucket: set[str] = set()
    normalized_templates: list[dict[str, Any]] = []
    for tpl in templates:
        if not isinstance(tpl, dict):
            continue
        tpl_copy = dict(tpl)
        items = tpl_copy.get("items")
        if isinstance(items, list):
            tpl_copy["items"] = _normalize_items_for_transfer(items, bucket)
        normalized_templates.append(tpl_copy)
    return normalized_templates, bucket


def _load_image_payloads(image_names: set[str]) -> dict[str, str]:
    payloads: dict[str, str] = {}
    for name in sorted(image_names):
        try:
            sanitized = _sanitize_image_filename(name)
        except ValueError:
            continue
        asset = load_binary_asset(QUESTIONNAIRE_IMAGE_CATEGORY, sanitized)
        content: bytes | bytearray | None
        if asset:
            raw_content = asset.get("content")
            content = bytes(raw_content) if isinstance(raw_content, (bytes, bytearray)) else None
        else:
            legacy_path = IMAGE_DIR / sanitized
            content = None
            if legacy_path.is_file() and not legacy_path.is_symlink():
                with legacy_path.open("rb") as source:
                    content = source.read(MAX_ASSET_BYTES + 1)
        if not content:
            continue
        content, _, _ = clean_raster(bytes(content))
        payloads[sanitized] = base64.b64encode(content).decode("ascii")
    return payloads


def _canonicalize_logo_url(raw_url: Any) -> tuple[str | None, dict[str, str]]:
    if not isinstance(raw_url, str):
        return None, {}
    trimmed = raw_url.strip()
    if not trimmed:
        return "", {}
    filename = _extract_logo_filename(trimmed)
    if not filename:
        return trimmed, {}
    try:
        sanitized = _sanitize_image_filename(filename)
    except ValueError:
        return trimmed, {}
    asset = load_binary_asset(SYSTEM_LOGO_CATEGORY, sanitized)
    if not asset:
        return f"/{SYSTEM_LOGO_STORAGE_SEGMENT}{sanitized}", {}
    content = asset.get("content")
    if not isinstance(content, (bytes, bytearray)):
        return f"/{SYSTEM_LOGO_STORAGE_SEGMENT}{sanitized}", {}
    content, _, _ = clean_raster(bytes(content))
    encoded = base64.b64encode(content).decode("ascii")
    return f"/{SYSTEM_LOGO_STORAGE_SEGMENT}{sanitized}", {sanitized: encoded}


def _normalize_app_settings_for_transfer(settings: Any) -> tuple[dict[str, Any], dict[str, str]]:
    if not isinstance(settings, dict):
        return {}, {}
    normalized = portable_app_settings(settings)
    logo_payloads: dict[str, str] = {}
    if "logo_url" in normalized:
        normalized_logo, payload = _canonicalize_logo_url(normalized.get("logo_url"))
        if normalized_logo == "":
            normalized.pop("logo_url", None)
        elif normalized_logo is not None:
            normalized["logo_url"] = normalized_logo
        if payload:
            logo_payloads.update(payload)
    return normalized, logo_payloads


def _sanitize_app_settings_payload(settings: Any) -> dict[str, Any]:
    if not isinstance(settings, dict):
        return {}
    sanitized = portable_app_settings(settings)
    logo_url = sanitized.get("logo_url")
    if isinstance(logo_url, str):
        normalized_logo, _ = _canonicalize_logo_url(logo_url)
        if normalized_logo == "":
            sanitized.pop("logo_url", None)
        elif normalized_logo is not None:
            sanitized["logo_url"] = normalized_logo
    return sanitized



def _restore_logo_files(logo_payloads: Any, mode: str) -> int:
    # Per-asset writes cannot satisfy the import transaction contract.
    validate_assets(logo_payloads)
    raise HTTPException(status_code=501, detail="atomic_import_not_supported")


def _restore_images(image_payloads: Any, mode: str) -> int:
    validate_assets(image_payloads)
    raise HTTPException(status_code=501, detail="atomic_import_not_supported")


def _build_binary_asset_response(asset: dict[str, Any], fallback_name: str) -> Response:
    content = asset.get("content")
    if not isinstance(content, (bytes, bytearray)):
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        data, media_type, _ = clean_raster(bytes(content))
    except HTTPException:
        raise HTTPException(status_code=404, detail="asset_not_found") from None
    return Response(content=data, media_type=media_type, headers={
        **SAFE_HEADERS, "Cache-Control": "private, max-age=86400",
    })


@app.get("/questionnaire-item-images/files/{filename}")
def fetch_questionnaire_item_image(filename: str) -> Response:
    """問診項目画像を DB から取得して返す。"""
    if not IMAGE_FILENAME_PATTERN.fullmatch(filename):
        raise HTTPException(status_code=404, detail="image_not_found")
    asset = load_binary_asset(QUESTIONNAIRE_IMAGE_CATEGORY, filename)
    if not asset:
        raise HTTPException(status_code=404, detail="image_not_found")
    return _build_binary_asset_response(asset, filename)


@app.get("/system-logo/files/{filename}")
def fetch_system_logo(filename: str) -> Response:
    """システムロゴ画像を DB から取得して返す。"""
    if not IMAGE_FILENAME_PATTERN.fullmatch(filename):
        raise HTTPException(status_code=404, detail="logo_not_found")
    asset = load_binary_asset(SYSTEM_LOGO_CATEGORY, filename)
    if not asset:
        raise HTTPException(status_code=404, detail="logo_not_found")
    return _build_binary_asset_response(asset, filename)


@app.middleware("http")
async def log_middleware(request: Request, call_next):
    """API 呼び出しとエラーを記録するミドルウェア。"""
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:  # noqa: BLE001 - ログ出力後に再送出
        logger.error("api_error route=%s method=%s", getattr(request.scope.get("route"), "path", "unmatched"), request.method)
        raise
    duration = (time.perf_counter() - start) * 1000
    logger.info(
        "api_call path=%s method=%s status=%d duration_ms=%.1f",
        getattr(request.scope.get("route"), "path", "unmatched"),
        request.method,
        response.status_code,
        duration,
    )
    return response


def make_default_initial_items() -> list[dict[str, Any]]:
    """初診テンプレートに投入する問診項目定義。"""

    return [
        {
            "id": "personal_info",
            "label": "患者基本情報",
            "type": "personal_info",
            "required": True,
            "description": "氏名・よみがな・住所・電話番号を入力してください。",
        },
        {
            "id": "chief_complaint",
            "label": "本日のご相談内容を教えてください",
            "type": "string",
            "required": True,
            "description": "症状が気になり始めた経緯や困っていることをご記入ください。",
        },
        {
            "id": "symptom_location",
            "label": "症状が気になる部位を教えてください",
            "type": "multi",
            "options": [
                "頭・顔",
                "首・肩",
                "胸・背中",
                "腹部・腰",
                "腕・手",
                "脚・足",
                "皮膚（全身）",
            ],
            "allow_freetext": True,
            "required": True,
            "description": "複数選択できます。該当がない場合は下の自由記入欄へご記入ください。",
        },
        {
            "id": "onset",
            "label": "症状が気になり始めた時期",
            "type": "multi",
            "options": [
                "本日",
                "2〜3日前から",
                "1週間以上前から",
                "1か月以上前から",
                "半年前より前から",
            ],
            "allow_freetext": True,
            "required": True,
            "description": "大まかで構いません。思い出せる範囲でご記入ください。",
        },
        {
            "id": "symptom_course",
            "label": "症状の変化",
            "type": "multi",
            "options": [
                "良くなってきている",
                "変わらない",
                "悪化している",
                "波がある",
            ],
            "allow_freetext": True,
            "required": False,
            "description": "当てはまるものを選んでください。補足があれば自由記入欄をご利用ください。",
        },
        {
            "id": "symptom_trigger",
            "label": "症状が出やすいきっかけや時間帯があれば教えてください",
            "type": "string",
            "required": False,
            "description": "例：仕事後に悪化する、運動すると痛む など。",
        },
        {
            "id": "daily_impact",
            "label": "日常生活で困っていることがあれば教えてください",
            "type": "string",
            "required": False,
            "description": "睡眠や仕事・家事で支障があればご記入ください。",
        },
        {
            "id": "prior_treatments",
            "label": "これまで行った対処や治療を選んでください",
            "type": "multi",
            "options": [
                "なし",
                "医療機関で診察を受けた",
                "処方薬を使用した",
                "市販薬を使用した",
                "リハビリや施術を受けた",
            ],
            "allow_freetext": True,
            "required": False,
            "description": "複数選択できます。記入欄で詳細を補足できます。",
        },
        {
            "id": "past_diseases",
            "label": "これまでに指摘された病気を選んでください",
            "type": "multi",
            "options": [
                "なし",
                "高血圧",
                "糖尿病",
                "脂質異常症",
                "心臓病",
                "脳卒中",
                "喘息",
                "アトピー性皮膚炎",
            ],
            "allow_freetext": True,
            "required": False,
            "description": "該当するものを選び、その他の病名は自由記入欄にご記入ください。",
        },
        {
            "id": "surgeries",
            "label": "これまでに受けた主な手術を選んでください",
            "type": "multi",
            "options": [
                "なし",
                "皮膚科の手術",
                "整形外科の手術",
                "腹部の手術",
                "心臓・血管の手術",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "current_medications",
            "label": "現在服用している処方薬があれば選んでください",
            "type": "multi",
            "options": [
                "なし",
                "高血圧の薬",
                "糖尿病の薬",
                "コレステロールを下げる薬",
                "血液をさらさらにする薬",
                "痛み止めを毎日飲んでいる",
                "精神科・睡眠の薬",
            ],
            "allow_freetext": True,
            "required": False,
            "description": "薬の名前が分かれば自由記入欄にご記入ください。",
        },
        {
            "id": "supplements_otc",
            "label": "現在使用している市販薬やサプリメントを選んでください",
            "type": "multi",
            "options": [
                "なし",
                "ビタミン・サプリメント",
                "漢方薬",
                "鎮痛解熱薬",
                "アレルギーの市販薬",
                "保湿剤・外用剤",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "drug_allergies",
            "label": "薬剤アレルギーがあれば選んでください",
            "type": "multi",
            "options": [
                "なし",
                "ペニシリン系",
                "セフェム系",
                "マクロライド系",
                "ニューキノロン系",
                "NSAIDs",
                "局所麻酔",
                "わからない",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "food_metal_allergies",
            "label": "食物や金属でアレルギーがあれば選んでください",
            "type": "multi",
            "options": [
                "なし",
                "卵",
                "乳",
                "小麦",
                "そば",
                "落花生",
                "えび",
                "かに",
                "金属（ニッケル等）",
                "わからない",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "family_history",
            "label": "ご家族で指摘された主な病気があれば教えてください",
            "type": "string",
            "required": False,
        },
        {
            "id": "smoking",
            "label": "喫煙状況を教えてください",
            "type": "multi",
            "options": [
                "吸わない",
                "以前吸っていた（現在は吸わない）",
                "時々吸う",
                "毎日吸う",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "alcohol",
            "label": "お酒の頻度を教えてください",
            "type": "multi",
            "options": [
                "飲まない",
                "月に数回程度",
                "週に1〜2回",
                "週に3回以上",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "pregnancy",
            "label": "妊娠中ですか？",
            "type": "yesno",
            "required": False,
            "gender_enabled": True,
            "gender": "female",
        },
        {
            "id": "breastfeeding",
            "label": "授乳中ですか？",
            "type": "yesno",
            "required": False,
            "gender_enabled": True,
            "gender": "female",
        },
    ]


def make_default_followup_items() -> list[dict[str, Any]]:
    """再診テンプレートに投入する問診項目定義。"""

    return [
        {
            "id": "contact_update",
            "label": "住所や電話番号に変更があればご記入ください",
            "type": "string",
            "required": False,
            "description": "変更がなければ空欄で構いません。",
        },
        {
            "id": "chief_complaint",
            "label": "今回ご相談になりたい症状や経過を教えてください",
            "type": "string",
            "required": True,
            "description": "前回からの変化や気になる点をご記入ください。",
        },
        {
            "id": "symptom_progress",
            "label": "前回受診時からの症状の変化",
            "type": "multi",
            "options": [
                "良くなってきている",
                "ほとんど変わらない",
                "悪化している",
                "波がある",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "symptom_location",
            "label": "症状がある部位に変化があれば教えてください",
            "type": "multi",
            "options": [
                "頭・顔",
                "首・肩",
                "胸・背中",
                "腹部・腰",
                "腕・手",
                "脚・足",
                "皮膚（全身）",
            ],
            "allow_freetext": True,
            "required": False,
            "description": "変化がなければ未選択で構いません。",
        },
        {
            "id": "treatment_effect",
            "label": "現在の治療で感じている効果や不安があれば教えてください",
            "type": "string",
            "required": False,
        },
        {
            "id": "medication_adherence",
            "label": "処方薬の服用状況を選んでください",
            "type": "multi",
            "options": [
                "指示どおり服用できている",
                "のみ忘れがある",
                "副作用が心配で量を減らしている",
                "自己判断で中止した",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "medication_changes",
            "label": "前回から追加・中止した薬があれば教えてください",
            "type": "string",
            "required": False,
        },
        {
            "id": "side_effects",
            "label": "気になる副作用や体調の変化があれば教えてください",
            "type": "string",
            "required": False,
        },
        {
            "id": "daily_impact",
            "label": "日常生活で困っていることがあれば教えてください",
            "type": "string",
            "required": False,
        },
        {
            "id": "supplements_otc",
            "label": "新しく使用し始めた市販薬やサプリメントがあれば選んでください",
            "type": "multi",
            "options": [
                "なし",
                "ビタミン・サプリメント",
                "漢方薬",
                "鎮痛解熱薬",
                "アレルギーの市販薬",
                "保湿剤・外用剤",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "drug_allergies",
            "label": "新たに分かった薬剤アレルギーがあれば選んでください",
            "type": "multi",
            "options": [
                "なし",
                "ペニシリン系",
                "セフェム系",
                "マクロライド系",
                "ニューキノロン系",
                "NSAIDs",
                "局所麻酔",
                "わからない",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "pregnancy",
            "label": "妊娠中ですか？",
            "type": "yesno",
            "required": False,
            "gender_enabled": True,
            "gender": "female",
        },
        {
            "id": "breastfeeding",
            "label": "授乳中ですか？",
            "type": "yesno",
            "required": False,
            "gender_enabled": True,
            "gender": "female",
        },
    ]


@app.on_event("startup")
def on_startup() -> None:
    """アプリ起動時の初期化処理。DB 初期化とデフォルトテンプレ投入。"""
    init_db()
    if os.getenv("MIGRATE_LEGACY_ASSETS_ON_STARTUP", "1").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        _migrate_legacy_assets()
    # 監査ログ（security）をファイルにも出力
    try:
        log_dir = Path(__file__).resolve().parent / "logs"
        log_dir.mkdir(exist_ok=True)
        sec_log = logging.getLogger("security")
        if not any(isinstance(h, RotatingFileHandler) for h in sec_log.handlers):
            handler = RotatingFileHandler(log_dir / "security.log", maxBytes=1_000_000, backupCount=5)
            formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
            handler.setFormatter(formatter)
            sec_log.addHandler(handler)
            sec_log.setLevel(logging.INFO)
    except Exception:
        logging.getLogger(__name__).exception("failed to setup security logger")
    try:
        logging.getLogger(__name__).info("database_path=%s", DEFAULT_DB_PATH)
    except Exception:
        pass
    # 既定テンプレートは欠損時だけ投入し、起動ごとの Firestore 書き込みを避ける。
    initial_items = make_default_initial_items()
    followup_items = make_default_followup_items()
    if db_get_template("default", "initial") is None:
        upsert_template(
            "default",
            "initial",
            initial_items,
            llm_followup_enabled=True,
            llm_followup_max_questions=5,
        )
    if db_get_template("default", "followup") is None:
        upsert_template(
            "default",
            "followup",
            followup_items,
            llm_followup_enabled=True,
            llm_followup_max_questions=5,
        )
    _ensure_default_prompts()
    # 保存済みの LLM 設定があれば読み込む
    try:
        stored = load_llm_settings()
        if stored:
            llm_gateway.update_settings(
                LLMSettings(**sanitize_llm_settings_for_storage(stored))
            )
    except Exception:
        logging.getLogger(__name__).exception("failed to load stored llm settings; using defaults")
    llm_gateway.sync_status(reason="startup")

    logging.basicConfig(level=logging.INFO)
    logging.getLogger(__name__).info("startup completed")
    return


default_llm_settings = LLMSettings(
    provider="ollama",
    model="llama2",
    temperature=0.2,
    system_prompt=DEFAULT_SYSTEM_PROMPT,
    enabled=False,
    # 初期値としてローカルの Ollama 既定ポートを設定
    base_url="http://localhost:11434",
)
default_llm_settings.sync_to_active_profile()
llm_gateway = LLMGateway(default_llm_settings)

# メモリ上でセッションを保持する簡易ストア
sessions: dict[str, "Session"] = {}


@app.get("/health")
def health() -> dict:
    """死活監視用の簡易エンドポイント。"""
    return {"status": "ok"}


@app.get("/healthz")
def healthz() -> dict:
    """後方互換のためのエイリアス。"""
    return health()


@app.get("/readyz")
def readyz() -> dict:
    """依存疎通確認用のエンドポイント。"""
    db_ok = False
    snapshot = llm_gateway.get_status_snapshot()
    status_value = snapshot.get("status")
    if status_value is None:
        status_value = "disabled" if not llm_gateway.settings.enabled else "pending"
    detail_parts = [f"status={status_value}"]
    if snapshot.get("checked_at"):
        detail_parts.append(f"checked_at={snapshot['checked_at']}")
    if snapshot.get("source"):
        detail_parts.append(f"source={snapshot['source']}")
    if snapshot.get("detail"):
        detail_parts.append(f"detail={snapshot['detail']}")
    llm_ok = True
    if llm_gateway.settings.enabled and llm_gateway.settings.base_url:
        llm_ok = status_value in {"ok", "pending"}
    elif llm_gateway.settings.enabled and not llm_gateway.settings.base_url:
        detail_parts.append("note=base_url_missing")
    else:
        detail_parts.append("note=disabled")
    llm_detail = " ".join(detail_parts)
    try:
        backend = get_current_persistence_backend()
        db_ok = check_firestore_health() if backend == "firestore" else True
    except Exception:
        pass

    if db_ok and llm_ok:
        return {"status": "ready"}

    return {"status": "not_ready"}


@app.get("/")
def root() -> dict:
    """ルートアクセスに対する挨拶。

    Returns:
        dict: 挨拶文を含む辞書。
    """
    return {"message": "ようこそ"}


# removed: Postal code lookup (ZipCloud proxy)


class WhenCondition(BaseModel):
    """項目の表示条件（軽量版）。"""

    item_id: str
    equals: str


class QuestionnaireItem(BaseModel):
    """問診項目の定義。"""

    id: str
    label: str
    type: str
    required: bool = False
    options: list[str] | None = None
    allow_freetext: bool = False
    description: str | None = None
    image: str | None = None
    when: WhenCondition | None = None
    gender_enabled: bool = False
    gender: str | None = None
    age_enabled: bool = False
    min_age: int | None = None
    max_age: int | None = None
    min: float | None = None
    max: float | None = None
    followups: dict[str, list["QuestionnaireItem"]] | None = None


class Questionnaire(BaseModel):
    """問診テンプレートの構造。"""

    id: str
    # 互換のため GET はクエリで受けるが、保存系は明示
    items: list[QuestionnaireItem]
    llm_followup_enabled: bool = True
    llm_followup_max_questions: int = 5


class QuestionnaireUpsert(BaseModel):
    """テンプレート保存用モデル。"""

    id: str
    visit_type: str
    items: list[QuestionnaireItem]
    llm_followup_enabled: bool = True
    llm_followup_max_questions: int = 5


class SummaryPromptUpsert(BaseModel):
    """サマリー生成プロンプト保存用モデル。"""

    visit_type: str
    prompt: str
    enabled: bool = False


class FollowupPromptUpsert(BaseModel):
    """追加質問生成プロンプト保存用モデル。"""

    visit_type: str
    prompt: str
    enabled: bool = False


class QuestionnaireDuplicate(BaseModel):
    """テンプレート複製用モデル。"""

    new_id: str


class QuestionnaireRename(BaseModel):
    """テンプレートID変更用モデル。"""

    new_id: str


class ExportRequest(BaseModel):
    """暗号化付きエクスポート要求。"""

    password: str | None = None


class SessionsExportRequest(ExportRequest):
    """セッションエクスポート用フィルタ。"""

    session_ids: list[str] | None = None
    start_date: str | None = None
    end_date: str | None = None
    visit_type: Literal["initial", "followup"] | None = None


@app.get("/questionnaires/{questionnaire_id}/template", response_model=Questionnaire)
def get_questionnaire_template(
    questionnaire_id: str, visit_type: str, gender: str | None = None, age: int | None = None
) -> Questionnaire:
    """DB から問診テンプレートを取得する。無い場合は既定テンプレを返す。

    注意: テスト環境などで FastAPI の startup イベントが実行されない場合、
    DB テーブル未作成により例外が発生する可能性があるため、ここでは例外を
    捕捉してフォールバックを行う。
    """
    try:
        tpl = db_get_template(questionnaire_id, visit_type)
    except sqlite3.Error:
        # DB 未初期化などのケースはフォールバック（必要なら初期化を試行）
        try:
            init_db()
            tpl = db_get_template(questionnaire_id, visit_type)
        except Exception:
            tpl = None
    if tpl is None:
        # 既定テンプレをフォールバック返却
        default_tpl = db_get_template("default", visit_type) or {
            "id": "default",
            "visit_type": visit_type,
            "items": make_default_initial_items()
            if visit_type == "initial"
            else make_default_followup_items(),
            "llm_followup_enabled": True,
            "llm_followup_max_questions": 5,
        }
        # 呼び出し互換のため、要求された ID をそのまま設定
        items = [QuestionnaireItem(**it) for it in default_tpl["items"]]
        if gender or age is not None:
            filtered: list[QuestionnaireItem] = []
            for it in items:
                ok = True
                if it.gender_enabled:
                    if not gender or not (not it.gender or it.gender == "both" or it.gender == gender):
                        ok = False
                if it.age_enabled and age is not None:
                    if it.min_age is not None and age < it.min_age:
                        ok = False
                    if it.max_age is not None and age > it.max_age:
                        ok = False
                if ok:
                    filtered.append(it)
            items = filtered
        return Questionnaire(
            id=questionnaire_id,
            items=items,
            llm_followup_enabled=bool(default_tpl.get("llm_followup_enabled", True)),
            llm_followup_max_questions=int(default_tpl.get("llm_followup_max_questions", 5)),
        )
    items = [QuestionnaireItem(**it) for it in tpl["items"]]
    if gender or age is not None:
        filtered: list[QuestionnaireItem] = []
        for it in items:
            ok = True
            if it.gender_enabled:
                if not gender or not (not it.gender or it.gender == "both" or it.gender == gender):
                    ok = False
            if it.age_enabled and age is not None:
                if it.min_age is not None and age < it.min_age:
                    ok = False
                if it.max_age is not None and age > it.max_age:
                    ok = False
            if ok:
                filtered.append(it)
        items = filtered
    return Questionnaire(
        id=tpl["id"],
        items=items,
        llm_followup_enabled=bool(tpl.get("llm_followup_enabled", True)),
        llm_followup_max_questions=int(tpl.get("llm_followup_max_questions", 5)),
    )


@app.get("/questionnaires")
def list_questionnaires() -> list[dict]:
    """テンプレートの一覧を返す（id と visit_type のペア）。"""
    return list_templates()


@app.post("/questionnaires")
def upsert_questionnaire(payload: QuestionnaireUpsert) -> dict:
    """テンプレートを作成/更新する。"""
    upsert_template(
        template_id=payload.id,
        visit_type=payload.visit_type,
        items=[it.model_dump() for it in payload.items],
        llm_followup_enabled=payload.llm_followup_enabled,
        llm_followup_max_questions=payload.llm_followup_max_questions,
    )
    return {"status": "ok"}


@app.delete("/questionnaires/{questionnaire_id}")
def delete_questionnaire(questionnaire_id: str, visit_type: str) -> dict:
    """テンプレートを削除する。"""
    delete_template(questionnaire_id, visit_type)
    return {"status": "ok"}


@app.post("/questionnaires/{questionnaire_id}/duplicate")
def duplicate_questionnaire(questionnaire_id: str, payload: QuestionnaireDuplicate) -> dict:
    """既存テンプレートを別IDで複製する。"""
    # 新IDが既に存在する場合はエラー
    if any(t["id"] == payload.new_id for t in list_templates()):
        raise HTTPException(status_code=400, detail="id already exists")
    for vt in ("initial", "followup"):
        tpl = db_get_template(questionnaire_id, vt)
        if tpl:
            upsert_template(
                payload.new_id,
                vt,
                tpl["items"],
                llm_followup_enabled=tpl.get("llm_followup_enabled", True),
                llm_followup_max_questions=tpl.get("llm_followup_max_questions", 5),
            )
        cfg = get_summary_config(questionnaire_id, vt)
        if cfg:
            upsert_summary_prompt(
                payload.new_id,
                vt,
                cfg.get("prompt", ""),
                cfg.get("enabled", False),
            )
    return {"status": "ok"}


@app.post("/questionnaires/{questionnaire_id}/rename")
def rename_questionnaire_api(questionnaire_id: str, payload: QuestionnaireRename) -> dict:
    """テンプレートIDを変更する。"""

    if questionnaire_id == "default":
        raise HTTPException(status_code=400, detail="default template cannot be renamed")

    new_id = payload.new_id.strip()
    if not new_id:
        raise HTTPException(status_code=400, detail="new_id is required")
    if new_id == "default":
        raise HTTPException(status_code=400, detail="default id is reserved")
    if new_id == questionnaire_id:
        raise HTTPException(status_code=400, detail="new_id must be different")

    templates = list_templates()
    if not any(t["id"] == questionnaire_id for t in templates):
        raise HTTPException(status_code=404, detail="questionnaire not found")
    if any(t["id"] == new_id for t in templates):
        raise HTTPException(status_code=400, detail="id already exists")

    try:
        rename_template(questionnaire_id, new_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="questionnaire not found") from None
    except ValueError:
        raise HTTPException(status_code=400, detail="id already exists") from None
    except Exception as exc:  # pragma: no cover - 予期せぬエラー時
        logger.error("rename_template_failed")
        raise HTTPException(status_code=500, detail="failed to rename template") from exc

    return {"status": "ok", "id": new_id}


@app.post("/questionnaires/{questionnaire_id}/reset")
def reset_questionnaire(questionnaire_id: str) -> dict:
    """指定テンプレートIDを初期状態に戻す。

    - ID が "default" の場合は組込の既定項目・プロンプトで初期化
    - それ以外は、現在の default テンプレートをソースとして項目・設定・プロンプトを複製
    """
    if questionnaire_id == "default":
        # 既定のテンプレート内容を再投入
        initial_items = make_default_initial_items()
        followup_items = make_default_followup_items()
        upsert_template(
            "default",
            "initial",
            initial_items,
            llm_followup_enabled=True,
            llm_followup_max_questions=5,
        )
        upsert_template(
            "default",
            "followup",
            followup_items,
            llm_followup_enabled=True,
            llm_followup_max_questions=5,
        )
        upsert_summary_prompt("default", "initial", DEFAULT_SUMMARY_PROMPT, False)
        upsert_summary_prompt("default", "followup", DEFAULT_SUMMARY_PROMPT, False)
        upsert_followup_prompt("default", "initial", DEFAULT_FOLLOWUP_PROMPT, False)
        upsert_followup_prompt("default", "followup", DEFAULT_FOLLOWUP_PROMPT, False)
        return {"status": "ok"}

    def _src_items(vt: str) -> tuple[list[dict[str, Any]], bool, int]:
        tpl = db_get_template("default", vt)
        if tpl:
            return tpl.get("items", []), bool(tpl.get("llm_followup_enabled", True)), int(
                tpl.get("llm_followup_max_questions", 5)
            )
        if vt == "initial":
            return make_default_initial_items(), True, 5
        return make_default_followup_items(), True, 5

    for vt in ("initial", "followup"):
        items, llm_enabled, llm_max = _src_items(vt)
        upsert_template(
            questionnaire_id,
            vt,
            items,
            llm_followup_enabled=llm_enabled,
            llm_followup_max_questions=llm_max,
        )
        # プロンプトは default の設定をコピー（無ければ既定文）
        scfg = get_summary_config("default", vt) or {"prompt": DEFAULT_SUMMARY_PROMPT, "enabled": False}
        fcfg = get_followup_config("default", vt) or {"prompt": DEFAULT_FOLLOWUP_PROMPT, "enabled": False}
        upsert_summary_prompt(
            questionnaire_id, vt, scfg.get("prompt", DEFAULT_SUMMARY_PROMPT), bool(scfg.get("enabled", False))
        )
        upsert_followup_prompt(
            questionnaire_id, vt, fcfg.get("prompt", DEFAULT_FOLLOWUP_PROMPT), bool(fcfg.get("enabled", False))
        )
    return {"status": "ok"}

@app.post("/questionnaires/default/reset")
def reset_default_template() -> dict:
    """デフォルトテンプレートを初期状態に戻す。"""
    # on_startup と同じロジックで初期テンプレートを上書き
    initial_items = make_default_initial_items()
    followup_items = make_default_followup_items()
    upsert_template(
        "default",
        "initial",
        initial_items,
        llm_followup_enabled=True,
        llm_followup_max_questions=5,
    )
    upsert_template(
        "default",
        "followup",
        followup_items,
        llm_followup_enabled=True,
        llm_followup_max_questions=5,
    )
    upsert_summary_prompt("default", "initial", DEFAULT_SUMMARY_PROMPT, False)
    upsert_summary_prompt("default", "followup", DEFAULT_SUMMARY_PROMPT, False)
    upsert_followup_prompt("default", "initial", DEFAULT_FOLLOWUP_PROMPT, False)
    upsert_followup_prompt("default", "followup", DEFAULT_FOLLOWUP_PROMPT, False)
    return {"status": "ok"}



@app.post("/admin/questionnaires/export")
def export_questionnaire_settings_api(
    payload: ExportRequest,
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> StreamingResponse:
    """問診テンプレート設定一式をエクスポートする。"""

    data = export_questionnaire_settings()
    raw_templates = data.get("templates")
    normalized_templates, image_names = _normalize_templates_for_transfer(
        raw_templates if isinstance(raw_templates, list) else []
    )
    images = _load_image_payloads(image_names)
    export_payload = {key: data[key] for key in ("templates", "summary_prompts", "followup_prompts", "default_questionnaire_id", "app_settings", "llm_settings") if key in data}
    export_payload["templates"] = normalized_templates
    export_payload["images"] = images
    app_settings = data.get("app_settings") if isinstance(data, dict) else None
    normalized_app_settings, logo_payloads = _normalize_app_settings_for_transfer(app_settings)
    export_payload["app_settings"] = normalized_app_settings
    export_payload["logo_files"] = logo_payloads
    raw_llm_settings = export_payload.get("llm_settings")
    if isinstance(raw_llm_settings, dict) and raw_llm_settings:
        export_payload["llm_settings"] = _sanitize_llm_settings_for_read(
            raw_llm_settings
        ).model_dump()
    envelope = _build_export_envelope(export_payload, "questionnaire_settings", payload.password or None)
    content = json.dumps(envelope, ensure_ascii=False, indent=2).encode("utf-8")
    filename = f"questionnaire-settings-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/json",
        headers={**SAFE_HEADERS, "Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/admin/questionnaires/import")
async def import_questionnaire_settings_api(
    file: UploadFile = File(...),
    password: str | None = Form(None),
    mode: str = Form("merge"),
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> dict[str, Any]:
    """問診テンプレート設定一式をインポートする。"""

    raw = await read_import(file)
    export_type, payload = _parse_import_envelope(raw, password or None)
    if export_type != "questionnaire_settings":
        raise HTTPException(status_code=400, detail="invalid_export_type")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid_export_payload")
    mode_value = (mode or "merge").lower()
    if mode_value not in {"merge", "replace"}:
        raise HTTPException(status_code=400, detail="invalid_mode")
    payload_data = validate_questionnaires(payload)
    images = validate_assets(payload.get("images", {}))
    logos = validate_assets(payload.get("logo_files", {}))
    if len(images) + len(logos) + sum(len(payload_data.get(k, [])) for k in ("templates", "summary_prompts", "followup_prompts")) > MAX_IMPORT_RECORDS:
        raise HTTPException(status_code=400, detail="too_many_records")
    normalized_templates, _ = _normalize_templates_for_transfer(payload_data.get("templates", []))
    payload_data["templates"] = normalized_templates
    if "llm_settings" in payload_data and payload_data["llm_settings"]:
        try:
            # Portable settings never accept credentials, even in old exports.
            safe_llm = _sanitize_llm_settings_for_read(payload_data["llm_settings"]).model_dump()
            validated_llm = LLMSettings(**sanitize_llm_settings_for_storage(safe_llm))
            validated_llm.sync_from_active_profile()
            if validated_llm.enabled:
                from .llm_data_security import validate_profile_destination
                validate_profile_destination(validated_llm.provider, validated_llm.get_profile().model_dump())
            payload_data["llm_settings"] = validated_llm.model_dump()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid_llm_settings") from None
    stats = atomic_import("questionnaire_settings", payload_data, mode=mode_value, images=images, logos=logos)
    # No automatic model call, history resend, or separate asset/settings write.
    return {"status": "ok", "imported": stats, "images_restored": len(images),
            "logos_restored": len(logos), "mode": mode_value}



def _migrate_legacy_assets() -> None:
    """ファイルシステムに残っている旧画像を DB へ移行する。"""
    migrated = 0
    try:
        if IMAGE_DIR.exists():
            for path in IMAGE_DIR.glob("*"):
                if not path.is_file() or path.is_symlink():
                    continue
                try:
                    asset_id = _sanitize_image_filename(path.name)
                except ValueError:
                    continue
                if load_binary_asset(QUESTIONNAIRE_IMAGE_CATEGORY, asset_id):
                    continue
                try:
                    with path.open("rb") as source:
                        data, media_type, _ = clean_raster(source.read(MAX_ASSET_BYTES + 1))
                except HTTPException:
                    continue
                save_binary_asset(
                    QUESTIONNAIRE_IMAGE_CATEGORY,
                    data,
                    asset_id,
                    content_type=media_type,
                    asset_id=asset_id,
                )
                migrated += 1
        if LOGO_DIR.exists():
            for path in LOGO_DIR.glob("*"):
                if not path.is_file() or path.is_symlink():
                    continue
                try:
                    asset_id = _sanitize_image_filename(path.name)
                except ValueError:
                    continue
                if load_binary_asset(SYSTEM_LOGO_CATEGORY, asset_id):
                    continue
                try:
                    with path.open("rb") as source:
                        data, media_type, _ = clean_raster(source.read(MAX_ASSET_BYTES + 1))
                except HTTPException:
                    continue
                save_binary_asset(
                    SYSTEM_LOGO_CATEGORY,
                    data,
                    asset_id,
                    content_type=media_type,
                    asset_id=asset_id,
                )
                migrated += 1
        if migrated:
            logger.info("legacy_asset_migration_completed count=%d", migrated)
    except Exception:
        logger.error("legacy_asset_migration_failed")
@app.post("/questionnaire-item-images")
def upload_questionnaire_item_image(file: UploadFile = File(...)) -> dict:
    """問診項目に添付する画像をアップロードし、URL を返す。"""
    data, media_type, suffix = clean_raster(file.file.read(MAX_ASSET_BYTES + 1))
    sanitized = f"{uuid4().hex}{suffix}"
    save_binary_asset(QUESTIONNAIRE_IMAGE_CATEGORY, data, sanitized,
                      content_type=media_type, asset_id=sanitized)
    return {"url": f"/{IMAGE_STORAGE_SEGMENT}{sanitized}"}


@app.delete("/questionnaire-item-images/{filename}")
def delete_questionnaire_item_image(filename: str) -> dict:
    """アップロード済みの問診項目画像を削除する。"""
    if not filename or not IMAGE_FILENAME_PATTERN.fullmatch(filename):
        return {"status": "ok"}
    delete_binary_asset(QUESTIONNAIRE_IMAGE_CATEGORY, filename)
    return {"status": "ok"}

@app.get("/questionnaires/{questionnaire_id}/summary-prompt")
def get_summary_prompt_api(questionnaire_id: str, visit_type: str) -> dict:
    """テンプレート/受診種別ごとのサマリー生成プロンプトを取得する。"""
    cfg = get_summary_config(questionnaire_id, visit_type)
    if cfg is None:
        cfg = {
            "prompt": DEFAULT_SUMMARY_PROMPT,
            "enabled": False,
        }
    return {
        "id": questionnaire_id,
        "visit_type": visit_type,
        "prompt": cfg.get("prompt", ""),
        "enabled": bool(cfg.get("enabled", False)),
    }


@app.post("/questionnaires/{questionnaire_id}/summary-prompt")
def upsert_summary_prompt_api(questionnaire_id: str, payload: SummaryPromptUpsert) -> dict:
    """テンプレート/受診種別ごとのサマリープロンプトを保存する。"""
    upsert_summary_prompt(questionnaire_id, payload.visit_type, payload.prompt, payload.enabled)
    return {"status": "ok"}


@app.get("/questionnaires/{questionnaire_id}/followup-prompt")
def get_followup_prompt_api(questionnaire_id: str, visit_type: str) -> dict:
    """テンプレート/受診種別ごとの追加質問生成プロンプトを取得する。"""
    cfg = get_followup_config(questionnaire_id, visit_type)
    if cfg is None:
        cfg = {"prompt": DEFAULT_FOLLOWUP_PROMPT, "enabled": False}
    return {
        "id": questionnaire_id,
        "visit_type": visit_type,
        "prompt": cfg.get("prompt", ""),
        "enabled": bool(cfg.get("enabled", False)),
    }


@app.post("/questionnaires/{questionnaire_id}/followup-prompt")
def upsert_followup_prompt_api(questionnaire_id: str, payload: FollowupPromptUpsert) -> dict:
    """テンプレート/受診種別ごとの追加質問プロンプトを保存する。"""
    upsert_followup_prompt(
        questionnaire_id, payload.visit_type, payload.prompt, payload.enabled
    )
    return {"status": "ok"}


class ChatRequest(BaseModel):
    """チャットリクエスト。"""

    message: str


class ChatResponse(BaseModel):
    """チャット応答。"""

    reply: str


@app.post("/llm/chat", response_model=ChatResponse)
def llm_chat(
    req: ChatRequest,
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> ChatResponse:
    """LLM との対話を行う。"""

    global METRIC_LLM_CHATS
    METRIC_LLM_CHATS += 1
    return ChatResponse(reply=llm_gateway.chat(req.message))


@app.get("/llm/providers", response_model=list[ProviderMetaSchema])
def list_llm_providers(
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> list[ProviderMetaSchema]:
    """利用可能な LLM プロバイダの一覧を返す。"""

    safe_meta: list[ProviderMetaSchema] = []
    for meta in get_provider_meta_list():
        raw = meta.model_dump()
        default_profile = raw.get("default_profile") or {}
        allowed_default_fields = {
            "model",
            "temperature",
            "system_prompt",
            "base_url",
            "followup_timeout_seconds",
        } | {
            field.key for field in meta.extra_fields if not field.sensitive
        }
        raw["default_profile"] = {
            key: value
            for key, value in default_profile.items()
            if key in allowed_default_fields
        }
        safe_meta.append(ProviderMetaSchema(**raw))
    return safe_meta


class LLMSettingsUpdate(LLMSettings):
    """管理者が更新できるLLM設定。"""


class LLMSettingsRead(BaseModel):
    """秘密情報を含まない管理者向けLLM設定。"""

    provider: str
    model: str
    temperature: float
    system_prompt: str = ""
    enabled: bool
    base_url: str | None = None
    followup_timeout_seconds: float
    api_key_configured: bool = False
    provider_profiles: dict[str, dict[str, Any]] = Field(default_factory=dict)


def _safe_provider_extra_fields() -> dict[str, set[str]]:
    safe_fields: dict[str, set[str]] = {}
    for provider, registration in get_provider_registry().items():
        safe_fields[provider] = {
            field.key
            for field in registration.meta.extra_fields
            if not field.sensitive
        }
    return safe_fields


def _sanitize_llm_settings_for_read(value: dict[str, Any]) -> LLMSettingsRead:
    safe = sanitize_llm_settings_for_read(
        value,
        safe_extra_fields=_safe_provider_extra_fields(),
    )
    return LLMSettingsRead(**safe)


def _merge_preserved_api_keys(settings: LLMSettingsUpdate) -> LLMSettings:
    """読み取り応答に含めないAPI keyを未入力の更新で消さない。"""

    incoming = sanitize_llm_settings_for_storage(settings.model_dump())
    current = sanitize_llm_settings_for_storage(llm_gateway.settings.model_dump())

    incoming_profiles = incoming.get("provider_profiles")
    current_profiles = current.get("provider_profiles")
    if isinstance(incoming_profiles, dict) and isinstance(current_profiles, dict):
        for provider, current_profile in current_profiles.items():
            incoming_profile = incoming_profiles.get(provider)
            if not isinstance(incoming_profile, dict) or not isinstance(
                current_profile, dict
            ):
                continue
            if not incoming_profile.get("api_key") and current_profile.get("api_key"):
                incoming_profile["api_key"] = current_profile["api_key"]

    # トップレベルのkeyは現在選択中のprofileとだけ同期する。
    # provider切替時に、別providerのkeyを混入させない。
    active_provider = str(incoming.get("provider") or "")
    active_profile = (
        incoming_profiles.get(active_provider)
        if isinstance(incoming_profiles, dict)
        else None
    )
    if not incoming.get("api_key") and isinstance(active_profile, dict):
        incoming["api_key"] = active_profile.get("api_key")
    return LLMSettings(**incoming)


@app.get("/llm/settings", response_model=LLMSettingsRead)
def get_llm_settings(
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> LLMSettingsRead:
    """現在の LLM 設定を取得する。

    原則としてDBに永続化された値を優先し、存在しない場合はメモリ上の設定を返す。
    これによりプロセス再起動後や他所での変更がUIに確実に反映される。
    """

    try:
        stored = load_llm_settings()
        if stored:
            # DB 側が真ならメモリへも反映して返す
            s = LLMSettings(**sanitize_llm_settings_for_storage(stored))
            llm_gateway.update_settings(s)
            llm_gateway.settings.sync_from_active_profile()
            return _sanitize_llm_settings_for_read(
                llm_gateway.settings.model_dump()
            )
    except Exception:
        logger.error("failed_to_load_llm_settings_on_get")
    llm_gateway.settings.sync_from_active_profile()
    return _sanitize_llm_settings_for_read(llm_gateway.settings.model_dump())


@app.put("/llm/settings", response_model=LLMSettingsRead)
def update_llm_settings(
    submitted: LLMSettingsUpdate,
    background: BackgroundTasks,
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> LLMSettingsRead:
    """LLM 設定だけを更新する。既存患者記録の再送は行わない。"""
    settings = _merge_preserved_api_keys(submitted)
    # バリデーション: LLM を使用する場合はモデル名が必須
    if settings.enabled and (not settings.model or not str(settings.model).strip()):
        raise HTTPException(status_code=400, detail="LLM有効時はモデル名が必須です")

    settings.sync_to_active_profile()
    try:
        llm_gateway.update_settings(settings)
    except ValueError:
        raise HTTPException(status_code=400, detail="llm_destination_not_allowed") from None
    try:
        # DB にも保存（永続化）
        save_llm_settings(
            sanitize_llm_settings_for_storage(settings.model_dump())
        )
    except Exception:
        logger.error("failed_to_persist_llm_settings")
        raise HTTPException(status_code=503, detail="llm_settings_save_failed") from None

    # Saving settings must not resend previously collected patient records.
    llm_gateway.settings.sync_from_active_profile()
    return _sanitize_llm_settings_for_read(llm_gateway.settings.model_dump())


def build_markdown_lines(s: dict, rows: list[tuple[str, str]], vt_label: str) -> list[str]:
    """セッション情報からMarkdown形式の行リストを生成する。"""

    def _gender_label(raw: str | None) -> str:
        if not raw:
            return "未設定"
        mapping = {"male": "男性", "female": "女性", "other": "その他"}
        return mapping.get(str(raw).lower(), str(raw))

    def _yesno_display(value: Any) -> str | None:
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"yes", "no"}:
                return "はい" if lowered == "yes" else "いいえ"
        if isinstance(value, bool):
            return "はい" if value else "いいえ"
        return None

    patient_name = s.get("patient_name") or "未設定"
    dob = s.get("dob") or "未設定"
    gender = _gender_label(s.get("gender"))
    answers = s.get("answers", {}) or {}
    personal_info_value: Any = None
    for key in ("personal_info", "personalInfo", "patient_basic_info"):
        if key in answers and answers[key]:
            personal_info_value = answers[key]
            break
    personal_info_lines = format_personal_info_lines(
        personal_info_value,
        skip_keys={"name"},
        hide_empty=(s.get("visit_type") != "initial"),
    )

    lines = [
        "# 問診結果",
        "",
        "## 患者情報",
        f"- 患者名: {patient_name}",
    ]
    kana_line = next((line for line in personal_info_lines if line.startswith("よみがな:")), None)
    if kana_line:
        lines.append(f"- {kana_line}")
    lines.extend(
        [
            f"- 生年月日: {dob}",
            f"- 性別: {gender}",
            f"- 受診種別: {vt_label}",
        ]
    )
    for line in personal_info_lines:
        if line == kana_line:
            continue
        lines.append(f"- {line}")
    lines.append(f"- テンプレートID: {s['questionnaire_id']}")
    lines.append("")
    lines.append("## 回答")

    personal_info_labels = {
        "personal_info",
        "personalInfo",
        "patient_basic_info",
        "患者基本情報",
        "患者基本情報セット",
    }
    for label, ans in rows:
        if label in personal_info_labels:
            continue
        display = ans or "未回答"
        yesno_display = _yesno_display(display) if isinstance(display, str) else None
        lines.append(f"- {label}: {yesno_display or display}")

    summary = s.get("summary")
    if summary:
        lines.append("")
        lines.append("## 自動生成サマリー")
        lines.extend(str(summary).splitlines())
    return lines


DATE_FORMATS = [
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%Y.%m.%d",
    "%Y年%m月%d日",
    "%Y %m %d",
]

ERA_YEAR_PATTERN = re.compile(
    r"(令和|reiwa|R|平成|heisei|H|昭和|showa|S|大正|taisho|T|明治|meiji|M)\s*(元|\d{1,2})",
    re.IGNORECASE,
)
ERA_BASE_YEARS: dict[str, int] = {
    "令和": 2018,
    "reiwa": 2018,
    "r": 2018,
    "平成": 1988,
    "heisei": 1988,
    "h": 1988,
    "昭和": 1925,
    "showa": 1925,
    "s": 1925,
    "大正": 1911,
    "taisho": 1911,
    "t": 1911,
    "明治": 1867,
    "meiji": 1867,
    "m": 1867,
}


def _try_parse_iso_date(value: str) -> str | None:
    trimmed = value.strip()
    if not trimmed:
        return None
    normalized_values = [trimmed, trimmed.replace(" ", "")]
    for candidate in normalized_values:
        for fmt in DATE_FORMATS:
            try:
                dt = datetime.strptime(candidate, fmt)
                return dt.strftime("%Y-%m-%d")
            except ValueError:
                continue
    digits_only = re.sub(r"\D", "", trimmed)
    if len(digits_only) == 8:
        try:
            year = int(digits_only[0:4])
            month = int(digits_only[4:6])
            day = int(digits_only[6:8])
            dt = datetime(year, month, day)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            return None
    era_candidate = _try_parse_japanese_era_date(trimmed)
    if era_candidate:
        year, month, day = era_candidate
        try:
            dt = datetime(year, month, day)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            return None
    return None


def _try_parse_japanese_era_date(value: str) -> tuple[int, int, int] | None:
    match = ERA_YEAR_PATTERN.search(value)
    if not match:
        return None
    era_key = match.group(1)
    year_token = match.group(2)
    base = ERA_BASE_YEARS.get(era_key.lower()) or ERA_BASE_YEARS.get(era_key)  # type: ignore[arg-type]
    if base is None:
        return None
    if year_token == "元":
        year_number = 1
    else:
        try:
            year_number = int(year_token)
        except ValueError:
            return None
    year = base + year_number
    remainder = value[match.end():]
    month_day = _extract_month_day_from_text(remainder)
    if not month_day:
        return None
    return year, month_day[0], month_day[1]


def _extract_month_day_from_text(text: str) -> tuple[int, int] | None:
    if not text:
        return None
    month_match = re.search(r"(\d{1,2})月", text)
    day_match = re.search(r"(\d{1,2})日", text)
    if month_match and day_match:
        try:
            month = int(month_match.group(1))
            day = int(day_match.group(1))
        except ValueError:
            return None
        if 1 <= month <= 12 and 1 <= day <= 31:
            return month, day
    pair = re.search(r"(\d{1,2})\D+(\d{1,2})", text)
    if pair:
        try:
            month = int(pair.group(1))
            day = int(pair.group(2))
        except ValueError:
            return None
        if 1 <= month <= 12 and 1 <= day <= 31:
            return month, day
    digits = re.findall(r"(\d{1,2})", text)
    if len(digits) >= 2:
        try:
            month = int(digits[0])
            day = int(digits[1])
        except ValueError:
            return None
        if 1 <= month <= 12 and 1 <= day <= 31:
            return month, day
    return None


def _normalize_dob_variants(value: str | None) -> set[str]:
    if not value:
        return set()
    trimmed = value.strip()
    if not trimmed:
        return set()
    variants: set[str] = {trimmed}
    iso = _try_parse_iso_date(trimmed)
    if iso:
        variants.add(iso)
    return variants


def _normalize_patient_name_for_identity(value: str | None) -> str:
    """氏名照合用に表記幅と空白だけを正規化する。部分一致は行わない。"""

    if not value:
        return ""
    normalized = unicodedata.normalize("NFKC", value)
    return "".join(character for character in normalized if not character.isspace())


def _hash_patient_summary_api_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _is_patient_summary_api_key_valid(provided: str | None) -> bool:
    if not provided:
        return False
    environment_key = os.getenv("PATIENT_SUMMARY_API_KEY", "").strip()
    if environment_key:
        return secrets.compare_digest(provided.strip(), environment_key)
    stored = load_app_settings() or {}
    stored_hash = stored.get("patient_summary_api_key_hash")
    if not stored_hash:
        return False
    candidate = _hash_patient_summary_api_key(provided.strip())
    return secrets.compare_digest(candidate, stored_hash)


PATIENT_SUMMARY_RATE_LIMIT = 30
PATIENT_SUMMARY_RATE_WINDOW_SECONDS = 60


def _patient_summary_rate_allowed(request: Request) -> bool:
    source = request.client.host if request.client else "unknown"
    try:
        rate_limit("integration:ip:" + source, PATIENT_SUMMARY_RATE_LIMIT, PATIENT_SUMMARY_RATE_WINDOW_SECONDS)
        rate_limit("integration:global", 300)
    except HTTPException as exc:
        if exc.status_code == 429:
            return False
        raise
    return True


def _find_latest_finalized_session(patient_name: str, dob: str) -> dict[str, Any] | None:
    normalized_dob_variants = _normalize_dob_variants(dob)
    if not normalized_dob_variants:
        return None
    normalized_name = _normalize_patient_name_for_identity(patient_name)
    if not normalized_name:
        return None
    summaries_by_id: dict[str, dict[str, Any]] = {}
    for dob_variant in sorted(normalized_dob_variants):
        # SQLite/CouchDB 側の氏名検索は NFKC 正規化を保証しない。
        # 生年月日で候補を絞り、氏名の完全一致はこの関数で判定する。
        for summary in db_list_sessions(dob=dob_variant):
            summary_id = summary.get("id")
            if isinstance(summary_id, str):
                summaries_by_id[summary_id] = summary
    summaries = sorted(
        summaries_by_id.values(),
        key=lambda item: (item.get("started_at") or "", item.get("finalized_at") or ""),
        reverse=True,
    )
    for summary in summaries:
        session = db_get_session(summary.get("id"))
        if not session:
            continue
        if (session.get("completion_status") or "") != "finalized":
            continue
        if _normalize_patient_name_for_identity(session.get("patient_name")) != normalized_name:
            continue
        stored_dob_variants = _normalize_dob_variants(session.get("dob"))
        if normalized_dob_variants & stored_dob_variants:
            return session
    return None


def _visit_type_label(visit_type: str | None) -> str:
    if visit_type == "initial":
        return "初診"
    if visit_type == "followup":
        return "再診"
    return str(visit_type or "不明")


def build_session_rows_and_items(s: dict) -> tuple[list[tuple[str, str]], str, list[QuestionnaireItem]]:
    """PDF/Markdown出力用に回答行とテンプレ項目を収集する。"""

    visit_type = s.get("visit_type")
    tpl = db_get_template(s.get("questionnaire_id"), visit_type) or {}
    items: list[QuestionnaireItem] = []
    try:
        raw_items = tpl.get("items") if isinstance(tpl, dict) else None
        if raw_items:
            items = [QuestionnaireItem(**it) for it in raw_items]
        else:
            default_items = (
                make_default_initial_items()
                if visit_type == "initial"
                else make_default_followup_items()
            )
            items = [QuestionnaireItem(**it) for it in default_items]
    except Exception:
        items = []

    answers = s.get("answers", {}) or {}
    question_texts = {}
    raw_qtexts = s.get("question_texts") or {}
    if isinstance(raw_qtexts, dict):
        question_texts = {str(k): v for k, v in raw_qtexts.items() if isinstance(v, str)}

    personal_info_keys = {"personal_info", "personalInfo", "patient_basic_info"}

    def fmt_yesno(ans: Any) -> str | None:
        if isinstance(ans, str):
            lowered = ans.strip().lower()
            if lowered in {"yes", "no"}:
                return "はい" if lowered == "yes" else "いいえ"
        if isinstance(ans, bool):
            return "はい" if ans else "いいえ"
        return None

    def fmt_answer(ans: Any, item_type: str | None = None) -> str:
        if ans is None or ans == "":
            return ""
        yesno_display = fmt_yesno(ans) if item_type == "yesno" else None
        if yesno_display is not None:
            return yesno_display
        if isinstance(ans, list):
            return ", ".join(
                fmt_yesno(v) or str(v) for v in ans
            )
        if isinstance(ans, dict):
            return json.dumps(ans, ensure_ascii=False)
        yesno_display = fmt_yesno(ans)
        if yesno_display is not None:
            return yesno_display
        return str(ans)

    rows: list[tuple[str, str]] = []
    appended_ids: set[str] = set()
    for item in items:
        try:
            item_id = str(item.id)
            label = question_texts.get(item_id) or item.label
            answer_value = answers.get(item_id)
            item_type = getattr(item, "type", None)
            if item_type == "personal_info":
                display_answer = format_personal_info_multiline(answer_value)
            else:
                display_answer = fmt_answer(answer_value, item_type)
            rows.append((label, display_answer))
            appended_ids.add(item_id)
        except Exception:
            continue
    llm_qtexts = s.get("llm_question_texts") or {}
    if isinstance(llm_qtexts, dict):
        for iid, qtext in llm_qtexts.items():
            key = str(iid)
            label = question_texts.get(key) or str(qtext)
            rows.append((label, fmt_answer(answers.get(key))))
            appended_ids.add(key)
    # テンプレートに存在しないが回答が残っている項目も出力に含める
    for iid in sorted({str(k) for k in answers.keys()}):
        if iid in appended_ids:
            continue
        label = question_texts.get(iid) or iid
        if iid in personal_info_keys:
            rows.append(("患者基本情報", format_personal_info_multiline(answers.get(iid))))
            appended_ids.add(iid)
            continue
        rows.append((label, fmt_answer(answers.get(iid))))
        appended_ids.add(iid)

    vt_label = _visit_type_label(visit_type)
    return rows, vt_label, items


def _resolve_pdf_render_config() -> tuple[PDFLayoutMode, str]:
    """PDF生成に利用するレイアウト設定と施設名を取得する。"""

    stored = load_app_settings() or {}
    mode_raw = stored.get("pdf_layout_mode") or PDFLayoutMode.STRUCTURED.value
    try:
        layout_mode = PDFLayoutMode(mode_raw)
    except ValueError:
        layout_mode = PDFLayoutMode.STRUCTURED
    facility = stored.get("display_name") or "問診メイト"
    return layout_mode, facility


def _apply_provider_profile_payload(
    settings: LLMSettings, payload: dict[str, Any] | None
) -> None:
    """一時設定にプロバイダ単位の入力値を反映する。"""

    if not payload:
        return
    existing: dict[str, ProviderProfile] = dict(settings.provider_profiles or {})
    changed = False
    for key, raw in payload.items():
        if isinstance(raw, ProviderProfile):
            existing[key] = raw
            changed = True
            continue
        if not isinstance(raw, dict):
            logger.warning("llm_temp_settings_invalid_profile")
            continue
        try:
            existing[key] = ProviderProfile(**raw)
        except Exception as exc:  # noqa: BLE001 - バリデーション失敗のみ
            logger.warning("llm_temp_settings_profile_parse_failed")
            continue
        changed = True
    if not changed:
        return
    settings.provider_profiles = existing
    try:
        settings.sync_from_active_profile()
    except Exception as exc:  # noqa: BLE001 - 一時設定の同期は警告に留める
        logger.warning("llm_temp_settings_sync_failed")


class LLMTestRequest(BaseModel):
    """LLM疎通テスト用の一時設定。"""

    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    enabled: bool | None = None
    provider_profiles: dict[str, dict[str, Any]] | None = None


@app.post("/llm/settings/test")
def test_llm_connection(
    req: LLMTestRequest | None = None,
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> dict[str, str]:
    """現在の設定または指定された設定でLLM疎通テストを実行する。"""

    if req:
        current = llm_gateway.settings
        temp = LLMSettings(
            provider=req.provider or current.provider,
            model=req.model or current.model,
            temperature=current.temperature,
            system_prompt=current.system_prompt,
            enabled=req.enabled if req.enabled is not None else current.enabled,
            base_url=req.base_url or current.base_url,
            api_key=req.api_key or current.api_key,
            followup_timeout_seconds=current.followup_timeout_seconds,
        )
        current_profiles = getattr(current, "provider_profiles", None) or {}
        if current_profiles:
            temp.provider_profiles = {
                key: (profile.copy(deep=True) if isinstance(profile, ProviderProfile) else ProviderProfile(**profile))
                for key, profile in current_profiles.items()
            }
        _apply_provider_profile_payload(
            temp, sanitize_llm_settings_for_storage(req.provider_profiles)
        )
        gateway = LLMGateway(temp)
        return gateway.test_connection()
    return llm_gateway.test_connection(source="manual_test")

class ListModelsRequest(BaseModel):
    """モデル一覧取得リクエスト。"""

    provider: str
    base_url: str | None = None
    api_key: str | None = None
    provider_profiles: dict[str, dict[str, Any]] | None = None


@app.post("/llm/list-models")
def list_llm_models(
    req: ListModelsRequest,
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> list[str]:
    """指定された設定で利用可能なLLMモデルの一覧を返す。"""
    # リクエストから一時的な設定でゲートウェイを作成
    temp_settings = LLMSettings(
        provider=req.provider,
        base_url=req.base_url,
        api_key=req.api_key,
        # 他のフィールドは list_models では使われないのでダミー値
        model="",
        temperature=0,
        enabled=True,  # 有効化しないと空リストが返る
    )
    _apply_provider_profile_payload(
        temp_settings, sanitize_llm_settings_for_storage(req.provider_profiles)
    )
    gateway = LLMGateway(temp_settings)
    return gateway.list_models()


# --- システム表示名・設定 API ---
class TimezoneSettings(BaseModel):
    """システム全体の時間帯設定。"""

    timezone: str


DEFAULT_TIMEZONE = "Asia/Tokyo"


class DisplayNameSettings(BaseModel):
    display_name: str

class CompletionMessageSettings(BaseModel):
    """完了画面に表示する文言の設定。"""
    message: str

class DefaultQuestionnaireSettings(BaseModel):
    """デフォルト問診テンプレートの設定。"""
    questionnaire_id: str


class PatientSummaryApiKeyPayload(BaseModel):
    api_key: str | None = None


class PatientSummaryApiInfo(BaseModel):
    endpoint: str
    header_name: str
    is_enabled: bool
    last_updated_at: str | None = None

class ThemeColorSettings(BaseModel):
    """UIのテーマカラー設定。"""
    color: str


class PDFLayoutSettings(BaseModel):
    """PDFレイアウト切り替え設定。"""

    mode: PDFLayoutMode


class LogoCrop(BaseModel):
    x: float
    y: float
    w: float
    h: float


class LogoSettings(BaseModel):
    url: str | None = None
    crop: LogoCrop | None = None


class SystemBootstrapSettings(BaseModel):
    """初回描画に必要な公開設定を1回で返す。"""

    timezone: str
    display_name: str
    completion_message: str
    entry_message: str
    theme_color: str
    logo: LogoSettings
    default_questionnaire_id: str


class PostalCodeCandidate(BaseModel):
    postal_code: str
    prefecture: str
    city: str
    town: str
    address: str


class PostalCodeLookupResponse(BaseModel):
    postal_code: str
    found: bool
    address: str | None = None
    candidates: list[PostalCodeCandidate] = Field(default_factory=list)


class PostalCodeDictionaryInfo(BaseModel):
    is_available: bool
    row_count: int
    source_filename: str | None = None
    last_updated_at: str | None = None


@app.get("/postal-code/{postal_code}", response_model=PostalCodeLookupResponse)
def get_postal_code_address(postal_code: str) -> PostalCodeLookupResponse:
    """郵便番号から住所候補を返す。未登録時は found=false として手入力へフォールバックする。"""

    return PostalCodeLookupResponse(**lookup_postal_code(postal_code))


@app.get("/system/postal-code-dictionary", response_model=PostalCodeDictionaryInfo)
def get_system_postal_code_dictionary() -> PostalCodeDictionaryInfo:
    """郵便番号辞書の状態を返す。初回は同梱 CSV から辞書 DB を作成する。"""

    return PostalCodeDictionaryInfo(**get_postal_dictionary_info())


@app.post("/system/postal-code-dictionary", response_model=PostalCodeDictionaryInfo)
def upload_system_postal_code_dictionary(file: UploadFile = File(...)) -> PostalCodeDictionaryInfo:
    """管理画面からアップロードされた郵便番号 CSV で辞書 DB を更新する。"""

    filename = Path(file.filename or "").name or "postal_codes.csv"
    try:
        return PostalCodeDictionaryInfo(**import_postal_csv(file.file, filename))
    except PostalCodeImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("postal_code_dictionary_upload_failed")
        raise HTTPException(status_code=500, detail="postal_code_dictionary_upload_failed") from exc


@app.get("/system/timezone", response_model=TimezoneSettings)
def get_system_timezone() -> TimezoneSettings:
    """システム全体で利用する時間帯を返す。未設定時は JST。"""

    try:
        stored = load_app_settings() or {}
        tz = stored.get("timezone") or DEFAULT_TIMEZONE
        # 不正な値が保存されていた場合もデフォルトにフォールバック
        try:
            ZoneInfo(tz)
        except ZoneInfoNotFoundError:
            tz = DEFAULT_TIMEZONE
        return TimezoneSettings(timezone=tz)
    except Exception:
        logger.error("get_timezone_failed")
        return TimezoneSettings(timezone=DEFAULT_TIMEZONE)


@app.put("/system/timezone", response_model=TimezoneSettings)
def set_system_timezone(payload: TimezoneSettings) -> TimezoneSettings:
    """システム全体で利用する時間帯を保存する。"""

    timezone_value = payload.timezone or DEFAULT_TIMEZONE
    try:
        ZoneInfo(timezone_value)
    except ZoneInfoNotFoundError:
        raise HTTPException(status_code=400, detail="invalid_timezone")
    except Exception as exc:
        logger.error("validate_timezone_failed")
        raise HTTPException(status_code=500, detail="timezone_validation_failed") from exc

    try:
        current = load_app_settings() or {}
        current["timezone"] = timezone_value
        save_app_settings(current)
        return TimezoneSettings(timezone=current["timezone"])
    except Exception as exc:
        logger.error("set_timezone_failed")
        raise HTTPException(status_code=500, detail="save_timezone_failed") from exc


@app.get("/system/display-name", response_model=DisplayNameSettings)
def get_display_name() -> DisplayNameSettings:
    """システムの表示名（ヘッダーに出す名称）を返す。未設定時は既定値。"""
    DEFAULT = "問診メイト"
    try:
        stored = load_app_settings() or {}
        name = stored.get("display_name") or DEFAULT
        return DisplayNameSettings(display_name=name)
    except Exception:
        logger.error("get_display_name_failed")
        return DisplayNameSettings(display_name=DEFAULT)


@app.put("/system/display-name", response_model=DisplayNameSettings)
def set_display_name(payload: DisplayNameSettings) -> DisplayNameSettings:
    """システムの表示名を保存する。"""
    try:
        current = load_app_settings() or {}
        current["display_name"] = payload.display_name or "問診メイト"
        save_app_settings(current)
        return DisplayNameSettings(display_name=current["display_name"])
    except Exception:
        logger.error("set_display_name_failed")
        return payload


@app.get("/system/completion-message", response_model=CompletionMessageSettings)
def get_completion_message() -> CompletionMessageSettings:
    """完了画面に表示する文言を返す。未設定時は既定値。"""
    DEFAULT = "ご回答ありがとうございました。"
    try:
        stored = load_app_settings() or {}
        msg = stored.get("completion_message") or DEFAULT
        return CompletionMessageSettings(message=msg)
    except Exception:
        logger.error("get_completion_message_failed")
        return CompletionMessageSettings(message=DEFAULT)


@app.put("/system/completion-message", response_model=CompletionMessageSettings)
def set_completion_message(payload: CompletionMessageSettings) -> CompletionMessageSettings:
    """完了画面に表示する文言を保存する。"""
    try:
        current = load_app_settings() or {}
        current["completion_message"] = payload.message or "ご回答ありがとうございました。"
        save_app_settings(current)
        return CompletionMessageSettings(message=current["completion_message"])
    except Exception:
        logger.error("set_completion_message_failed")
        return payload

class EntryMessageSettings(BaseModel):
    message: str

@app.get("/system/entry-message", response_model=EntryMessageSettings)
def get_entry_message() -> EntryMessageSettings:
    """エントリ画面に表示する文言を返す。未設定時は既定値。"""
    DEFAULT = "不明点があれば受付にお知らせください"
    try:
        stored = load_app_settings() or {}
        msg = stored.get("entry_message") or DEFAULT
        return EntryMessageSettings(message=msg)
    except Exception:
        logger.error("get_entry_message_failed")
        return EntryMessageSettings(message=DEFAULT)

@app.put("/system/entry-message", response_model=EntryMessageSettings)
def set_entry_message(payload: EntryMessageSettings) -> EntryMessageSettings:
    """エントリ画面に表示する文言を保存する。"""
    try:
        current = load_app_settings() or {}
        current["entry_message"] = payload.message or "不明点があれば受付にお知らせください"
        save_app_settings(current)
        return EntryMessageSettings(message=current["entry_message"])
    except Exception:
        logger.error("set_entry_message_failed")
        return payload

@app.get("/system/theme-color", response_model=ThemeColorSettings)
def get_theme_color() -> ThemeColorSettings:
    """UIのテーマカラーを返す。未設定時は既定値。"""
    DEFAULT = "#1e88e5"
    try:
        stored = load_app_settings() or {}
        color = stored.get("theme_color") or DEFAULT
        return ThemeColorSettings(color=color)
    except Exception:
        logger.error("get_theme_color_failed")
        return ThemeColorSettings(color=DEFAULT)

@app.put("/system/theme-color", response_model=ThemeColorSettings)
def set_theme_color(payload: ThemeColorSettings) -> ThemeColorSettings:
    """UIのテーマカラーを保存する。"""
    try:
        current = load_app_settings() or {}
        current["theme_color"] = payload.color or "#1e88e5"
        save_app_settings(current)
        return ThemeColorSettings(color=current["theme_color"])
    except Exception:
        logger.error("set_theme_color_failed")
        return payload


@app.get("/system/logo", response_model=LogoSettings)
def get_system_logo() -> LogoSettings:
    """ロゴ/アイコン設定を返す。"""
    try:
        stored = load_app_settings() or {}
        url = stored.get("logo_url")
        crop_raw = stored.get("logo_crop")
        crop = None
        if isinstance(crop_raw, dict):
            try:
                crop = LogoCrop(**crop_raw)
            except Exception:
                crop = None
        return LogoSettings(url=url, crop=crop)
    except Exception:
        logger.error("get_system_logo_failed")
        return LogoSettings(url=None, crop=None)


@app.get("/system/bootstrap", response_model=SystemBootstrapSettings)
def get_system_bootstrap() -> SystemBootstrapSettings:
    """画面初期化用の公開設定を、永続層1読取でまとめて返す。"""

    try:
        stored = load_app_settings() or {}
    except Exception:
        logger.error("get_system_bootstrap_failed")
        stored = {}

    timezone_value = str(stored.get("timezone") or DEFAULT_TIMEZONE)
    try:
        ZoneInfo(timezone_value)
    except (ZoneInfoNotFoundError, ValueError):
        timezone_value = DEFAULT_TIMEZONE

    crop = None
    crop_raw = stored.get("logo_crop")
    if isinstance(crop_raw, dict):
        try:
            crop = LogoCrop(**crop_raw)
        except Exception:
            crop = None

    logo_url = stored.get("logo_url")
    return SystemBootstrapSettings(
        timezone=timezone_value,
        display_name=str(stored.get("display_name") or "問診メイト"),
        completion_message=str(stored.get("completion_message") or "ご回答ありがとうございました。"),
        entry_message=str(stored.get("entry_message") or "不明点があれば受付にお知らせください"),
        theme_color=str(stored.get("theme_color") or "#1e88e5"),
        logo=LogoSettings(url=str(logo_url) if logo_url else None, crop=crop),
        default_questionnaire_id=str(stored.get("default_questionnaire_id") or "default"),
    )


@app.put("/system/logo", response_model=LogoSettings)
def set_system_logo(payload: LogoSettings) -> LogoSettings:
    """ロゴのURLおよびクロップ設定を保存する。どちらか一方のみの更新も許可。"""
    try:
        current = load_app_settings() or {}
        if payload.url is not None:
            current["logo_url"] = payload.url
        if payload.crop is not None:
            current["logo_crop"] = payload.crop.model_dump()
        save_app_settings(current)
        out = LogoSettings(
            url=current.get("logo_url"),
            crop=LogoCrop(**current["logo_crop"]) if isinstance(current.get("logo_crop"), dict) else None,
        )
        return out
    except Exception:
        logger.error("set_system_logo_failed")
        return payload


@app.post("/system-logo")
def upload_system_logo(file: UploadFile = File(...)) -> dict:
    """システムロゴ画像をアップロードし、参照 URL を返す。"""
    data, media_type, suffix = clean_raster(file.file.read(MAX_ASSET_BYTES + 1))
    sanitized = f"{uuid4().hex}{suffix}"
    save_binary_asset(SYSTEM_LOGO_CATEGORY, data, sanitized,
                      content_type=media_type, asset_id=sanitized)
    return {"url": f"/{SYSTEM_LOGO_STORAGE_SEGMENT}{sanitized}"}

@app.get("/system/pdf-layout", response_model=PDFLayoutSettings)
def get_pdf_layout() -> PDFLayoutSettings:
    """PDFのレイアウトモードを返す。未設定時は構造化レイアウト。"""

    default_mode = PDFLayoutMode.STRUCTURED
    try:
        stored = load_app_settings() or {}
        raw = stored.get("pdf_layout_mode")
        mode = PDFLayoutMode(raw) if raw else default_mode
    except Exception:
        logger.error("get_pdf_layout_failed")
        mode = default_mode
    return PDFLayoutSettings(mode=mode)


@app.put("/system/pdf-layout", response_model=PDFLayoutSettings)
def set_pdf_layout(payload: PDFLayoutSettings) -> PDFLayoutSettings:
    """PDFのレイアウトモードを保存する。"""

    try:
        current = load_app_settings() or {}
        current["pdf_layout_mode"] = payload.mode.value
        save_app_settings(current)
        return PDFLayoutSettings(mode=payload.mode)
    except Exception:
        logger.error("set_pdf_layout_failed")
        return payload

@app.get("/system/default-questionnaire", response_model=DefaultQuestionnaireSettings)
def get_default_questionnaire() -> DefaultQuestionnaireSettings:
    """デフォルトの問診テンプレートIDを返す。"""
    DEFAULT = "default"
    try:
        stored = load_app_settings() or {}
        qid = stored.get("default_questionnaire_id") or DEFAULT
        return DefaultQuestionnaireSettings(questionnaire_id=qid)
    except Exception:
        logger.error("get_default_questionnaire_failed")
        return DefaultQuestionnaireSettings(questionnaire_id=DEFAULT)

@app.put("/system/default-questionnaire", response_model=DefaultQuestionnaireSettings)
def set_default_questionnaire(payload: DefaultQuestionnaireSettings) -> DefaultQuestionnaireSettings:
    """デフォルトの問診テンプレートIDを保存する。"""
    try:
        current = load_app_settings() or {}
        current["default_questionnaire_id"] = payload.questionnaire_id or "default"
        save_app_settings(current)
        return DefaultQuestionnaireSettings(questionnaire_id=current["default_questionnaire_id"])
    except Exception:
        logger.error("set_default_questionnaire_failed")
        return payload


@app.get("/system/patient-summary-api", response_model=PatientSummaryApiInfo)
def get_patient_summary_api_info(request: Request) -> PatientSummaryApiInfo:
    stored = load_app_settings() or {}
    enabled = bool(
        os.getenv("PATIENT_SUMMARY_API_KEY", "").strip()
        or stored.get("patient_summary_api_key_hash")
    )
    return PatientSummaryApiInfo(
        endpoint=_external_url_for(request, "patient_summary"),
        header_name=PATIENT_SUMMARY_API_HEADER,
        is_enabled=enabled,
        last_updated_at=stored.get("patient_summary_api_key_updated_at"),
    )


@app.put("/system/patient-summary-api-key", response_model=PatientSummaryApiInfo)
def set_patient_summary_api_key(payload: PatientSummaryApiKeyPayload, request: Request) -> PatientSummaryApiInfo:
    del payload, request
    raise HTTPException(status_code=404, detail="not_found")


class PatientSummaryApiRequest(BaseModel):
    patient_name: str
    dob: str


class PatientSummaryApiResponse(BaseModel):
    session_id: str
    patient_name: str
    dob: str
    visit_type: str | None = None
    finalized_at: str | None = None
    questionnaire_id: str | None = None
    markdown: str


class PatientSummaryPersonalInfo(BaseModel):
    kana: str | None = None
    postal_code: str | None = None
    address: str | None = None
    phone: str | None = None
    address_parts: dict[str, str] | None = None


class PatientSummaryHistoryItem(BaseModel):
    session_id: str
    patient_name: str
    dob: str
    visit_type: str | None = None
    questionnaire_id: str | None = None
    started_at: str | None = None
    finalized_at: str | None = None
    markdown: str
    gender: str | None = None
    personal_info: PatientSummaryPersonalInfo


class PatientSummariesApiRequest(BaseModel):
    patient_name: str
    dob: str
    cursor: str | None = Field(default=None, max_length=256)
    limit: int = Field(default=20, ge=1, le=100)


class PatientSummariesApiResponse(BaseModel):
    items: list[PatientSummaryHistoryItem]
    next_cursor: str | None = None


class PatientSummaryPdfApiRequest(BaseModel):
    patient_name: str
    dob: str
    session_id: str


def _authorize_patient_summary_request(request: Request, log_prefix: str) -> None:
    if not _is_patient_summary_api_key_valid(request.headers.get(PATIENT_SUMMARY_API_HEADER)):
        logger.warning("%s_invalid_api_key", log_prefix)
        raise HTTPException(status_code=401, detail="invalid_api_key")
    if not _patient_summary_rate_allowed(request):
        logger.warning("%s_rate_limited", log_prefix)
        raise HTTPException(status_code=429, detail="rate_limited")


def _validated_patient_identity(patient_name: str, dob: str) -> tuple[str, str]:
    trimmed_name = patient_name.strip()
    trimmed_dob = dob.strip()
    if not trimmed_name or not trimmed_dob:
        raise HTTPException(status_code=400, detail="patient_name_and_dob_required")
    if not _normalize_patient_name_for_identity(trimmed_name) or not _normalize_dob_variants(trimmed_dob):
        raise HTTPException(status_code=400, detail="invalid_patient_identity")
    return trimmed_name, trimmed_dob


def _list_finalized_patient_sessions(patient_name: str, dob: str) -> list[dict[str, Any]]:
    """DBページを順に走査し、氏名・生年月日が厳密一致する完了セッションを返す。"""

    normalized_name = _normalize_patient_name_for_identity(patient_name)
    dob_variants = _normalize_dob_variants(dob)
    candidates: dict[str, dict[str, Any]] = {}
    cursor: str | None = None
    seen_cursors: set[str] = set()
    while True:
        page = db_list_sessions_page(patient_name=patient_name, limit=200, cursor=cursor)
        for summary in page.get("items", []):
            summary_id = summary.get("id")
            if not isinstance(summary_id, str) or not summary_id or summary_id in candidates:
                continue
            summary_dob_variants = _normalize_dob_variants(summary.get("dob"))
            if not (dob_variants & summary_dob_variants):
                continue
            session = db_get_session(summary_id)
            if not session or (session.get("completion_status") or "") != "finalized":
                continue
            if _normalize_patient_name_for_identity(session.get("patient_name")) != normalized_name:
                continue
            if not (dob_variants & _normalize_dob_variants(session.get("dob"))):
                continue
            candidates[summary_id] = session
        next_cursor = page.get("next_cursor")
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return sorted(
        candidates.values(),
        key=lambda item: (
            item.get("finalized_at") or "",
            item.get("started_at") or "",
            item.get("id") or "",
        ),
        reverse=True,
    )


def _patient_summary_personal_info(session: dict[str, Any]) -> PatientSummaryPersonalInfo:
    answers = session.get("answers") or {}
    raw: Any = None
    if isinstance(answers, dict):
        for key in ("personal_info", "personalInfo", "patient_basic_info"):
            value = answers.get(key)
            if isinstance(value, dict):
                raw = value
                break
    if not isinstance(raw, dict):
        raw = {}

    def optional_text(*keys: str) -> str | None:
        for key in keys:
            value = raw.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
        return None

    postal_code = optional_text("postal_code", "postalCode", "postalcode")
    address_parts: dict[str, str] | None = None
    if postal_code:
        try:
            lookup = lookup_postal_code(postal_code)
            candidates = lookup.get("candidates") or []
            first = candidates[0] if candidates and isinstance(candidates[0], dict) else None
            if first:
                address_parts = {
                    "prefecture": str(first.get("prefecture") or ""),
                    "city": str(first.get("city") or ""),
                    "town": str(first.get("town") or ""),
                }
        except Exception:
            logger.warning("patient_summary_postal_lookup_failed")
    return PatientSummaryPersonalInfo(
        kana=optional_text("kana", "name_kana", "nameKana"),
        postal_code=postal_code,
        address=optional_text("address"),
        phone=optional_text("phone", "tel", "telephone"),
        address_parts=address_parts,
    )


def _patient_summary_history_item(session: dict[str, Any]) -> PatientSummaryHistoryItem:
    rows, vt_label, _ = build_session_rows_and_items(session)
    return PatientSummaryHistoryItem(
        session_id=str(session.get("id") or ""),
        patient_name=str(session.get("patient_name") or ""),
        dob=str(session.get("dob") or ""),
        visit_type=session.get("visit_type"),
        questionnaire_id=session.get("questionnaire_id"),
        started_at=session.get("started_at"),
        finalized_at=session.get("finalized_at"),
        markdown="\n".join(build_markdown_lines(session, rows, vt_label)),
        gender=session.get("gender"),
        personal_info=_patient_summary_personal_info(session),
    )


def _patient_summaries_start_index(
    cursor: str | None, sessions_for_patient: list[dict[str, Any]]
) -> int:
    if not cursor:
        return 0
    for index, session in enumerate(sessions_for_patient):
        if session.get("id") == cursor:
            return index + 1
    raise HTTPException(status_code=400, detail="invalid_cursor")


@app.post("/patient-summary", name="patient_summary", response_model=PatientSummaryApiResponse)
def get_patient_summary(payload: PatientSummaryApiRequest, request: Request) -> PatientSummaryApiResponse:
    _authorize_patient_summary_request(request, "patient_summary")
    trimmed_name, trimmed_dob = _validated_patient_identity(payload.patient_name, payload.dob)
    session = _find_latest_finalized_session(trimmed_name, trimmed_dob)
    if not session:
        raise HTTPException(status_code=404, detail="問診がありません。")
    rows, vt_label, _ = build_session_rows_and_items(session)
    markdown = "\n".join(build_markdown_lines(session, rows, vt_label))
    return PatientSummaryApiResponse(
        session_id=session.get("id"),
        patient_name=session.get("patient_name") or trimmed_name,
        dob=session.get("dob") or trimmed_dob,
        visit_type=session.get("visit_type"),
        finalized_at=session.get("finalized_at"),
        questionnaire_id=session.get("questionnaire_id"),
        markdown=markdown,
    )


@app.post("/patient-summaries", response_model=PatientSummariesApiResponse)
def get_patient_summaries(payload: PatientSummariesApiRequest, request: Request) -> PatientSummariesApiResponse:
    _authorize_patient_summary_request(request, "patient_summaries")
    trimmed_name, trimmed_dob = _validated_patient_identity(payload.patient_name, payload.dob)
    sessions_for_patient = _list_finalized_patient_sessions(trimmed_name, trimmed_dob)
    start_index = _patient_summaries_start_index(payload.cursor, sessions_for_patient)
    page = sessions_for_patient[start_index : start_index + payload.limit]
    next_index = start_index + len(page)
    return PatientSummariesApiResponse(
        items=[_patient_summary_history_item(session) for session in page],
        next_cursor=str(page[-1].get("id")) if page and next_index < len(sessions_for_patient) else None,
    )


@app.post("/patient-summary/pdf")
def get_patient_summary_pdf(payload: PatientSummaryPdfApiRequest, request: Request) -> Response:
    _authorize_patient_summary_request(request, "patient_summary_pdf")
    trimmed_name, trimmed_dob = _validated_patient_identity(payload.patient_name, payload.dob)
    session_id = payload.session_id.strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id_required")
    session = db_get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="問診がありません。")
    if (session.get("completion_status") or "") != "finalized" or session.get("visit_type") != "initial":
        raise HTTPException(status_code=404, detail="初診の完了済み問診がありません。")
    if _normalize_patient_name_for_identity(session.get("patient_name")) != _normalize_patient_name_for_identity(trimmed_name):
        raise HTTPException(status_code=404, detail="問診がありません。")
    if not (_normalize_dob_variants(session.get("dob")) & _normalize_dob_variants(trimmed_dob)):
        raise HTTPException(status_code=404, detail="問診がありません。")
    rows, vt_label, items = build_session_rows_and_items(session)
    layout_mode, facility_name = _resolve_pdf_render_config()
    pdf_bytes = _render_session_pdf(
        session=session,
        rows=rows,
        template_items=items,
        answers=session.get("answers", {}) or {},
        vt_label=vt_label,
        llm_question_texts=session.get("llm_question_texts") or {},
        summary=session.get("summary"),
        layout_mode=layout_mode,
        facility_name=facility_name,
    )
    date_value = str(session.get("finalized_at") or session.get("started_at") or "")[:10].replace("-", "")
    if len(date_value) != 8 or not date_value.isdigit():
        date_value = datetime.now(ZoneInfo(DEFAULT_TIMEZONE)).strftime("%Y%m%d")
    session_short = re.sub(r"[^A-Za-z0-9_-]", "", session_id)[:12] or "session"
    filename = f"問診票_初診_{date_value}_{session_short}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        },
    )


class DatabaseStatus(BaseModel):
    """使用中のデータベース状態。"""

    status: str


class LLMStatusResponse(BaseModel):
    """LLM 通信状態のスナップショット。"""

    status: str
    detail: str | None = None
    source: str | None = None
    checked_at: datetime | None = None


class LLMAvailabilityResponse(BaseModel):
    """患者画面でも利用できる非機密のLLM可用状態。"""

    status: str


@app.get("/system/database-status", response_model=DatabaseStatus)
def get_database_status() -> DatabaseStatus:
    """データベースの使用状況を返す。"""
    backend = get_current_persistence_backend()
    if backend == "firestore":
        if check_firestore_health():
            settings = get_settings()
            status = "firestore_emulator" if settings.firestore.use_emulator else "firestore"
            return DatabaseStatus(status=status)
        return DatabaseStatus(status="error")
    if not COUCHDB_URL:
        return DatabaseStatus(status="sqlite")
    try:
        if couch_db is None:
            raise RuntimeError("couch_db not initialized")
        couch_db.info()
        return DatabaseStatus(status="couchdb")
    except Exception:
        return DatabaseStatus(status="error")


@app.get("/system/llm-status", response_model=LLMStatusResponse)
def get_llm_status_snapshot(
    _admin: dict[str, Any] = Depends(require_admin_access),
) -> LLMStatusResponse:
    """LLM 通信状態を返す。"""

    snapshot = llm_gateway.get_status_snapshot()
    status = snapshot.get("status")
    if status not in {"ok", "ng", "disabled", "pending"}:
        status = "disabled" if not llm_gateway.settings.enabled else "pending"
    return LLMStatusResponse(
        status=str(status),
        detail=snapshot.get("detail"),
        source=snapshot.get("source"),
        checked_at=snapshot.get("checked_at"),
    )


@app.get("/system/llm-availability", response_model=LLMAvailabilityResponse)
def get_llm_availability() -> LLMAvailabilityResponse:
    """秘密情報や診断詳細を含めず、患者画面に必要な状態だけを返す。"""

    snapshot = llm_gateway.get_status_snapshot()
    status = snapshot.get("status")
    if status not in {"ok", "ng", "disabled", "pending"}:
        status = "disabled" if not llm_gateway.settings.enabled else "pending"
    return LLMAvailabilityResponse(status=str(status))


# --- 管理者認証 API ---
from .admin_security_routes import router as admin_security_router
app.include_router(admin_security_router)


def _require_admin_push_access(authorization: str | None) -> None:
    claims = _decode_admin_access_token(authorization)
    if "push:manage" not in set(str(claims.get("scope") or "").split()):
        raise HTTPException(status_code=403, detail="insufficient scope")


class SessionCreateRequest(BaseModel):
    """セッション作成時に受け取る情報。"""

    patient_name: str = Field(min_length=1, max_length=128)
    dob: str = Field(min_length=1, max_length=32)
    gender: str = Field(max_length=32)
    visit_type: Literal["initial", "followup"]
    answers: dict[str, Any]
    questionnaire_id: str | None = Field(default=None, max_length=128)


def _collect_question_texts_from_items(items: Iterable[Any] | None) -> dict[str, str]:
    """テンプレート項目からIDと質問文のマップを構築する。"""

    mapping: dict[str, str] = {}
    if not items:
        return mapping

    stack: list[Any] = list(items)
    while stack:
        item = stack.pop()
        if item is None:
            continue
        item_id = None
        label = None
        try:
            item_id = getattr(item, "id", None)
        except Exception:
            item_id = None
        if item_id is None and isinstance(item, dict):
            item_id = item.get("id")
        try:
            label = getattr(item, "label", None)
        except Exception:
            label = None
        if label is None and isinstance(item, dict):
            label = item.get("label")
        if item_id and isinstance(label, str):
            mapping[item_id] = label

        followups = None
        try:
            followups = getattr(item, "followups", None)
        except Exception:
            followups = None
        if followups is None and isinstance(item, dict):
            followups = item.get("followups")
        if isinstance(followups, dict):
            for children in followups.values():
                if not children:
                    continue
                if isinstance(children, (list, tuple, set)):
                    stack.extend(list(children))
                else:
                    stack.append(children)
    return mapping


class Session(BaseModel):
    """セッションの内容を表すモデル。

    現段階ではメモリ上保持の最小実装。plannedSystem.md に沿って
    追加質問の上限や進捗状態を保持する。
    """

    id: str
    patient_name: str
    dob: str
    gender: str
    visit_type: str
    questionnaire_id: str
    template_items: list[QuestionnaireItem]
    answers: dict[str, Any]
    summary: str | None = None
    # 進行管理
    remaining_items: list[str] = []
    completion_status: str = "in_progress"  # or "complete"
    attempt_counts: dict[str, int] = {}
    additional_questions_used: int = 0
    max_additional_questions: int = 5
    pending_llm_questions: list[dict[str, Any]] = []
    started_at: datetime | None = None
    finalized_at: datetime | None = None
    interrupted: bool = False
    followup_prompt: str = DEFAULT_FOLLOWUP_PROMPT
    # LLM が提示した追加質問の「質問文」を保持するマップ。
    # キーは `llm_1` のような item_id。
    llm_question_texts: dict[str, str] = Field(default_factory=dict)
    # 保存時に使用する全問診項目ID -> 質問文のマップ。
    question_texts: dict[str, str] = Field(default_factory=dict)


def _parse_session_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    except (TypeError, ValueError):
        return None


def _restore_session(session_id: str) -> Session | None:
    """Cloud Run の別インスタンスでも処理を継続できるよう永続層から復元する。"""

    row = db_get_session(session_id)
    if not row:
        return None
    questionnaire_id = str(row.get("questionnaire_id") or "default")
    visit_type = str(row.get("visit_type") or "initial")
    template = db_get_template(questionnaire_id, visit_type) or db_get_template("default", visit_type)
    items = [QuestionnaireItem(**item) for item in ((template or {}).get("items") or [])]
    return Session(
        id=str(row.get("id") or session_id),
        patient_name=str(row.get("patient_name") or ""),
        dob=str(row.get("dob") or ""),
        gender=str(row.get("gender") or ""),
        visit_type=visit_type,
        questionnaire_id=questionnaire_id,
        template_items=items,
        answers=row.get("answers") or {},
        summary=row.get("summary"),
        remaining_items=list(row.get("remaining_items") or []),
        completion_status=str(row.get("completion_status") or "in_progress"),
        attempt_counts=row.get("attempt_counts") or {},
        additional_questions_used=int(row.get("additional_questions_used") or 0),
        max_additional_questions=int(row.get("max_additional_questions") if row.get("max_additional_questions") is not None else 5),
        pending_llm_questions=list(row.get("pending_llm_questions") or []),
        started_at=_parse_session_datetime(row.get("started_at")),
        finalized_at=_parse_session_datetime(row.get("finalized_at")),
        interrupted=bool(row.get("interrupted")),
        followup_prompt=str(row.get("followup_prompt") or DEFAULT_FOLLOWUP_PROMPT),
        llm_question_texts=row.get("llm_question_texts") or {},
        question_texts=row.get("question_texts") or {},
    )


def _get_session(session_id: str) -> Session | None:
    # A persistent capability lease serializes callers across instances. Always
    # reload inside that lease; an instance-local cache may contain stale data.
    sessions.pop(session_id, None)
    return _restore_session(session_id)


class SessionCreateResponse(BaseModel):
    """セッション作成時のレスポンス。credentialはこの応答だけで発行する。"""

    id: str
    session_token: str
    expires_at: str
    patient_name: str
    dob: str
    gender: str
    visit_type: str
    questionnaire_id: str
    answers: dict[str, Any]
    remaining_items: list[str]
    completion_status: str
    status: str = "created"


class SessionSummary(BaseModel):
    """管理画面で表示するセッションの概要。"""

    id: str
    patient_name: str
    dob: str
    visit_type: str
    started_at: str | None = None
    finalized_at: str | None = None
    interrupted: bool = False


class SessionSummaryPage(BaseModel):
    items: list[SessionSummary]
    next_cursor: str | None = None


class SessionFinalizeEvent(BaseModel):
    """問診完了時のイベント通知用レスポンス。"""

    id: str
    patient_name: str | None = None
    dob: str | None = None
    visit_type: str | None = None
    started_at: str | None = None
    finalized_at: str


class PushSubscriptionRequest(BaseModel):
    token: str = Field(min_length=20, max_length=4096)


def _firebase_web_config() -> dict[str, str]:
    mapping = {
        "apiKey": "FIREBASE_WEB_API_KEY",
        "authDomain": "FIREBASE_WEB_AUTH_DOMAIN",
        "projectId": "FIREBASE_WEB_PROJECT_ID",
        "storageBucket": "FIREBASE_WEB_STORAGE_BUCKET",
        "messagingSenderId": "FIREBASE_WEB_MESSAGING_SENDER_ID",
        "appId": "FIREBASE_WEB_APP_ID",
    }
    return {key: os.getenv(env_name, "").strip() for key, env_name in mapping.items()}


@app.get("/system/push-config")
def get_push_config() -> dict[str, Any]:
    config = _firebase_web_config()
    vapid_key = os.getenv("FIREBASE_WEB_VAPID_KEY", "").strip()
    enabled = bool(vapid_key and all(config.values()))
    return {"enabled": enabled, "firebase": config if enabled else {}, "vapidKey": vapid_key if enabled else ""}


@app.post("/admin/push-subscriptions")
def register_push_subscription(
    payload: PushSubscriptionRequest,
    request: Request,
    authorization: str | None = Header(None),
) -> dict[str, str]:
    _require_admin_push_access(authorization)
    save_push_subscription(payload.token, request.headers.get("user-agent"))
    return {"status": "ok"}


@app.delete("/admin/push-subscriptions")
def unregister_push_subscription(
    payload: PushSubscriptionRequest,
    authorization: str | None = Header(None),
) -> dict[str, str]:
    _require_admin_push_access(authorization)
    delete_push_subscription(payload.token)
    return {"status": "ok"}


def _send_push_finalize_notification(event: dict[str, Any]) -> None:
    """FCMへ個人情報を含まない完了通知を送り、無効トークンを除去する。"""

    tokens = list_push_subscriptions()
    if not tokens:
        return
    try:
        import firebase_admin  # type: ignore
        from firebase_admin import messaging  # type: ignore

        if not firebase_admin._apps:
            firebase_admin.initialize_app()
        public_url = os.getenv("FRONTEND_PUBLIC_URL", "").strip().rstrip("/")
        webpush = None
        if public_url.startswith("https://"):
            webpush = messaging.WebpushConfig(
                fcm_options=messaging.WebpushFCMOptions(link=f"{public_url}/admin/sessions")
            )
        message = messaging.MulticastMessage(
            tokens=tokens[:500],
            data={
                "type": "session.finalized",
                "session_id": str(event.get("id") or ""),
                "finalized_at": str(event.get("finalized_at") or ""),
            },
            notification=messaging.Notification(
                title="新しい問診が完了しました",
                body="管理画面で問診結果をご確認ください。",
            ),
            webpush=webpush,
        )
        sender = getattr(messaging, "send_each_for_multicast", None) or messaging.send_multicast
        response = sender(message)
        for token, result in zip(tokens, response.responses):
            if result.success:
                continue
            error_name = type(result.exception).__name__ if result.exception else ""
            if error_name in {"UnregisteredError", "SenderIdMismatchError"}:
                delete_push_subscription(token)
        logger.info("push_notification_sent success=%s failure=%s", response.success_count, response.failure_count)
    except Exception:
        logger.error("push_notification_failed")


class SessionDetail(BaseModel):
    """管理画面で表示するセッション詳細。"""

    id: str
    patient_name: str
    dob: str
    gender: str
    visit_type: str
    questionnaire_id: str
    answers: dict[str, Any]
    question_texts: dict[str, str] | None = None
    # LLM による追加質問の提示文マップ（例: {"llm_1": "いつから症状がありますか？"}）
    llm_question_texts: dict[str, str] | None = None
    summary: str | None = None
    started_at: str | None = None
    finalized_at: str | None = None
    interrupted: bool = False


def _ensure_isoformat(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _build_finalize_event_from_session(session: Session) -> SessionFinalizeEvent:
    finalized_at = session.finalized_at or datetime.now(UTC)
    started_at = session.started_at or finalized_at
    return SessionFinalizeEvent(
        id=session.id,
        patient_name=session.patient_name,
        dob=session.dob,
        visit_type=session.visit_type,
        started_at=_ensure_isoformat(started_at),
        finalized_at=_ensure_isoformat(finalized_at) or datetime.now(UTC).isoformat(),
    )


class FinalizeRequest(BaseModel):
    """セッション確定時に受け取る追加情報。"""

    llm_error: str | None = None


@app.post("/sessions", response_model=SessionCreateResponse)
def create_session(req: SessionCreateRequest) -> SessionCreateResponse:
    """新しいセッションを作成して返す。"""
    session_id = str(uuid4())

    # questionnaire_id が指定されていない場合はDBからデフォルト設定を読み込む
    questionnaire_id = req.questionnaire_id
    if not questionnaire_id:
        try:
            stored = load_app_settings() or {}
            questionnaire_id = stored.get("default_questionnaire_id") or "default"
        except Exception:
            logger.error("get_default_questionnaire_failed_in_session_create")
            questionnaire_id = "default"

    tpl = db_get_template(questionnaire_id, req.visit_type)
    if tpl is None:
        tpl = db_get_template("default", req.visit_type)
    if tpl is None:
        tpl = {
            "id": "default",
            "items": [
                {
                    "id": "chief_complaint",
                    "label": "主訴は何ですか？",
                    "type": "string",
                    "required": True,
                    "description": "できるだけ具体的にご記入ください（例：3日前から左ひざが痛い）。",
                },
                {
                    "id": "onset",
                    "label": "発症時期はいつからですか？",
                    "type": "string",
                    "required": False,
                    "description": "わかる範囲で構いません（例：今朝から、1週間前から など）。",
                },
            ],
        }
    items = [QuestionnaireItem(**it) for it in tpl["items"]]
    if req.gender:
        items = [it for it in items if not it.gender or it.gender == "both" or it.gender == req.gender]
    question_texts = _collect_question_texts_from_items(items)
    Validator.validate_partial(items, req.answers)
    for k, v in list(req.answers.items()):
        # 空欄の回答は「該当なし」に統一
        req.answers[k] = StructuredContextManager.normalize_answer(v)
    cfg = (
        get_followup_config(questionnaire_id, req.visit_type)
        or get_followup_config("default", req.visit_type)
        or {}
    )
    prompt_text = cfg.get("prompt") if cfg.get("enabled") else DEFAULT_FOLLOWUP_PROMPT
    session = Session(
        id=session_id,
        patient_name=req.patient_name,
        dob=req.dob,
        gender=req.gender,
        visit_type=req.visit_type,
        questionnaire_id=questionnaire_id,
        template_items=items,
        answers=req.answers,
        max_additional_questions=(
            int(tpl.get("llm_followup_max_questions", 5))
            if tpl.get("llm_followup_enabled", True)
            else 0
        ),
        followup_prompt=prompt_text,
        question_texts=question_texts,
        started_at=datetime.now(UTC),
    )
    fsm = SessionFSM(session, llm_gateway)
    fsm.update_completion()
    session.interrupted = session.completion_status != "finalized"
    save_session(session)
    session_token, expires_at = issue_capability(session_id)
    global METRIC_SESSIONS_CREATED
    METRIC_SESSIONS_CREATED += 1
    logger.info("session_created id=%s visit_type=%s", session_id, req.visit_type)
    return SessionCreateResponse(
        id=session.id,
        session_token=session_token,
        expires_at=expires_at,
        patient_name=session.patient_name,
        dob=session.dob,
        gender=session.gender,
        visit_type=session.visit_type,
        questionnaire_id=session.questionnaire_id,
        answers=session.answers,
        remaining_items=session.remaining_items,
        completion_status=session.completion_status,
    )


class AnswersRequest(BaseModel):
    """複数回答を一度に受け取るリクエスト。"""

    answers: dict[str, Any]


@app.post("/sessions/{session_id}/answers")
def add_answers(session_id: str, req: AnswersRequest) -> dict:
    """複数の回答をまとめて保存する。"""
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    fsm = SessionFSM(session, llm_gateway)
    for item_id, ans in req.answers.items():
        fsm.step(item_id, ans)
    save_session(session)
    logger.info("answers_saved id=%s count=%d", session_id, len(req.answers))
    return {"status": "ok", "remaining_items": session.remaining_items}


class LlmAnswerRequest(BaseModel):
    """追加質問への回答データ。"""

    item_id: str
    answer: Any


class LlmAnswersRequest(BaseModel):
    """追加質問への回答を一括保存するリクエスト。"""

    answers: dict[str, Any]


@app.post("/sessions/{session_id}/llm-answers")
def submit_llm_answer(session_id: str, req: LlmAnswerRequest) -> dict:
    """追加質問への回答を保存する。"""
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    fsm = SessionFSM(session, llm_gateway)
    fsm.step(req.item_id, req.answer)
    global METRIC_ANSWERS_RECEIVED
    METRIC_ANSWERS_RECEIVED += 1
    save_session(session)
    logger.info("llm_answer_saved id=%s item=%s", session_id, req.item_id)
    return {"status": "ok", "remaining_items": session.remaining_items}


@app.post("/sessions/{session_id}/llm-answers/batch")
def submit_llm_answers(session_id: str, req: LlmAnswersRequest) -> dict:
    """追加質問の回答を1回の永続化書き込みで保存する。"""

    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    fsm = SessionFSM(session, llm_gateway)
    for item_id, answer in req.answers.items():
        fsm.step(item_id, answer)
    global METRIC_ANSWERS_RECEIVED
    METRIC_ANSWERS_RECEIVED += len(req.answers)
    save_session(session)
    logger.info("llm_answers_saved id=%s count=%d", session_id, len(req.answers))
    return {"status": "ok", "remaining_items": session.remaining_items}


@app.post("/sessions/{session_id}/llm-questions")
def get_llm_questions(session_id: str) -> dict:
    """不足項目に応じた追加質問を返す。"""
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    if session.completion_status == "finalized":
        raise HTTPException(409, "session finalized")
    rate_limit("llm:session:" + session_id, 10)
    rate_limit("llm:global", 120)
    fsm = SessionFSM(session, llm_gateway)
    before = (
        session.additional_questions_used,
        list(session.pending_llm_questions),
        dict(session.llm_question_texts),
    )
    questions = fsm.next_questions()
    after = (
        session.additional_questions_used,
        list(session.pending_llm_questions),
        dict(session.llm_question_texts),
    )
    if after != before:
        save_session(session)
    if not questions:
        logger.info("llm_question_limit id=%s", session_id)
        return {"questions": []}
    for q in questions:
        logger.info("llm_question id=%s item=%s", session_id, q["id"])
    return {"questions": questions}


@app.post("/sessions/{session_id}/finalize")
def finalize_session(
    session_id: str, request: Request, background: BackgroundTasks,
    payload: FinalizeRequest | None = None,
) -> dict:
    """確定処理は永続lease内で完了し、患者へ受付結果だけ返す。"""
    receipt = getattr(request.state, "patient_receipt", None)
    if receipt:
        return receipt
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    operation = request.state.patient_operation
    # Recover a response after DB save without rerunning the model.
    if session.completion_status == "finalized" and session.finalized_at is not None:
        return finalize_receipt(session_id, session.finalized_at.isoformat(), operation)
    SessionFSM(session, llm_gateway).update_completion()
    cfg = get_summary_config(session.questionnaire_id, session.visit_type) or get_summary_config(
        "default", session.visit_type
    )
    from .clinical_context import clinical_answers
    context = clinical_answers(session)
    session.summary = ""
    if cfg and cfg.get("enabled"):
        rate_limit("llm:global", 120)
        rate_limit("llm:session:" + session_id, 10)
        if llm_gateway.has_remote_backend() and not (payload and payload.llm_error):
            labels = {key: value for key, value in session.question_texts.items() if key in context}
            prompt = cfg.get("prompt") or "問診項目と回答をもとに簡潔な日本語のサマリーを作成してください。"
            session.summary = llm_gateway.summarize_with_prompt(prompt, context, labels, lock_key=session.id, retry=0)
        else:
            session.summary = llm_gateway.summarize(context)
        global METRIC_SUMMARIES
        METRIC_SUMMARIES += 1
    if payload and payload.llm_error:
        # Never persist client-supplied exception bodies.
        session.summary = (session.summary or "") + "\n[LLM追加質問は利用できませんでした]"
    session.started_at = session.started_at or datetime.now(UTC)
    session.finalized_at = datetime.now(UTC)
    session.interrupted = False
    session.completion_status = "finalized"
    save_session(session)
    receipt = finalize_receipt(session_id, session.finalized_at.isoformat(), operation)
    logger.info("session_finalized id=%s", session_id)
    event = _build_finalize_event_from_session(session)
    background.add_task(_send_push_finalize_notification, event.model_dump())
    sessions.pop(session_id, None)
    return receipt


@app.post("/admin/sessions/export")
def export_sessions_api(payload: SessionsExportRequest) -> StreamingResponse:
    """問診結果データをエクスポートする。"""

    sessions_data = export_sessions_data(
        session_ids=payload.session_ids,
        start_date=payload.start_date,
        end_date=payload.end_date,
        visit_type=payload.visit_type,
    )
    export_payload = {
        "sessions": [portable_session(record) for record in sessions_data],
        "count": len(sessions_data),
        "filters": {
            "session_ids": payload.session_ids or None,
            "start_date": payload.start_date,
            "end_date": payload.end_date,
            "visit_type": payload.visit_type,
        },
    }
    envelope = _build_export_envelope(export_payload, "session_data", payload.password or None)
    content = json.dumps(envelope, ensure_ascii=False, indent=2).encode("utf-8")
    filename = f"sessions-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/json",
        headers={**SAFE_HEADERS, "Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/admin/sessions/import")
async def import_sessions_api(
    file: UploadFile = File(...), password: str | None = Form(None), mode: str = Form("merge")
) -> dict[str, Any]:
    """問診結果データをインポートする。"""

    raw = await read_import(file)
    export_type, payload = _parse_import_envelope(raw, password or None)
    if export_type != "session_data":
        raise HTTPException(status_code=400, detail="invalid_export_type")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid_export_payload")
    sessions_payload = validate_sessions(payload.get("sessions", []))
    mode_value = (mode or "merge").lower()
    stats = atomic_import("sessions_data", sessions_payload, mode=mode_value)
    return {"status": "ok", "imported": stats, "mode": mode_value, "count": len(sessions_payload)}


@app.get("/admin/sessions", response_model=list[SessionSummary])
def admin_list_sessions(
    patient_name: str | None = None,
    dob: str | None = None,
    start_date: str | None = Query(None, alias="start_date"),
    end_date: str | None = Query(None, alias="end_date"),
    visit_type: Literal["initial", "followup"] | None = Query(None, alias="visit_type"),
) -> list[SessionSummary]:
    """保存済みセッションの一覧を返す。"""
    sessions = db_list_sessions(
        patient_name=patient_name,
        dob=dob,
        start_date=start_date,
        end_date=end_date,
        visit_type=visit_type,
    )
    return [SessionSummary(**s) for s in sessions]


@app.get("/admin/sessions/page", response_model=SessionSummaryPage)
def admin_list_sessions_page(
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
) -> SessionSummaryPage:
    """既定一覧向けのカーソルページング。Firestoreの全件走査を行わない。"""

    page = db_list_sessions_page(limit=limit, cursor=cursor)
    return SessionSummaryPage(
        items=[SessionSummary(**item) for item in page.get("items", [])],
        next_cursor=page.get("next_cursor"),
    )


@app.get("/admin/sessions/completed", response_model=list[SessionFinalizeEvent])
def admin_list_completed_sessions(
    since: str,
    limit: int = Query(50, ge=1, le=200),
) -> list[SessionFinalizeEvent]:
    """Pushを利用できない環境向けの低頻度ポーリングAPI。"""

    try:
        since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        if since_dt.tzinfo is None:
            since_dt = since_dt.replace(tzinfo=UTC)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid_since") from exc
    events, _ = list_sessions_finalized_after(since_dt, limit=limit)
    return [SessionFinalizeEvent(**event) for event in events]


@app.get("/admin/sessions/{session_id}", response_model=SessionDetail)
def admin_get_session(session_id: str) -> SessionDetail:
    """指定セッションの詳細を返す。"""
    s = db_get_session(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="session not found")
    return SessionDetail(
        id=s["id"],
        patient_name=s["patient_name"],
        dob=s["dob"],
        gender=s["gender"],
        visit_type=s["visit_type"],
        questionnaire_id=s["questionnaire_id"],
        answers=s.get("answers", {}),
        question_texts=s.get("question_texts") or {},
        llm_question_texts=s.get("llm_question_texts") or {},
        summary=s.get("summary"),
        started_at=s.get("started_at") or s.get("finalized_at"),
        finalized_at=s.get("finalized_at"),
        interrupted=bool(s.get("interrupted")),
    )


@app.get("/admin/sessions/bulk/download/{fmt}")
def admin_bulk_download(fmt: str, ids: list[str] = Query(default=[])) -> Response:
    """複数セッションを指定形式で一括ダウンロードする。

    - 返却形式は ZIP（`sessions-YYYYmmdd-HHMMSS.zip`）。
    - `ids` クエリで対象セッションIDを複数指定する。
    - `fmt` は `pdf|md|csv` のいずれか。
    """
    if fmt not in {"pdf", "md", "csv"}:
        raise HTTPException(status_code=400, detail="unsupported format")
    if not ids:
        raise HTTPException(status_code=400, detail="ids is required")
    if len(ids) > MAX_IMPORT_RECORDS:
        raise HTTPException(status_code=400, detail="too_many_records")

    def sanitize_filename(name: str) -> str:
        name = re.sub(r"[\\/:*?\"<>|]", "_", name)
        name = "".join(char for char in name if not unicodedata.category(char).startswith("C"))
        name = name.strip(" .").replace(" ", "_")[:180]
        return name or "session"

    # CSV は「全件を1枚の集計CSV」で返す
    if fmt == "csv":
        sbuf = io.StringIO()
        writer = SafeCSVWriter(sbuf)
        # 共通セクション列 + 回答一覧（まとめ） + サマリー
        writer.writerow(["セッションID", "患者名", "生年月日", "受診種別", "テンプレートID", "確定日時", "回答一覧", "自動生成サマリー"])
        for sid in ids:
            s = db_get_session(sid)
            if not s:
                continue
            rows, vt_label, _items = build_session_rows_and_items(s)
            answers_text_lines = [f"- {label}: {ans or '未回答'}" for label, ans in rows]
            answers_text = "\n".join(answers_text_lines)
            writer.writerow([
                sid,
                s.get("patient_name", ""),
                s.get("dob", ""),
                vt_label,
                s.get("questionnaire_id", ""),
                s.get("finalized_at", "") or "",
                answers_text,
                s.get("summary", "") or "",
            ])
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        content = sbuf.getvalue()
        return Response(
            content,
            media_type="text/csv; charset=utf-8",
            headers={**SAFE_HEADERS, "Content-Disposition": f"attachment; filename=sessions-{ts}.csv"},
        )

    # md / pdf は ZIP にまとめて返す
    layout_mode, facility_name = _resolve_pdf_render_config()
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for sid in ids:
            s = db_get_session(sid)
            if not s:
                continue
            rows, vt_label, items = build_session_rows_and_items(s)
            base = sanitize_filename(f"{s.get('patient_name','')}_{s.get('dob','')}_{sid}")
            lines = build_markdown_lines(s, rows, vt_label)
            if fmt == "md":
                content = "\n".join(lines).encode("utf-8")
                zf.writestr(f"{base}.md", content)
            elif fmt == "pdf":
                pdf_bytes = _render_session_pdf(
                    session=s,
                    rows=rows,
                    template_items=items,
                    answers=s.get("answers", {}) or {},
                    vt_label=vt_label,
                    llm_question_texts=s.get("llm_question_texts") or {},
                    summary=s.get("summary"),
                    layout_mode=layout_mode,
                    facility_name=facility_name,
                )
                zf.writestr(f"{base}.pdf", pdf_bytes)

    zip_buf.seek(0)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={**SAFE_HEADERS, "Content-Disposition": f"attachment; filename=sessions-{ts}.zip"},
    )


@app.get("/admin/sessions/{session_id}/download/{fmt}")
def admin_download_session(session_id: str, fmt: str) -> Response:
    """指定セッションを指定形式でダウンロードする。"""
    s = db_get_session(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="session not found")
    rows, vt_label, items = build_session_rows_and_items(s)
    lines = build_markdown_lines(s, rows, vt_label)
    if fmt == "md":
        content = "\n".join(lines)
        return Response(
            content,
            media_type="text/markdown; charset=utf-8",
            headers={**SAFE_HEADERS, "Content-Disposition": f"attachment; filename=session-{quote(session_id, safe='')}.md"},
        )
    if fmt == "csv":
        buf = io.StringIO()
        writer = SafeCSVWriter(buf)
        writer.writerow(["項目", "回答"])
        for label, ans in rows:
            writer.writerow([label, ans])
        content = buf.getvalue()
        return Response(
            content,
            media_type="text/csv; charset=utf-8",
            headers={**SAFE_HEADERS, "Content-Disposition": f"attachment; filename=session-{quote(session_id, safe='')}.csv"},
        )
    if fmt == "pdf":
        layout_mode, facility_name = _resolve_pdf_render_config()
        pdf_bytes = _render_session_pdf(
            session=s,
            rows=rows,
            template_items=items,
            answers=s.get("answers", {}) or {},
            vt_label=vt_label,
            llm_question_texts=s.get("llm_question_texts") or {},
            summary=s.get("summary"),
            layout_mode=layout_mode,
            facility_name=facility_name,
        )
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers={**SAFE_HEADERS, "Content-Disposition": f"attachment; filename=session-{quote(session_id, safe='')}.pdf"},
        )
    raise HTTPException(status_code=400, detail="unsupported format")


@app.delete("/admin/sessions/{session_id}")
def admin_delete_session(session_id: str) -> dict[str, Any]:
    """指定セッションを削除する。"""
    from .patient_security import revoke_capability
    revoke_capability(session_id)
    sessions.pop(session_id, None)
    deleted = db_delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="session not found")
    return {"status": "ok", "deleted": 1}


@app.post("/admin/sessions/bulk/delete")
def admin_bulk_delete(ids: list[str] = Query(default=[])) -> dict[str, Any]:
    """複数セッションを一括削除する。

    - `ids` クエリで対象セッションIDを複数指定する。
    - 削除件数を返す。
    """
    if not ids:
        raise HTTPException(status_code=400, detail="ids is required")
    if len(ids) > MAX_IMPORT_RECORDS:
        raise HTTPException(status_code=400, detail="too_many_records")
    from .patient_security import revoke_capability
    for session_id in dict.fromkeys(ids):
        revoke_capability(session_id)
        sessions.pop(session_id, None)
    count = db_delete_sessions(ids)
    return {"status": "ok", "deleted": int(count)}


# --- 観測用メトリクス（最小実装） ---
METRIC_SESSIONS_CREATED = 0
METRIC_ANSWERS_RECEIVED = 0
METRIC_LLM_CHATS = 0
METRIC_SUMMARIES = 0


@app.get("/metrics")
def metrics() -> Response:
    """OpenMetrics 互換の最小テキストを返す。"""
    lines = [
        "# HELP monshin_sessions_created Number of sessions created",
        "# TYPE monshin_sessions_created counter",
        f"monshin_sessions_created {METRIC_SESSIONS_CREATED}",
        "# HELP monshin_answers_received Number of answers received",
        "# TYPE monshin_answers_received counter",
        f"monshin_answers_received {METRIC_ANSWERS_RECEIVED}",
        "# HELP monshin_llm_chats Number of llm chat calls",
        "# TYPE monshin_llm_chats counter",
        f"monshin_llm_chats {METRIC_LLM_CHATS}",
        "# HELP monshin_summaries Number of summaries generated",
        "# TYPE monshin_summaries counter",
        f"monshin_summaries {METRIC_SUMMARIES}",
        "",
    ]
    body = "\n".join(lines)
    return Response(content=body, media_type="text/plain; version=0.0.4")
