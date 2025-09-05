"""FastAPI バックエンドのエントリポイント。

問診テンプレート取得やチャット応答を含む簡易 API を提供する。
"""
from __future__ import annotations
from typing import Any
from uuid import uuid4
import time
from datetime import datetime, timedelta, UTC
import os
import io
import zipfile
import re
import csv
import json
try:
    from dotenv import load_dotenv
except Exception:  # ランタイム環境に dotenv が無い場合でも起動を継続
    def load_dotenv(*_args, **_kwargs):  # type: ignore
        return False

from fastapi import FastAPI, HTTPException, Response, Request, BackgroundTasks, Query
from fastapi.responses import StreamingResponse
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.pagesizes import A4
import sqlite3
from pydantic import BaseModel, Field
import pyotp
import qrcode
from jose import JWTError, jwt

from .llm_gateway import (
    LLMGateway,
    LLMSettings,
    DEFAULT_FOLLOWUP_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
)
from .db import (
    init_db,
    upsert_template,
    get_template as db_get_template,
    list_templates,
    delete_template,
    save_session,
    list_sessions as db_list_sessions,
    get_session as db_get_session,
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
)
from .validator import Validator
from .session_fsm import SessionFSM
from .structured_context import StructuredContextManager
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

# .env の読み込み（backend/.env を優先的に参照）
_BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(_BASE_DIR / ".env")

# JWT settings for password reset
SECRET_KEY = os.getenv("SECRET_KEY", "a_very_secret_key_that_should_be_changed")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15

init_db()
app = FastAPI(title="MonshinMate API")

logger = logging.getLogger("api")

# サマリー生成用のデフォルトプロンプト
DEFAULT_SUMMARY_PROMPT = (
    "あなたは医療記録作成の専門家です。"
    "以下の問診項目と回答をもとに、患者情報を正確かつ簡潔な日本語のサマリーにまとめてください。"
    "主訴と発症時期などの重要事項を冒頭に記載し、その後に関連情報を読みやすく整理してください。"
    "推測や不要な前置きは避け、医療従事者がすぐ理解できる表現を用いてください。"
)


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


