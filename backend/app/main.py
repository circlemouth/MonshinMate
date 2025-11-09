"""FastAPI バックエンドのエントリポイント。

問診テンプレート取得やチャット応答を含む簡易 API を提供する。
"""
from __future__ import annotations
from typing import Any, Iterable
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
from urllib.parse import urlparse
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

from fastapi import FastAPI, HTTPException, Response, Request, BackgroundTasks, Query, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import sqlite3
from pydantic import BaseModel, Field
import pyotp
import qrcode
from jose import JWTError, jwt
import httpx

from .llm_gateway import (
    LLMGateway,
    LLMSettings,
    ProviderProfile,
    DEFAULT_FOLLOWUP_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
)
from .llm_provider_registry import get_provider_meta_list, ProviderMetaSchema
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
)
from .validator import Validator
from .session_fsm import SessionFSM
from .structured_context import StructuredContextManager
from .pdf_renderer import PDFLayoutMode, render_session_pdf
from .personal_info import (
    format_lines as format_personal_info_lines,
    format_multiline as format_personal_info_multiline,
)
from .secret_manager import load_secrets
import logging
from logging.handlers import RotatingFileHandler
from .notifications import SessionEventBroker

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

# JWT settings for password reset
SECRET_KEY = os.getenv("SECRET_KEY", "a_very_secret_key_that_should_be_changed")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15

init_db()
app = FastAPI(title="MonshinMate API")

_allowed_origins = _resolve_allowed_origins()
if _allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins,
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
    if not isinstance(envelope, dict):
        raise HTTPException(status_code=400, detail="invalid_export_file")
    export_type = envelope.get("type")
    encryption = envelope.get("encryption")
    payload = envelope.get("payload")
    if encryption:
        if not password:
            raise HTTPException(status_code=400, detail="password_required")
        try:
            salt = base64.b64decode(encryption.get("salt") or "")
            iterations = int(encryption.get("iterations") or EXPORT_PBKDF_ITERATIONS)
            key_material = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), salt, iterations, dklen=32
            )
            cipher = Fernet(base64.urlsafe_b64encode(key_material))
            decrypted = cipher.decrypt(base64.b64decode(payload or ""))
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
            content = legacy_path.read_bytes() if legacy_path.exists() else None
        if not content:
            continue
        payloads[sanitized] = base64.b64encode(bytes(content)).decode("ascii")
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
    encoded = base64.b64encode(bytes(content)).decode("ascii")
    return f"/{SYSTEM_LOGO_STORAGE_SEGMENT}{sanitized}", {sanitized: encoded}


def _normalize_app_settings_for_transfer(settings: Any) -> tuple[dict[str, Any], dict[str, str]]:
    if not isinstance(settings, dict):
        return {}, {}
    normalized = dict(settings)
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
    sanitized = dict(settings)
    logo_url = sanitized.get("logo_url")
    if isinstance(logo_url, str):
        normalized_logo, _ = _canonicalize_logo_url(logo_url)
        if normalized_logo == "":
            sanitized.pop("logo_url", None)
        elif normalized_logo is not None:
            sanitized["logo_url"] = normalized_logo
    return sanitized



def _restore_logo_files(logo_payloads: Any, mode: str) -> int:
    if mode == "replace":
        for asset in list_binary_assets(SYSTEM_LOGO_CATEGORY):
            asset_id = asset.get("id")
            if asset_id:
                delete_binary_asset(SYSTEM_LOGO_CATEGORY, str(asset_id))
    if not logo_payloads:
        return 0
    if not isinstance(logo_payloads, dict):
        raise HTTPException(status_code=400, detail="invalid_logo_payload")
    restored = 0
    for name, encoded in logo_payloads.items():
        if not isinstance(name, str) or not isinstance(encoded, str):
            continue
        try:
            sanitized = _sanitize_image_filename(name)
        except ValueError:
            continue
        try:
            data = base64.b64decode(encoded)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid_logo_payload") from exc
        media_type = mimetypes.guess_type(sanitized)[0]
        save_binary_asset(
            SYSTEM_LOGO_CATEGORY,
            data,
            sanitized,
            content_type=media_type,
            asset_id=sanitized,
        )
        try:
            LOGO_DIR.mkdir(parents=True, exist_ok=True)
            (LOGO_DIR / sanitized).write_bytes(bytes(data))
        except Exception:
            logger.exception("failed_to_restore_logo_file filename=%s", sanitized)
        restored += 1
    return restored


def _restore_images(image_payloads: Any, mode: str) -> int:
    if mode == "replace":
        for asset in list_binary_assets(QUESTIONNAIRE_IMAGE_CATEGORY):
            asset_id = asset.get("id")
            if asset_id:
                delete_binary_asset(QUESTIONNAIRE_IMAGE_CATEGORY, str(asset_id))
    if not image_payloads:
        return 0
    if not isinstance(image_payloads, dict):
        raise HTTPException(status_code=400, detail="invalid_image_payload")
    restored = 0
    for name, encoded in image_payloads.items():
        if not isinstance(name, str) or not isinstance(encoded, str):
            continue
        try:
            sanitized = _sanitize_image_filename(name)
        except ValueError:
            continue
        try:
            data = base64.b64decode(encoded)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid_image_payload") from exc
        media_type = mimetypes.guess_type(sanitized)[0]
        save_binary_asset(
            QUESTIONNAIRE_IMAGE_CATEGORY,
            data,
            sanitized,
            content_type=media_type,
            asset_id=sanitized,
        )
        try:
            IMAGE_DIR.mkdir(parents=True, exist_ok=True)
            (IMAGE_DIR / sanitized).write_bytes(bytes(data))
        except Exception:
            logger.exception("failed_to_restore_image_file filename=%s", sanitized)
        restored += 1
    return restored