@app.on_event("startup")
def on_startup() -> None:
    """アプリ起動時の初期化処理。DB 初期化とデフォルトテンプレ投入。"""
    init_db()
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
    initial_items = [
        # 氏名・生年月日はセッション作成時に別途入力するためテンプレートから除外
        {"id": "postal_code", "label": "郵便番号を記入してください。", "type": "string", "required": True},
        {"id": "address", "label": "住所を記入してください。", "type": "string", "required": True},
        {"id": "phone", "label": "電話番号を記入してください。", "type": "string", "required": True},
        {
            "id": "chief_complaint",
            "label": "どういった症状で受診されましたか？",
            "type": "string",
            "required": True,
            "description": "できるだけ具体的にご記入ください（例：3日前から左ひざが痛い）。",
        },
        {
            "id": "symptom_location",
            "label": "症状があるのはどこですか？",
            "type": "multi",
            "options": ["顔", "首", "体", "手足"],
            "allow_freetext": True,
            "required": True,
        },
        {
            "id": "onset",
            "label": "いつから症状がありますか？",
            "type": "multi",
            "options": ["昨日から", "1週間前から", "1ヶ月前から"],
            "allow_freetext": True,
            "required": True,
            "description": "わかる範囲で構いません（例：今朝から、1週間前から など）。",
        },
        {
            "id": "prior_treatments",
            "label": "その症状について、これまで治療を受けたことがあれば、受けた治療を選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "外用薬",
                "内服薬",
                "注射",
                "手術",
                "リハビリ",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "past_diseases",
            "label": "今までにかかったことのある病気を選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "高血圧",
                "糖尿病",
                "脂質異常症",
                "喘息",
                "アトピー性皮膚炎",
                "花粉症",
                "蕁麻疹",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "surgeries",
            "label": "手術歴があれば選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "皮膚科関連手術",
                "整形外科手術",
                "腹部手術",
                "心臓手術",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "current_medications",
            "label": "現在服用している処方薬があれば選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "ステロイド外用",
                "抗菌薬（内服/外用）",
                "抗ヒスタミン薬",
                "NSAIDs",
                "免疫抑制薬",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "supplements_otc",
            "label": "現在使用しているサプリメント/市販薬があれば選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "ビタミン剤",
                "漢方",
                "鎮痛解熱薬",
                "かゆみ止め",
                "保湿剤",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "drug_allergies",
            "label": "薬剤アレルギーがあれば選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "ペニシリン系",
                "セフェム系",
                "マクロライド系",
                "ニューキノロン系",
                "NSAIDs",
                "局所麻酔",
                "その他",
                "不明",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "food_metal_allergies",
            "label": "食物・金属などのアレルギーがあれば選んでください。",
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
                "その他",
                "不明",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "smoking",
            "label": "タバコは吸いますか？",
            "type": "multi",
            "options": ["吸わない", "時々吸う", "毎日吸う"],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "alcohol",
            "label": "お酒はのみますか？",
            "type": "multi",
            "options": ["のまない", "ときどき", "よく飲む"],
            "allow_freetext": True,
            "required": False,
        },
        {"id": "pregnancy", "label": "妊娠中ですか？", "type": "yesno", "required": False, "gender": "female"},
        {"id": "breastfeeding", "label": "授乳中ですか？", "type": "yesno", "required": False, "gender": "female"},
    ]
    followup_items = [
        {
            "id": "chief_complaint",
            "label": "どういった症状で受診されましたか？",
            "type": "string",
            "required": True,
            "description": "できるだけ具体的にご記入ください（例：3日前から左ひざが痛い）。",
        },
        {
            "id": "symptom_location",
            "label": "症状があるのはどこですか？",
            "type": "multi",
            "options": ["顔", "首", "体", "手足"],
            "allow_freetext": True,
            "required": True,
        },
        {
            "id": "onset",
            "label": "いつからの症状ですか？",
            "type": "multi",
            "options": ["昨日から", "1週間前から", "1ヶ月前から"],
            "allow_freetext": True,
            "required": True,
            "description": "わかる範囲で構いません（例：今朝から、1週間前から など）。",
        },
    ]
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
    # サマリープロンプト（初診・再診）を既定値で投入（存在すれば上書き）
    upsert_summary_prompt("default", "initial", DEFAULT_SUMMARY_PROMPT, False)
    upsert_summary_prompt("default", "followup", DEFAULT_SUMMARY_PROMPT, False)
    upsert_followup_prompt("default", "initial", DEFAULT_FOLLOWUP_PROMPT, False)
    upsert_followup_prompt("default", "followup", DEFAULT_FOLLOWUP_PROMPT, False)
    # 保存済みの LLM 設定があれば読み込む
    try:
        stored = load_llm_settings()
        if stored:
            llm_gateway.update_settings(LLMSettings(**stored))
    except Exception:
        logging.getLogger(__name__).exception("failed to load stored llm settings; using defaults")

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

default_llm_settings = LLMSettings(
    provider="ollama",
    model="llama2",
    temperature=0.2,
    system_prompt=DEFAULT_SYSTEM_PROMPT,
    enabled=False,
    # 初期値としてローカルの Ollama 既定ポートを設定
    base_url="http://localhost:11434",
)
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
    llm_ok = not llm_gateway.settings.enabled
    llm_detail = "disabled" if not llm_gateway.settings.enabled else "not_checked"
    try:
        _ = list_templates()
        db_ok = True
    except Exception:
        pass

    if llm_gateway.settings.enabled and llm_gateway.settings.base_url:
        try:
            res = llm_gateway.test_connection()
            if res.get("status") == "ok":
                llm_ok = True
            llm_detail = res.get("detail", "ng")
        except Exception as e:
            llm_detail = str(e)
    elif llm_gateway.settings.enabled and not llm_gateway.settings.base_url:
        # ベースURL未指定時は LLM を必須依存とみなさず ready を優先
        llm_ok = True
        llm_detail = "base_url_missing_skipped"

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
    gender: str | None = None
    demographic_enabled: bool = False
    min_age: int | None = None
    max_age: int | None = None
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
            "llm_followup_enabled": True,
            "llm_followup_max_questions": 5,
        }
        # 呼び出し互換のため、要求された ID をそのまま設定
        items = []
        for it in default_tpl["items"]:
            if "demographic_enabled" not in it:
                it["demographic_enabled"] = bool(it.get("gender"))
            items.append(QuestionnaireItem(**it))
        if gender or age is not None:
            items = [
                it
                for it in items
                if not it.demographic_enabled
                or (
                    (not it.gender or it.gender == "both" or it.gender == gender)
                    and (age is None or it.min_age is None or age >= it.min_age)
                    and (age is None or it.max_age is None or age <= it.max_age)
                )
            ]
        return Questionnaire(
            id=questionnaire_id,
            items=items,
            llm_followup_enabled=bool(default_tpl.get("llm_followup_enabled", True)),
            llm_followup_max_questions=int(default_tpl.get("llm_followup_max_questions", 5)),
        )
    items = []
    for it in tpl["items"]:
        if "demographic_enabled" not in it:
            it["demographic_enabled"] = bool(it.get("gender"))
        items.append(QuestionnaireItem(**it))
    if gender or age is not None:
        items = [
            it
            for it in items
            if not it.demographic_enabled
            or (
                (not it.gender or it.gender == "both" or it.gender == gender)
                and (age is None or it.min_age is None or age >= it.min_age)
                and (age is None or it.max_age is None or age <= it.max_age)
            )
        ]
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