def _build_binary_asset_response(asset: dict[str, Any], fallback_name: str) -> Response:
    content = asset.get("content")
    if not isinstance(content, (bytes, bytearray)):
        raise HTTPException(status_code=404, detail="asset_not_found")
    filename = asset.get("filename") or fallback_name
    media_type = asset.get("content_type") or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    headers = {"Cache-Control": "public, max-age=86400"}
    if filename:
        headers["Content-Disposition"] = f"inline; filename={filename}"
    return Response(content=bytes(content), media_type=media_type, headers=headers)


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
        logger.exception("api_error path=%s method=%s", request.url.path, request.method)
        raise
    duration = (time.perf_counter() - start) * 1000
    logger.info(
        "api_call path=%s method=%s status=%d duration_ms=%.1f",
        request.url.path,
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
    # 既定テンプレート（initial/followup）を投入（存在すれば上書き）
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
    _ensure_default_prompts()
    # 保存済みの LLM 設定があれば読み込む
    try:
        stored = load_llm_settings()
        if stored:
            llm_gateway.update_settings(LLMSettings(**stored))
    except Exception:
        logging.getLogger(__name__).exception("failed to load stored llm settings; using defaults")
    llm_gateway.sync_status(reason="startup")

    logging.basicConfig(level=logging.INFO)
    logging.getLogger(__name__).info("startup completed")
    # 参考情報: adminユーザーの存在と初期パスワード判定を監査出力（ハッシュや平文は出さない）
    try:
        admin_user = get_user_by_username("admin")
        default_pw = os.getenv("ADMIN_PASSWORD", "admin")
        is_default_now = False
        try:
            if admin_user and admin_user.get("hashed_password"):
                is_default_now = verify_password(default_pw, admin_user.get("hashed_password"))
        except Exception:
            is_default_now = False
        logging.getLogger("security").info(
            "startup_admin_status exists=%s is_initial=%s default_pw_match=%s totp_enabled=%s totp_mode=%s db=%s",
            bool(admin_user),
            bool(admin_user.get("is_initial_password") if admin_user else None),
            bool(is_default_now),
            bool(admin_user.get("is_totp_enabled") if admin_user else None),
            (admin_user.get("totp_mode") if admin_user else None),
            DEFAULT_DB_PATH,
        )
    except Exception:
        logging.getLogger(__name__).exception("failed to log startup admin status")
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
session_events = SessionEventBroker()


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
        _ = list_templates()
        db_ok = True
    except Exception:
        pass

    if db_ok and llm_ok:
        return {"status": "ready"}

    return {"status": "not_ready", "detail": f"db={db_ok} llm={llm_ok} ({llm_detail})"}


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
        logger.exception("rename_template_failed", exc_info=exc)
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
def export_questionnaire_settings_api(payload: ExportRequest) -> StreamingResponse:
    """問診テンプレート設定一式をエクスポートする。"""

    data = export_questionnaire_settings()
    raw_templates = data.get("templates")
    normalized_templates, image_names = _normalize_templates_for_transfer(
        raw_templates if isinstance(raw_templates, list) else []
    )
    images = _load_image_payloads(image_names)
    export_payload = dict(data)
    export_payload["templates"] = normalized_templates
    export_payload["images"] = images
    app_settings = data.get("app_settings") if isinstance(data, dict) else None
    normalized_app_settings, logo_payloads = _normalize_app_settings_for_transfer(app_settings)
    export_payload["app_settings"] = normalized_app_settings
    export_payload["logo_files"] = logo_payloads
    envelope = _build_export_envelope(export_payload, "questionnaire_settings", payload.password or None)
    content = json.dumps(envelope, ensure_ascii=False, indent=2).encode("utf-8")
    filename = f"questionnaire-settings-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/admin/questionnaires/import")
async def import_questionnaire_settings_api(
    file: UploadFile = File(...), password: str | None = Form(None), mode: str = Form("merge")
) -> dict[str, Any]:
    """問診テンプレート設定一式をインポートする。"""

    raw = await file.read()
    export_type, payload = _parse_import_envelope(raw, password or None)
    if export_type != "questionnaire_settings":
        raise HTTPException(status_code=400, detail="invalid_export_type")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid_export_payload")
    mode_value = (mode or "merge").lower()
    if mode_value not in {"merge", "replace"}:
        raise HTTPException(status_code=400, detail="invalid_mode")
    payload_data = dict(payload)
    raw_templates = payload_data.get("templates")
    normalized_templates, _ = _normalize_templates_for_transfer(
        raw_templates if isinstance(raw_templates, list) else []
    )
    payload_data["templates"] = normalized_templates
    payload_data["app_settings"] = _sanitize_app_settings_payload(payload_data.get("app_settings"))
    images_payload = payload_data.pop("images", {}) or {}
    restored_images = _restore_images(images_payload, mode_value)
    logo_payload = payload_data.pop("logo_files", {}) or {}
    restored_logos = _restore_logo_files(logo_payload, mode_value)
    try:
        stats = import_questionnaire_settings(payload_data, mode=mode_value)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid_mode")
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc).lower():
            logger.warning("import_questionnaire_settings missing tables; re-running init_db()")
            init_db()
            stats = import_questionnaire_settings(payload_data, mode=mode_value)
        else:
            logger.exception("import_questionnaire_settings failed")
            raise
    try:
        stored_llm = load_llm_settings()
        if stored_llm:
            llm_gateway.update_settings(LLMSettings(**stored_llm))
            llm_gateway.settings.sync_from_active_profile()
    except Exception:
        logger.exception("apply_imported_llm_settings_failed")

    return {
        "status": "ok",
        "imported": stats,
        "images_restored": restored_images,
        "logos_restored": restored_logos,
        "mode": mode_value,
    }



def _migrate_legacy_assets() -> None:
    """ファイルシステムに残っている旧画像を DB へ移行する。"""
    migrated = 0
    try:
        if IMAGE_DIR.exists():
            for path in IMAGE_DIR.glob("*"):
                if not path.is_file():
                    continue
                try:
                    asset_id = _sanitize_image_filename(path.name)
                except ValueError:
                    continue
                if load_binary_asset(QUESTIONNAIRE_IMAGE_CATEGORY, asset_id):
                    continue
                data = path.read_bytes()
                if not data:
                    continue
                media_type = mimetypes.guess_type(asset_id)[0]
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
                if not path.is_file():
                    continue
                try:
                    asset_id = _sanitize_image_filename(path.name)
                except ValueError:
                    continue
                if load_binary_asset(SYSTEM_LOGO_CATEGORY, asset_id):
                    continue
                data = path.read_bytes()
                if not data:
                    continue
                media_type = mimetypes.guess_type(asset_id)[0]
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
        logger.exception("legacy_asset_migration_failed")
@app.post("/questionnaire-item-images")
def upload_questionnaire_item_image(file: UploadFile = File(...)) -> dict:
    """問診項目に添付する画像をアップロードし、URL を返す。"""
    suffix = Path(file.filename or "").suffix or ".png"
    raw_name = f"{uuid4().hex}{suffix}"
    try:
        sanitized = _sanitize_image_filename(raw_name)
    except ValueError:
        sanitized = _sanitize_image_filename(f"{uuid4().hex}.png")
    try:
        data = file.file.read()
    except Exception as exc:
        raise HTTPException(status_code=500, detail="failed_to_read_image") from exc
    if not data:
        raise HTTPException(status_code=400, detail="empty_image_payload")
    media_type = file.content_type or mimetypes.guess_type(sanitized)[0]
    save_binary_asset(
        QUESTIONNAIRE_IMAGE_CATEGORY,
        data,
        sanitized,
        content_type=media_type,
        asset_id=sanitized,
    )
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
def llm_chat(req: ChatRequest) -> ChatResponse:
    """LLM との対話を行う。"""

    global METRIC_LLM_CHATS
    METRIC_LLM_CHATS += 1
    return ChatResponse(reply=llm_gateway.chat(req.message))


@app.get("/llm/providers", response_model=list[ProviderMetaSchema])
def list_llm_providers() -> list[ProviderMetaSchema]:
    """利用可能な LLM プロバイダの一覧を返す。"""

    return get_provider_meta_list()


@app.get("/llm/settings", response_model=LLMSettings)
def get_llm_settings() -> LLMSettings:
    """現在の LLM 設定を取得する。

    原則としてDBに永続化された値を優先し、存在しない場合はメモリ上の設定を返す。
    これによりプロセス再起動後や他所での変更がUIに確実に反映される。
    """

    try:
        stored = load_llm_settings()
        if stored:
            # DB 側が真ならメモリへも反映して返す
            s = LLMSettings(**stored)
            llm_gateway.update_settings(s)
            llm_gateway.settings.sync_from_active_profile()
            return llm_gateway.settings
    except Exception:
        logger.exception("failed_to_load_llm_settings_on_get")
    llm_gateway.settings.sync_from_active_profile()
    return llm_gateway.settings


@app.put("/llm/settings", response_model=LLMSettings)
def update_llm_settings(settings: LLMSettings, background: BackgroundTasks) -> LLMSettings:
    """LLM 設定を更新する。必要条件を満たす場合は既存セッションのサマリーをBG再生成。"""
    # バリデーション: LLM を使用する場合はモデル名が必須
    if settings.enabled and (not settings.model or not str(settings.model).strip()):
        raise HTTPException(status_code=400, detail="LLM有効時はモデル名が必須です")

    settings.sync_to_active_profile()
    llm_gateway.update_settings(settings)
    try:
        # DB にも保存（永続化）
        save_llm_settings(settings.model_dump())
    except Exception:
        logger.exception("failed to persist llm settings")

    def _bg_regen_summaries() -> None:
        try:
            rows = db_list_sessions()
            for r in rows:
                sid = r.get("id")
                if not sid:
                    continue
                srow = db_get_session(sid)
                if not srow:
                    continue
                # finalized のみ対象
                if srow.get("completion_status") != "finalized":
                    continue
                # サマリー設定（テンプレID→default）
                cfg = get_summary_config(srow.get("questionnaire_id"), srow.get("visit_type")) or get_summary_config(
                    "default", srow.get("visit_type")
                )
                if not cfg or not bool(cfg.get("enabled")):
                    continue
                prompt = cfg.get("prompt") or ""
                # ラベルはテンプレから取得
                tpl = db_get_template(srow.get("questionnaire_id"), srow.get("visit_type")) or db_get_template(
                    "default", srow.get("visit_type")
                )
                labels = {}
                try:
                    for it in (tpl.get("items") or []):
                        labels[it.get("id")] = it.get("label")
                except Exception:
                    labels = {}
                # 生成（セッション単位で直列化・簡易リトライ付き）
                new_summary = llm_gateway.summarize_with_prompt(
                    prompt,
                    srow.get("answers", {}),
                    labels,
                    lock_key=sid,
                    retry=1,
                )
                # 保存（必要フィールドを埋めて save_session を再利用）
                from types import SimpleNamespace

                finalized_at_val = None

                try:

                    finalized_at = srow.get("finalized_at")

                    if finalized_at:

                        finalized_at_val = datetime.fromisoformat(finalized_at)

                except Exception:

                    finalized_at_val = None



                started_at_val = None

                try:

                    started_at_raw = srow.get("started_at")

                    if started_at_raw:

                        started_at_val = datetime.fromisoformat(started_at_raw)

                except Exception:

                    started_at_val = finalized_at_val



                session_obj = SimpleNamespace(
                    id=srow.get("id"),
                    patient_name=srow.get("patient_name"),
                    dob=srow.get("dob"),
                    # 保存には gender が必須
                    gender=srow.get("gender"),
                    visit_type=srow.get("visit_type"),
                    questionnaire_id=srow.get("questionnaire_id"),
                    answers=srow.get("answers", {}),
                    summary=new_summary,
                    remaining_items=srow.get("remaining_items", []),
                    completion_status=srow.get("completion_status"),
                    attempt_counts=srow.get("attempt_counts", {}),
                    additional_questions_used=srow.get("additional_questions_used", 0),
                    max_additional_questions=srow.get("max_additional_questions", 5),
                    # 追問プロンプトは空の可能性があるため、デフォルトを補う
                    followup_prompt=srow.get("followup_prompt") or DEFAULT_FOLLOWUP_PROMPT,
                    started_at=started_at_val,
                    finalized_at=finalized_at_val,
                )
                save_session(session_obj)
                logger.info("summary_regenerated id=%s", sid)
        except Exception:
            logger.exception("bg_regen_summaries_failed")

    # 保存後に疎通テストを実施（base_url 指定時のみ）。
    # 成功時のみバックグラウンドで再生成を起動
    try:
        if settings.enabled and settings.base_url:
            res = llm_gateway.test_connection(source="settings_put")
            if res.get("status") == "ok":
                background.add_task(_bg_regen_summaries)
            else:
                logging.getLogger("llm").warning(
                    "llm_settings_test_failed_on_save: %s", res.get("detail")
                )
    except HTTPException:
        raise
    except Exception:
        logger.exception("llm_settings_post_update_check_failed")
    llm_gateway.settings.sync_from_active_profile()
    return llm_gateway.settings


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
            logger.warning("llm_temp_settings_invalid_profile key=%s", key)
            continue
        try:
            existing[key] = ProviderProfile(**raw)
        except Exception as exc:  # noqa: BLE001 - バリデーション失敗のみ
            logger.warning("llm_temp_settings_profile_parse_failed key=%s error=%s", key, exc)
            continue
        changed = True
    if not changed:
        return
    settings.provider_profiles = existing
    try:
        settings.sync_from_active_profile()
    except Exception as exc:  # noqa: BLE001 - 一時設定の同期は警告に留める
        logger.warning(
            "llm_temp_settings_sync_failed provider=%s error=%s",
            settings.provider,
            exc,
        )