@app.post("/questionnaires/{questionnaire_id}/reset")
def reset_questionnaire(questionnaire_id: str) -> dict:
    """指定テンプレートIDを初期状態に戻す。

    - ID が "default" の場合は組込の既定項目・プロンプトで初期化
    - それ以外は、現在の default テンプレートをソースとして項目・設定・プロンプトを複製
    """
    if questionnaire_id == "default":
        # 既定のテンプレート内容を再投入
        initial_items = [
            {"id": "postal_code", "label": "郵便番号を記入してください。", "type": "string", "required": True},
            {"id": "address", "label": "住所を記入してください。", "type": "string", "required": True},
            {"id": "phone", "label": "電話番号を記入してください。", "type": "string", "required": True},
            {
                "id": "chief_complaint",
                "label": "どういった症状で受診されましたか？",
                "type": "string",
                "required": True,
                "description": "できるだけ具体的にご記入ください（例：3日前から左ひざが痛い）。",
            },
            {
                "id": "symptom_location",
                "label": "症状があるのはどこですか？",
                "type": "multi",
                "options": ["顔", "首", "体", "手足"],
                "allow_freetext": True,
                "required": True,
            },
            {
                "id": "onset",
                "label": "いつから症状がありますか？",
                "type": "multi",
                "options": ["昨日から", "1週間前から", "1ヶ月前から"],
                "allow_freetext": True,
                "required": True,
                "description": "わかる範囲で構いません（例：今朝から、1週間前から など）。",
            },
            {
                "id": "prior_treatments",
                "label": "その症状について、これまで治療を受けたことがあれば、受けた治療を選んでください。",
                "type": "multi",
                "options": ["なし", "外用薬", "内服薬", "注射", "手術", "リハビリ", "その他"],
                "allow_freetext": True,
                "required": False,
            },
            {
                "id": "past_diseases",
                "label": "今までにかかったことのある病気を選んでください。",
                "type": "multi",
                "options": [
                    "なし",
                    "高血圧",
                    "糖尿病",
                    "脂質異常症",
                    "喘息",
                    "アトピー性皮膚炎",
                    "花粉症",
                    "蕁麻疹",
                    "その他",
                ],
                "allow_freetext": True,
                "required": False,
            },
            {
                "id": "surgeries",
                "label": "手術歴があれば選んでください。",
                "type": "multi",
                "options": ["なし", "皮膚科関連手術", "整形外科手術", "腹部手術", "心臓手術", "その他"],
                "allow_freetext": True,
                "required": False,
            },
            {
                "id": "current_medications",
                "label": "現在服用している処方薬があれば選んでください。",
                "type": "multi",
                "options": ["なし", "ステロイド外用", "抗菌薬（内服/外用）", "抗ヒスタミン薬", "NSAIDs", "免疫抑制薬", "その他"],
                "allow_freetext": True,
                "required": False,
            },
            {
                "id": "supplements_otc",
                "label": "現在使用しているサプリメント/市販薬があれば選んでください。",
                "type": "multi",
                "options": ["なし", "ビタミン剤", "漢方", "鎮痛解熱薬", "かゆみ止め", "保湿剤", "その他"],
                "allow_freetext": True,
                "required": False,
            },
            {
                "id": "drug_allergies",
                "label": "薬剤アレルギーがあれば選んでください。",
                "type": "multi",
                "options": [
                    "なし",
                    "ペニシリン系",
                    "セフェム系",
                    "マクロライド系",
                    "ニューキノロン系",
                    "NSAIDs",
                    "局所麻酔",
                    "その他",
                    "不明",
                ],
                "allow_freetext": True,
                "required": False,
            },
            {
                "id": "food_metal_allergies",
                "label": "食物・金属などのアレルギーがあれば選んでください。",
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
                    "その他",
                    "不明",
                ],
                "allow_freetext": True,
                "required": False,
            },
            {
                "id": "smoking",
                "label": "タバコは吸いますか？",
                "type": "multi",
                "options": ["吸わない", "時々吸う", "毎日吸う"],
                "allow_freetext": True,
                "required": False,
            },
            {
                "id": "alcohol",
                "label": "お酒はのみますか？",
                "type": "multi",
                "options": ["のまない", "ときどき", "よく飲む"],
                "allow_freetext": True,
                "required": False,
            },
            {"id": "pregnancy", "label": "妊娠中ですか？", "type": "yesno", "required": False, "gender": "female"},
            {"id": "breastfeeding", "label": "授乳中ですか？", "type": "yesno", "required": False, "gender": "female"},
        ]
        followup_items = [
            {
                "id": "chief_complaint",
                "label": "どういった症状で受診されましたか？",
                "type": "string",
                "required": True,
                "description": "できるだけ具体的にご記入ください（例：3日前から左ひざが痛い）。",
            },
            {
                "id": "symptom_location",
                "label": "症状があるのはどこですか？",
                "type": "multi",
                "options": ["顔", "首", "体", "手足"],
                "allow_freetext": True,
                "required": True,
            },
            {
                "id": "onset",
                "label": "いつからの症状ですか？",
                "type": "multi",
                "options": ["昨日から", "1週間前から", "1ヶ月前から"],
                "allow_freetext": True,
                "required": True,
                "description": "わかる範囲で構いません（例：今朝から、1週間前から など）。",
            },
        ]
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

    # default 以外は、既存の default から複製（なければ既定値から）
    def _src_items(vt: str) -> tuple[list[dict[str, Any]], bool, int]:
        tpl = db_get_template("default", vt)
        if tpl:
            return tpl.get("items", []), bool(tpl.get("llm_followup_enabled", True)), int(
                tpl.get("llm_followup_max_questions", 5)
            )
        # フォールバック（default が無い場合）: 上の既定項目を再利用
        if vt == "initial":
            return initial_items, True, 5  # type: ignore[name-defined]
        return followup_items, True, 5  # type: ignore[name-defined]

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
    initial_items = [
        # 氏名・生年月日はセッション作成時に別途入力するためテンプレートから除外
        {"id": "postal_code", "label": "郵便番号を記入してください。", "type": "string", "required": True},
        {"id": "address", "label": "住所を記入してください。", "type": "string", "required": True},
        {"id": "phone", "label": "電話番号を記入してください。", "type": "string", "required": True},
        {
            "id": "chief_complaint",
            "label": "どういった症状で受診されましたか？",
            "type": "string",
            "required": True,
            "description": "できるだけ具体的にご記入ください（例：3日前から左ひざが痛い）。",
        },
        {
            "id": "symptom_location",
            "label": "症状があるのはどこですか？",
            "type": "multi",
            "options": ["顔", "首", "体", "手足"],
            "allow_freetext": True,
            "required": True,
        },
        {
            "id": "onset",
            "label": "いつから症状がありますか？",
            "type": "multi",
            "options": ["昨日から", "1週間前から", "1ヶ月前から"],
            "allow_freetext": True,
            "required": True,
            "description": "わかる範囲で構いません（例：今朝から、1週間前から など）。",
        },
        {
            "id": "prior_treatments",
            "label": "その症状について、これまで治療を受けたことがあれば、受けた治療を選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "外用薬",
                "内服薬",
                "注射",
                "手術",
                "リハビリ",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "past_diseases",
            "label": "今までにかかったことのある病気を選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "高血圧",
                "糖尿病",
                "脂質異常症",
                "喘息",
                "アトピー性皮膚炎",
                "花粉症",
                "蕁麻疹",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "surgeries",
            "label": "手術歴があれば選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "皮膚科関連手術",
                "整形外科手術",
                "腹部手術",
                "心臓手術",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "current_medications",
            "label": "現在服用している処方薬があれば選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "ステロイド外用",
                "抗菌薬（内服/外用）",
                "抗ヒスタミン薬",
                "NSAIDs",
                "免疫抑制薬",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "supplements_otc",
            "label": "現在使用しているサプリメント/市販薬があれば選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "ビタミン剤",
                "漢方",
                "鎮痛解熱薬",
                "かゆみ止め",
                "保湿剤",
                "その他",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "drug_allergies",
            "label": "薬剤アレルギーがあれば選んでください。",
            "type": "multi",
            "options": [
                "なし",
                "ペニシリン系",
                "セフェム系",
                "マクロライド系",
                "ニューキノロン系",
                "NSAIDs",
                "局所麻酔",
                "その他",
                "不明",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "food_metal_allergies",
            "label": "食物・金属などのアレルギーがあれば選んでください。",
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
                "その他",
                "不明",
            ],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "smoking",
            "label": "タバコは吸いますか？",
            "type": "multi",
            "options": ["吸わない", "時々吸う", "毎日吸う"],
            "allow_freetext": True,
            "required": False,
        },
        {
            "id": "alcohol",
            "label": "お酒はのみますか？",
            "type": "multi",
            "options": ["のまない", "ときどき", "よく飲む"],
            "allow_freetext": True,
            "required": False,
        },
        {"id": "pregnancy", "label": "妊娠中ですか？", "type": "yesno", "required": False, "gender": "female"},
        {"id": "breastfeeding", "label": "授乳中ですか？", "type": "yesno", "required": False, "gender": "female"},
    ]
    followup_items = [
        {
            "id": "chief_complaint",
            "label": "どういった症状で受診されましたか？",
            "type": "string",
            "required": True,
            "description": "できるだけ具体的にご記入ください（例：3日前から左ひざが痛い）。",
        },
        {
            "id": "symptom_location",
            "label": "症状があるのはどこですか？",
            "type": "multi",
            "options": ["顔", "首", "体", "手足"],
            "allow_freetext": True,
            "required": True,
        },
        {
            "id": "onset",
            "label": "いつからの症状ですか？",
            "type": "multi",
            "options": ["昨日から", "1週間前から", "1ヶ月前から"],
            "allow_freetext": True,
            "required": True,
            "description": "わかる範囲で構いません（例：今朝から、1週間前から など）。",
        },
    ]
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
    # 関連するサマリープロンプトも初期化（空欄ではなく既定文を設定）
    upsert_summary_prompt("default", "initial", DEFAULT_SUMMARY_PROMPT, False)
    upsert_summary_prompt("default", "followup", DEFAULT_SUMMARY_PROMPT, False)
    upsert_followup_prompt("default", "initial", DEFAULT_FOLLOWUP_PROMPT, False)
    upsert_followup_prompt("default", "followup", DEFAULT_FOLLOWUP_PROMPT, False)
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
            return s
    except Exception:
        logger.exception("failed_to_load_llm_settings_on_get")
    return llm_gateway.settings


@app.put("/llm/settings", response_model=LLMSettings)
def update_llm_settings(settings: LLMSettings, background: BackgroundTasks) -> LLMSettings:
    """LLM 設定を更新する。必要条件を満たす場合は既存セッションのサマリーをBG再生成。"""
    # バリデーション: LLM を使用する場合はモデル名が必須
    if settings.enabled and (not settings.model or not str(settings.model).strip()):
        raise HTTPException(status_code=400, detail="LLM有効時はモデル名が必須です")

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

                # save_session() が参照する必須フィールド（gender, followup_prompt など）が
                # 欠けていると AttributeError になるため、DBの値とデフォルトから補完して作成する
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
            res = llm_gateway.test_connection()
            if res.get("status") != "ok":
                raise HTTPException(status_code=400, detail=res.get("detail") or "LLM接続に失敗しました")
            background.add_task(_bg_regen_summaries)
    except HTTPException:
        raise
    except Exception:
        logger.exception("llm_settings_post_update_check_failed")
    return llm_gateway.settings


def build_markdown_lines(s: dict, rows: list[tuple[str, str]], vt_label: str) -> list[str]:
    """セッション情報からMarkdown形式の行リストを生成する。"""
    lines = [
        "# 問診結果",
        "",
        "## 患者情報",
        f"- 患者名: {s['patient_name']}",
        f"- 生年月日: {s['dob']}",
        f"- 受診種別: {vt_label}",
        f"- テンプレートID: {s['questionnaire_id']}",
        "",
        "## 回答",
    ]
    for label, ans in rows:
        lines.append(f"- {label}: {ans or '未回答'}")
    if s.get("summary"):
        lines.append("")
        lines.append("## 自動生成サマリー")
        lines.extend(str(s["summary"]).splitlines())
    return lines