class LLMTestRequest(BaseModel):
    """LLM疎通テスト用の一時設定。"""

    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    enabled: bool | None = None
    provider_profiles: dict[str, dict[str, Any]] | None = None


@app.post("/llm/settings/test")
def test_llm_connection(req: LLMTestRequest | None = None) -> dict[str, str]:
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
        _apply_provider_profile_payload(temp, req.provider_profiles)
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
def list_llm_models(req: ListModelsRequest) -> list[str]:
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
    _apply_provider_profile_payload(temp_settings, req.provider_profiles)
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
        logger.exception("get_timezone_failed")
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
        logger.exception("validate_timezone_failed")
        raise HTTPException(status_code=500, detail="timezone_validation_failed") from exc

    try:
        current = load_app_settings() or {}
        current["timezone"] = timezone_value
        save_app_settings(current)
        return TimezoneSettings(timezone=current["timezone"])
    except Exception as exc:
        logger.exception("set_timezone_failed")
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
        logger.exception("get_display_name_failed")
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
        logger.exception("set_display_name_failed")
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
        logger.exception("get_completion_message_failed")
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
        logger.exception("set_completion_message_failed")
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
        logger.exception("get_entry_message_failed")
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
        logger.exception("set_entry_message_failed")
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
        logger.exception("get_theme_color_failed")
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
        logger.exception("set_theme_color_failed")
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
        logger.exception("get_system_logo_failed")
        return LogoSettings(url=None, crop=None)


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
        logger.exception("set_system_logo_failed")
        return payload


@app.post("/system-logo")
def upload_system_logo(file: UploadFile = File(...)) -> dict:
    """システムロゴ画像をアップロードし、参照 URL を返す。"""
    filename = Path(file.filename or "").name or f"logo_{uuid4().hex}.png"
    try:
        sanitized = _sanitize_image_filename(filename)
    except ValueError:
        sanitized = _sanitize_image_filename(f"logo_{uuid4().hex}.png")
    try:
        data = file.file.read()
    except Exception as exc:
        raise HTTPException(status_code=500, detail="failed_to_read_logo") from exc
    if not data:
        raise HTTPException(status_code=400, detail="empty_logo_payload")
    media_type = file.content_type or mimetypes.guess_type(sanitized)[0]
    save_binary_asset(
        SYSTEM_LOGO_CATEGORY,
        data,
        sanitized,
        content_type=media_type,
        asset_id=sanitized,
    )
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
        logger.exception("get_pdf_layout_failed")
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
        logger.exception("set_pdf_layout_failed")
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
        logger.exception("get_default_questionnaire_failed")
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
        logger.exception("set_default_questionnaire_failed")
        return payload


class DatabaseStatus(BaseModel):
    """使用中のデータベース状態。"""

    status: str


class LLMStatusResponse(BaseModel):
    """LLM 通信状態のスナップショット。"""

    status: str
    detail: str | None = None
    source: str | None = None
    checked_at: datetime | None = None


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
def get_llm_status_snapshot() -> LLMStatusResponse:
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


# --- 管理者認証 API ---

class AdminLoginRequest(BaseModel):
    """管理者ログインリクエスト。"""
    password: str

class AdminLoginTotpRequest(BaseModel):
    """管理者ログイン時のTOTPコード。"""
    totp_code: str

class AdminPasswordSetRequest(BaseModel):
    """管理者パスワード設定リクエスト。"""
    password: str


class AdminPasswordChangeRequest(BaseModel):
    """管理者パスワード変更リクエスト。"""
    current_password: str
    new_password: str

class AdminAuthStatus(BaseModel):
    """管理者認証の状態。"""
    is_initial_password: bool
    is_totp_enabled: bool
    totp_mode: str | None = None
    # 非常用リセット用の環境変数が構成されているか
    emergency_reset_available: bool | None = None


class TotpVerifyRequest(BaseModel):
    """TOTP検証リクエスト。"""
    totp_code: str
    use_for_login: bool = True


class PasswordResetRequest(BaseModel):
    """パスワードリセットリクエスト（TOTPコードを含む）。"""
    totp_code: str


class PasswordResetConfirm(BaseModel):
    """パスワードリセットの確認。"""
    token: str
    new_password: str