def markdown_to_pdf(lines: list[str]) -> bytes:
    """Markdown形式の行リストを簡易フォーマットでPDFに変換する。"""
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    normal_font = "HeiseiMin-W3"
    bold_font = "HeiseiKakuGo-W5"
    y = 800

    def new_page() -> None:
        nonlocal y
        c.showPage()
        y = 800

    def write_line(text: str, font: str = normal_font, size: int = 12, x: int = 40) -> None:
        nonlocal y
        c.setFont(font, size)
        c.drawString(x, y, text)
        y -= size + 2
        if y < 40:
            new_page()

    for line in lines:
        if line.startswith("## "):
            write_line(line[3:], bold_font, 14)
            y -= 2
        elif line.startswith("# "):
            write_line(line[2:], bold_font, 16)
            y -= 4
        elif line.startswith("- "):
            content = line[2:]
            if ": " in content:
                label, value = content.split(": ", 1)
                c.setFont(normal_font, 12)
                c.drawString(60, y, "・")
                x = 60 + c.stringWidth("・", normal_font, 12)
                c.setFont(bold_font, 12)
                c.drawString(x, y, label)
                x += c.stringWidth(label, bold_font, 12)
                c.setFont(normal_font, 12)
                c.drawString(x, y, f": {value}")
                y -= 14
                if y < 40:
                    new_page()
            else:
                c.setFont(normal_font, 12)
                c.drawString(60, y, f"・ {content}")
                y -= 14
                if y < 40:
                    new_page()
        else:
            write_line(line)

    c.save()
    buf.seek(0)
    return buf.getvalue()