class EmergencyPasswordResetRequest(BaseModel):
    """非常用パスワードを用いたリセット要求。

    二段階認証（TOTP）が無効の場合のみ使用可能。
    環境変数 `ADMIN_EMERGENCY_RESET_PASSWORD` に設定されたパスワードと一致した場合、
    管理者パスワードを新しい値に更新する。
    """
    emergency_password: str
    new_password: str


@app.get("/admin/auth/status", response_model=AdminAuthStatus)
def get_admin_auth_status() -> AdminAuthStatus:
    """管理者の認証状態（初期パスワードか、TOTPが有効か）を返す。"""
    admin_user = get_user_by_username("admin")
    if not admin_user:
        raise HTTPException(status_code=500, detail="Admin user not found")
    # フラグの信頼性に加えて、実際に現在のパスワードが 'admin' と一致するかも検査する。
    # これによりフラグの取り違え・移行漏れがあっても初期パスワード状態を確実に検出できる。
    try:
        hashed = admin_user.get("hashed_password")
        is_default_now = False
        if hashed:
            # 既定初期パスワードは 'admin'。必要に応じて環境変数で上書きする設計に拡張可能。
            # 環境変数が設定されていない場合は 'admin' を既定とする。
            default_pw = os.getenv("ADMIN_PASSWORD", "admin")
            is_default_now = verify_password(default_pw, hashed)
    except Exception:
        is_default_now = False

    result = AdminAuthStatus(
        is_initial_password=is_default_now,
        is_totp_enabled=bool(admin_user.get("is_totp_enabled")),
        totp_mode=get_totp_mode("admin"),
        emergency_reset_available=bool(os.getenv("ADMIN_EMERGENCY_RESET_PASSWORD")),
    )
    try:
        logging.getLogger("security").info(
            "auth_status is_initial=%s is_totp_enabled=%s totp_mode=%s",
            result.is_initial_password,
            result.is_totp_enabled,
            result.totp_mode,
        )
    except Exception:
        pass
    return result


@app.post("/admin/password")
def admin_set_password(payload: AdminPasswordSetRequest) -> dict:
    """管理者パスワードを更新する。"""
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long")
    admin_user = get_user_by_username("admin")
    if not admin_user:
        raise HTTPException(status_code=500, detail="Admin user not found")
    # 初期セットアップ時のみ直接のパスワード更新を許可（それ以外はTOTPリセットフローを使用）
    default_pw = os.getenv("ADMIN_PASSWORD", "admin")
    is_default_now = False
    try:
        is_default_now = verify_password(default_pw, admin_user.get("hashed_password"))
    except Exception:
        is_default_now = False
    if not is_default_now:
        raise HTTPException(status_code=403, detail="Direct password change is not allowed. Use reset flow.")
    # 初期セットアップ時の直接更新。監査ログは db.update_password 内で出力される。
    update_password("admin", payload.password)
    try:
        logging.getLogger("security").warning("admin_password_set_direct")
    except Exception:
        pass
    return {"status": "ok"}


@app.post("/admin/password/change")
def admin_change_password(payload: AdminPasswordChangeRequest) -> dict:
    """現在のパスワードを検証したうえで新しいパスワードに変更する。"""
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long")
    admin_user = get_user_by_username("admin")
    if not admin_user or not verify_password(payload.current_password, admin_user["hashed_password"]):
        try:
            logging.getLogger("security").warning("admin_password_change_failed")
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="現在のパスワードが正しくありません")
    update_password("admin", payload.new_password)
    try:
        if admin_user.get("is_totp_enabled"):
            set_totp_status("admin", enabled=False, clear_secret=True)
            logging.getLogger("security").warning("totp_disabled_due_to_password_change username=admin")
    except Exception:
        logging.getLogger(__name__).exception("failed to disable totp on password change")
    return {"status": "ok"}


@app.post("/admin/login")
def admin_login(payload: AdminLoginRequest) -> dict:
    """管理画面へのログイン（パスワード検証）。"""
    admin_user = get_user_by_username("admin")
    if not admin_user or not verify_password(payload.password, admin_user["hashed_password"]):
        try:
            logging.getLogger("security").info("admin_login_failed")
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="パスワードが間違っています")

    mode = get_totp_mode("admin")
    if admin_user.get("is_totp_enabled") and not admin_user.get("totp_secret"):
        # シークレットが存在しないのにフラグだけ有効な場合は自動的に無効化
        set_totp_status("admin", enabled=False)
        mode = "off"
        try:
            logging.getLogger("security").warning("totp_disabled_missing_secret username=admin")
        except Exception:
            pass

    # ログイン時にTOTPを要求するのは totp_mode が 'login_and_reset' の場合のみ
    if mode == "login_and_reset":
        try:
            logging.getLogger("security").info("admin_login_password_ok_totp_required")
        except Exception:
            pass
        return {"status": "totp_required"}

    # 認証成功（本来はセッションやJWTを発行）
    try:
        logging.getLogger("security").info("admin_login_success")
    except Exception:
        pass
    try:
        llm_gateway.test_connection(source="admin_login")
    except Exception:
        logging.getLogger(__name__).exception("llm_status_update_failed_on_login")
    return {"status": "ok", "message": "Login successful"}


@app.post("/admin/login/totp")
def admin_login_totp(payload: AdminLoginTotpRequest) -> dict:
    """管理画面へのログイン（TOTP検証）。"""
    admin_user = get_user_by_username("admin")
    if not admin_user or not admin_user["totp_secret"]:
        raise HTTPException(status_code=401, detail="Unauthorized")

    totp = pyotp.TOTP(admin_user["totp_secret"])
    if not totp.verify(payload.totp_code):
        try:
            logging.getLogger("security").info("admin_login_totp_failed")
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    try:
        logging.getLogger("security").info("admin_login_totp_success")
    except Exception:
        pass
    try:
        llm_gateway.test_connection(source="admin_login_totp")
    except Exception:
        logging.getLogger(__name__).exception("llm_status_update_failed_on_login_totp")
    return {"status": "ok", "message": "Login successful"}


@app.get("/admin/totp/setup")
def admin_totp_setup() -> StreamingResponse:
    """TOTP設定用のQRコードを生成して返す。"""
    admin_user = get_user_by_username("admin")
    if not admin_user:
        raise HTTPException(status_code=500, detail="Admin user not found")

    # 既存のシークレットがある場合は再利用し、なければ新規生成する
    secret = admin_user.get("totp_secret")
    if not secret:
        secret = pyotp.random_base32()
        update_totp_secret("admin", secret)

    # プロビジョニングURIを生成
    uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name="admin@MonshinMate", issuer_name="MonshinMate"
    )

    # QRコードを画像として生成
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)

    return StreamingResponse(buf, media_type="image/png")


@app.post("/admin/totp/verify")
def admin_totp_verify(payload: TotpVerifyRequest) -> dict:
    """提供されたTOTPコードを検証し、有効化する。"""
    admin_user = get_user_by_username("admin")
    if not admin_user or not admin_user["totp_secret"]:
        raise HTTPException(status_code=400, detail="TOTP secret not found")

    totp = pyotp.TOTP(admin_user["totp_secret"])
    # 多少の時計ずれを許容（前後1ステップ）
    if not totp.verify(payload.totp_code, valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    # 検証成功、TOTPを有効化
    set_totp_status("admin", enabled=True)

    # TOTPの利用モードを設定
    if payload.use_for_login:
        set_totp_mode("admin", "login_and_reset")
    else:
        set_totp_mode("admin", "reset_only")

    try:
        logging.getLogger("security").warning(
            "totp_enabled username=admin use_for_login=%s", payload.use_for_login
        )
    except Exception:
        pass
    return {"status": "ok"}

@app.post("/admin/totp/disable")
def admin_totp_disable(payload: TotpVerifyRequest) -> dict:
    """TOTP を無効化する（管理操作）。

    セキュリティ上の理由から、無効化時には現在の TOTP コードを要求し、
    正しいコードが入力された場合のみ無効化を実行する。
    """
    admin_user = get_user_by_username("admin")
    if not admin_user:
        raise HTTPException(status_code=500, detail="Admin user not found")

    # シークレットが存在しない、もしくは未有効の場合は操作不可
    if not admin_user.get("totp_secret") or not admin_user.get("is_totp_enabled"):
        raise HTTPException(status_code=400, detail="TOTP is not enabled for this account")

    # 入力された TOTP コードを検証
    totp = pyotp.TOTP(admin_user["totp_secret"])
    if not totp.verify(payload.totp_code, valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    # 無効化時に既存のシークレットも削除する
    set_totp_status("admin", enabled=False, clear_secret=True)
    try:
        logging.getLogger("security").warning("totp_disabled username=admin")
    except Exception:
        pass
    return {"status": "ok"}

@app.post("/admin/totp/regenerate")
def admin_totp_regenerate() -> dict:
    """TOTP の秘密鍵を再生成し、いったん無効化する。新しいQRで再設定が必要。"""
    admin_user = get_user_by_username("admin")
    if not admin_user:
        raise HTTPException(status_code=500, detail="Admin user not found")
    secret = pyotp.random_base32()
    update_totp_secret("admin", secret)
    set_totp_status("admin", enabled=False)
    try:
        logging.getLogger("security").warning("totp_regenerated_and_disabled username=admin")
    except Exception:
        pass
    return {"status": "ok"}

@app.post("/admin/password/reset/request")
def request_password_reset(payload: PasswordResetRequest) -> dict:
    """TOTPを検証し、パスワードリセット用のトークンを発行する。"""
    admin_user = get_user_by_username("admin")
    # TOTPの利用モードが 'off' の場合はリセット要求不可
    mode = get_totp_mode("admin")
    if not admin_user or mode == "off" or not admin_user["totp_secret"]:
        raise HTTPException(status_code=400, detail="TOTP is not enabled for this account")

    totp = pyotp.TOTP(admin_user["totp_secret"])
    if not totp.verify(payload.totp_code):
        try:
            logging.getLogger("security").info("password_reset_request_totp_failed")
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    # トークンを生成
    expire = datetime.now(UTC) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode = {"sub": "admin", "exp": expire}
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    try:
        logging.getLogger("security").warning("password_reset_token_issued exp_minutes=%s", ACCESS_TOKEN_EXPIRE_MINUTES)
    except Exception:
        pass
    return {"reset_token": encoded_jwt}


@app.post("/admin/password/reset/confirm")
def confirm_password_reset(payload: PasswordResetConfirm) -> dict:
    """リセットトークンを検証し、パスワードを更新する。"""
    try:
        decoded_token = jwt.decode(payload.token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str | None = decoded_token.get("sub")
        if username != "admin":
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    # 新しいパスワードのバリデーション
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long")

    # リセットトークンを介した更新。監査ログは db.update_password 内で出力される。
    update_password("admin", payload.new_password)
    try:
        logging.getLogger("security").warning("password_reset_confirmed username=admin")
    except Exception:
        pass
    return {"status": "ok", "message": "Password has been reset successfully"}


@app.post("/admin/password/reset/emergency")
def emergency_password_reset(payload: EmergencyPasswordResetRequest) -> dict:
    """TOTP 無効時に、環境変数ベースの非常用パスワードでリセットする。

    前提:
    - 環境変数 `ADMIN_EMERGENCY_RESET_PASSWORD` が設定されていること。
    - 管理者の TOTP が無効（`is_totp_enabled=0` または `totp_mode='off'`）であること。
    セキュリティ上、成功時には TOTP を無効化し、再設定を促す運用を想定する。
    """
    admin_user = get_user_by_username("admin")
    if not admin_user:
        raise HTTPException(status_code=500, detail="Admin user not found")

    # TOTP が無効であることを確認
    mode = get_totp_mode("admin")
    if admin_user.get("is_totp_enabled") or mode != "off":
        raise HTTPException(status_code=403, detail="Emergency reset is allowed only when TOTP is disabled")

    emergency_pw = os.getenv("ADMIN_EMERGENCY_RESET_PASSWORD")
    if not emergency_pw:
        raise HTTPException(status_code=400, detail="Emergency reset password is not configured")

    if payload.emergency_password != emergency_pw:
        try:
            logging.getLogger("security").warning("emergency_reset_failed_bad_password")
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="Unauthorized")

    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long")

    # パスワード更新と TOTP の無効化（秘密のクリア）
    update_password("admin", payload.new_password)
    try:
        set_totp_status("admin", enabled=False, clear_secret=True)
        logging.getLogger("security").warning("emergency_password_reset username=admin")
    except Exception:
        logging.getLogger(__name__).exception("failed to disable totp on emergency reset")
    return {"status": "ok", "message": "Password has been reset successfully"}


class TotpModePayload(BaseModel):
    mode: str  # 'off' | 'reset_only' | 'login_and_reset'


@app.get("/admin/totp/mode")
def get_admin_totp_mode() -> dict:
    """現在の TOTP モードを返す。"""
    return {"mode": get_totp_mode("admin")}


@app.put("/admin/totp/mode")
def set_admin_totp_mode(payload: TotpModePayload) -> dict:
    """TOTP の利用モードを設定する。"""
    try:
        set_totp_mode("admin", payload.mode)
        try:
            logging.getLogger("security").warning("totp_mode_set username=admin mode=%s", payload.mode)
        except Exception:
            pass
        return {"status": "ok", "mode": get_totp_mode("admin")}
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid totp mode")




class SessionCreateRequest(BaseModel):
    """セッション作成時に受け取る情報。"""

    patient_name: str
    dob: str
    gender: str
    visit_type: str
    answers: dict[str, Any]
    questionnaire_id: str | None = None


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


class SessionCreateResponse(BaseModel):
    """セッション作成時のレスポンス。"""

    id: str
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


class SessionFinalizeEvent(BaseModel):
    """問診完了時のイベント通知用レスポンス。"""

    id: str
    patient_name: str | None = None
    dob: str | None = None
    visit_type: str | None = None
    started_at: str | None = None
    finalized_at: str


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
            logger.exception("get_default_questionnaire_failed_in_session_create")
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
    sessions[session_id] = session
    save_session(session)
    global METRIC_SESSIONS_CREATED
    METRIC_SESSIONS_CREATED += 1
    logger.info("session_created id=%s visit_type=%s", session_id, req.visit_type)
    return SessionCreateResponse(
        id=session.id,
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
    session = sessions.get(session_id)
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


@app.post("/sessions/{session_id}/llm-answers")
def submit_llm_answer(session_id: str, req: LlmAnswerRequest) -> dict:
    """追加質問への回答を保存する。"""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    fsm = SessionFSM(session, llm_gateway)
    fsm.step(req.item_id, req.answer)
    global METRIC_ANSWERS_RECEIVED
    METRIC_ANSWERS_RECEIVED += 1
    save_session(session)
    logger.info("llm_answer_saved id=%s item=%s", session_id, req.item_id)
    return {"status": "ok", "remaining_items": session.remaining_items}


@app.post("/sessions/{session_id}/llm-questions")
def get_llm_questions(session_id: str) -> dict:
    """不足項目に応じた追加質問を返す。"""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    fsm = SessionFSM(session, llm_gateway)
    questions = fsm.next_questions()
    save_session(session)
    if not questions:
        logger.info("llm_question_limit id=%s", session_id)
        return {"questions": []}
    for q in questions:
        logger.info("llm_question id=%s item=%s", session_id, q["id"])
    return {"questions": questions}


@app.post("/sessions/{session_id}/finalize")
async def finalize_session(
    session_id: str, background: BackgroundTasks, payload: FinalizeRequest | None = None
) -> dict:
    """セッションを確定し要約を返す。"""

    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    SessionFSM(session, llm_gateway).update_completion()
    # サマリー生成の有効設定（テンプレID→default の順に確認）
    cfg = get_summary_config(session.questionnaire_id, session.visit_type) or get_summary_config(
        "default", session.visit_type
    )
    summary_enabled = bool(cfg and cfg.get("enabled"))
    # 必須が未完了の場合も、フェイルセーフとして現状で要約を返し進行可能とする
    if summary_enabled:
        session.summary = llm_gateway.summarize(session.answers)
        global METRIC_SUMMARIES
        METRIC_SUMMARIES += 1
    else:
        session.summary = ""
    if payload and payload.llm_error:
        suffix = f"[LLMエラー]: {payload.llm_error}"
        session.summary = f"{session.summary}\n{suffix}" if session.summary else suffix
    if not session.started_at:
        session.started_at = datetime.now(UTC)
    session.finalized_at = datetime.now(UTC)
    session.interrupted = False
    session.completion_status = "finalized"
    logger.info("session_finalized id=%s", session_id)
    save_session(session)
    event = _build_finalize_event_from_session(session)
    try:
        await session_events.publish(event.dict(), event_id=event.finalized_at)
    except Exception:
        logger.exception("session_finalize_event_publish_failed id=%s", session_id)
    # LLM が有効かつ base_url が設定されている場合、バックグラウンドで詳細サマリーを生成
    def _bg_summary_task(sid: str) -> None:
        s = sessions.get(sid)
        if not s:
            return
        labels = {it.id: it.label for it in s.template_items}
        prompt = (
            get_summary_prompt(s.questionnaire_id, s.visit_type)
            or get_summary_prompt("default", s.visit_type)
            or (
                "以下の問診項目と回答をもとに、簡潔で読みやすい日本語のサマリーを作成してください。"
                "重要項目（主訴・発症時期）は冒頭にまとめてください。"
            )
        )
        if getattr(llm_gateway.settings, "enabled", True):
            new_summary = llm_gateway.summarize_with_prompt(
                prompt,
                s.answers,
                labels,
                lock_key=sid,
                retry=1,
            )
            s.summary = new_summary
            save_session(s)

    if summary_enabled and llm_gateway.has_remote_backend() and not (payload and payload.llm_error):
        background.add_task(_bg_summary_task, session.id)

    return {
        "summary": session.summary,
        "answers": session.answers,
        "finalized_at": session.finalized_at.isoformat(),
        "status": session.completion_status,
    }


@app.post("/admin/sessions/export")
def export_sessions_api(payload: SessionsExportRequest) -> StreamingResponse:
    """問診結果データをエクスポートする。"""

    sessions_data = export_sessions_data(
        session_ids=payload.session_ids,
        start_date=payload.start_date,
        end_date=payload.end_date,
    )
    export_payload = {
        "sessions": sessions_data,
        "count": len(sessions_data),
        "filters": {
            "session_ids": payload.session_ids or None,
            "start_date": payload.start_date,
            "end_date": payload.end_date,
        },
    }
    envelope = _build_export_envelope(export_payload, "session_data", payload.password or None)
    content = json.dumps(envelope, ensure_ascii=False, indent=2).encode("utf-8")
    filename = f"sessions-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/admin/sessions/import")
async def import_sessions_api(
    file: UploadFile = File(...), password: str | None = Form(None), mode: str = Form("merge")
) -> dict[str, Any]:
    """問診結果データをインポートする。"""

    raw = await file.read()
    export_type, payload = _parse_import_envelope(raw, password or None)
    if export_type != "session_data":
        raise HTTPException(status_code=400, detail="invalid_export_type")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid_export_payload")
    sessions_payload = payload.get("sessions") or []
    if not isinstance(sessions_payload, list):
        raise HTTPException(status_code=400, detail="invalid_export_payload")
    mode_value = (mode or "merge").lower()
    if mode_value not in {"merge", "replace"}:
        raise HTTPException(status_code=400, detail="invalid_mode")
    try:
        stats = import_sessions_data(sessions_payload, mode=mode_value)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid_mode")
    return {
        "status": "ok",
        "imported": stats,
        "mode": mode_value,
        "count": len(sessions_payload),
    }


@app.get("/admin/sessions/stream")
async def admin_session_stream(
    request: Request,
    since: str | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
) -> StreamingResponse:
    """問診完了イベントを Server-Sent Events で配信する。"""

    last_event_id = request.headers.get("last-event-id")
    since_candidate = last_event_id or since or None
    since_dt: datetime | None = None
    if since_candidate:
        try:
            since_dt = datetime.fromisoformat(since_candidate)
        except Exception:
            raise HTTPException(status_code=400, detail="invalid_since")

    backlog_messages: list[bytes] = []
    if since_dt is not None:
        events, _ = list_sessions_finalized_after(since_dt, limit=limit)
        for event in events:
            finalized = event.get("finalized_at")
            session_id = event.get("id")
            if not finalized or not session_id:
                continue
            payload = SessionFinalizeEvent(
                id=str(session_id),
                patient_name=event.get("patient_name"),
                dob=event.get("dob"),
                visit_type=event.get("visit_type"),
                started_at=_ensure_isoformat(event.get("started_at")),
                finalized_at=str(finalized),
            )
            backlog_messages.append(
                session_events.serialize(payload.dict(), event_id=payload.finalized_at)
            )

    async def event_generator() -> Iterable[bytes]:
        for message in backlog_messages:
            yield message
        stream = session_events.stream()
        try:
            async for message in stream:
                if await request.is_disconnected():
                    break
                yield message
        finally:
            await stream.aclose()

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/admin/sessions", response_model=list[SessionSummary])
def admin_list_sessions(
    patient_name: str | None = None,
    dob: str | None = None,
    start_date: str | None = Query(None, alias="start_date"),
    end_date: str | None = Query(None, alias="end_date"),
) -> list[SessionSummary]:
    """保存済みセッションの一覧を返す。"""
    sessions = db_list_sessions(
        patient_name=patient_name,
        dob=dob,
        start_date=start_date,
        end_date=end_date,
    )
    return [SessionSummary(**s) for s in sessions]


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

    def sanitize_filename(name: str) -> str:
        name = re.sub(r"[\\/:*?\"<>|]", "_", name)
        name = name.strip().replace(" ", "_")
        return name or "session"

    # CSV は「全件を1枚の集計CSV」で返す
    if fmt == "csv":
        sbuf = io.StringIO()
        writer = csv.writer(sbuf)
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
            headers={"Content-Disposition": f"attachment; filename=sessions-{ts}.csv"},
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
                pdf_bytes = render_session_pdf(
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
        headers={"Content-Disposition": f"attachment; filename=sessions-{ts}.zip"},
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
            headers={"Content-Disposition": f"attachment; filename=session-{session_id}.md"},
        )
    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["項目", "回答"])
        for label, ans in rows:
            writer.writerow([label, ans])
        content = buf.getvalue()
        return Response(
            content,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename=session-{session_id}.csv"},
        )
    if fmt == "pdf":
        layout_mode, facility_name = _resolve_pdf_render_config()
        pdf_bytes = render_session_pdf(
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
            headers={"Content-Disposition": f"attachment; filename=session-{session_id}.pdf"},
        )
    raise HTTPException(status_code=400, detail="unsupported format")


@app.delete("/admin/sessions/{session_id}")
def admin_delete_session(session_id: str) -> dict[str, Any]:
    """指定セッションを削除する。"""
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


# --- UI メトリクス受け口（匿名・院内向け） ---
class UiMetricEvents(BaseModel):
    events: list[dict]


@app.post("/metrics/ui")
def metrics_ui(payload: UiMetricEvents) -> dict:
    """UI 側の匿名イベントを受け取り、ログに記録する。

    -個人特定情報は送らない前提。
    - 必要に応じてファイルやDBへ積む設計に拡張可能。
    """
    try:
        count = len(payload.events)
    except Exception:
        count = 0
    logger.info("ui_metrics received=%d", count)
    return {"status": "ok", "received": count}



