class LLMTestRequest(BaseModel):
    """LLM疎通テスト用の一時設定。"""

    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    enabled: bool | None = None


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
        )
        gateway = LLMGateway(temp)
        return gateway.test_connection()
    return llm_gateway.test_connection()

class ListModelsRequest(BaseModel):
    """モデル一覧取得リクエスト。"""

    provider: str
    base_url: str | None = None
    api_key: str | None = None


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
    gateway = LLMGateway(temp_settings)
    return gateway.list_models()


# --- システム表示名・設定 API ---
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

@app.get("/system/display-name", response_model=DisplayNameSettings)
def get_display_name() -> DisplayNameSettings:
    """システムの表示名（ヘッダーに出す名称）を返す。未設定時は既定値。"""
    DEFAULT = "Monshinクリニック"
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
        current["display_name"] = payload.display_name or "Monshinクリニック"
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


class CouchDbStatus(BaseModel):
    """CouchDB の稼働状況。"""

    status: str


@app.get("/system/couchdb-status", response_model=CouchDbStatus)
def get_couchdb_status() -> CouchDbStatus:
    """CouchDB コンテナの稼働状況を返す。"""
    if not COUCHDB_URL:
        return CouchDbStatus(status="disabled")
    try:
        if couch_db is None:
            raise RuntimeError("couch_db not initialized")
        couch_db.info()
        return CouchDbStatus(status="ok")
    except Exception:
        return CouchDbStatus(status="ng")


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
    finalized_at: datetime | None = None
    followup_prompt: str = DEFAULT_FOLLOWUP_PROMPT
    # LLM が提示した追加質問の「質問文」を保持するマップ。
    # キーは `llm_1` のような item_id。
    llm_question_texts: dict[str, str] = Field(default_factory=dict)


class SessionCreateResponse(BaseModel):
    """セッション作成時のレスポンス。"""

    id: str
    patient_name: str
    dob: str
    gender: str
    visit_type: str
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
    finalized_at: str | None = None


class SessionDetail(BaseModel):
    """管理画面で表示するセッション詳細。"""

    id: str
    patient_name: str
    dob: str
    gender: str
    visit_type: str
    questionnaire_id: str
    answers: dict[str, Any]
    # LLM による追加質問の提示文マップ（例: {"llm_1": "いつから症状がありますか？"}）
    llm_question_texts: dict[str, str] | None = None
    summary: str | None = None
    finalized_at: str | None = None


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
    )
    fsm = SessionFSM(session, llm_gateway)
    fsm.update_completion()
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
def finalize_session(
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
    session.finalized_at = datetime.now(UTC)
    session.completion_status = "finalized"
    logger.info("session_finalized id=%s", session_id)
    save_session(session)
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

    if (
        summary_enabled
        and getattr(llm_gateway.settings, "enabled", True)
        and getattr(llm_gateway.settings, "base_url", None)
        and not (payload and payload.llm_error)
    ):
        background.add_task(_bg_summary_task, session.id)

    return {
        "summary": session.summary,
        "answers": session.answers,
        "finalized_at": session.finalized_at.isoformat(),
        "status": session.completion_status,
    }


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
        llm_question_texts=s.get("llm_question_texts") or {},
        summary=s.get("summary"),
        finalized_at=s.get("finalized_at"),
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

    def build_rows(s: dict) -> tuple[list[tuple[str, str]], str]:
        tpl = db_get_template(s.get("questionnaire_id"), s.get("visit_type")) or {}
        labels = {it.get("id"): it.get("label") for it in tpl.get("items", [])}
        answers = s.get("answers", {})

        def fmt_answer(ans: Any) -> str:
            if ans is None or ans == "":
                return ""
            if isinstance(ans, list):
                return ", ".join(map(str, ans))
            if isinstance(ans, dict):
                return json.dumps(ans, ensure_ascii=False)
            return str(ans)

        rows: list[tuple[str, str]] = []
        for iid, label in labels.items():
            rows.append((label, fmt_answer(answers.get(iid))))
        for iid, qtext in (s.get("llm_question_texts") or {}).items():
            rows.append((qtext, fmt_answer(answers.get(iid))))
        vt = s.get("visit_type")
        vt_label = "初診" if vt == "initial" else "再診" if vt == "followup" else str(vt)
        return rows, vt_label


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
            rows, vt_label = build_rows(s)
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
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for sid in ids:
            s = db_get_session(sid)
            if not s:
                continue
            rows, vt_label = build_rows(s)
            base = sanitize_filename(f"{s.get('patient_name','')}_{s.get('dob','')}_{sid}")
            lines = build_markdown_lines(s, rows, vt_label)
            if fmt == "md":
                content = "\n".join(lines).encode("utf-8")
                zf.writestr(f"{base}.md", content)
            elif fmt == "pdf":
                pdf_bytes = markdown_to_pdf(lines)
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
    tpl = db_get_template(s.get("questionnaire_id"), s.get("visit_type")) or {}
    labels = {it.get("id"): it.get("label") for it in tpl.get("items", [])}
    answers = s.get("answers", {})

    def fmt_answer(ans: Any) -> str:
        if ans is None or ans == "":
            return ""
        if isinstance(ans, list):
            return ", ".join(map(str, ans))
        if isinstance(ans, dict):
            return json.dumps(ans, ensure_ascii=False)
        return str(ans)

    rows: list[tuple[str, str]] = []
    for iid, label in labels.items():
        rows.append((label, fmt_answer(answers.get(iid))))
    for iid, qtext in (s.get("llm_question_texts") or {}).items():
        rows.append((qtext, fmt_answer(answers.get(iid))))

    vt = s.get("visit_type")
    vt_label = "初診" if vt == "initial" else "再診" if vt == "followup" else str(vt)

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
        pdf_bytes = markdown_to_pdf(lines)
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename=session-{session_id}.pdf"},
        )
    raise HTTPException(status_code=400, detail="unsupported format")


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
