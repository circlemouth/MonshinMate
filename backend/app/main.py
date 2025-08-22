"""FastAPI バックエンドのエントリポイント。

問診テンプレート取得やチャット応答を含む簡易 API を提供する。
"""
from typing import Any
from uuid import uuid4
import time
from datetime import datetime
import os

from fastapi import FastAPI, HTTPException, Response, Request
import sqlite3
from pydantic import BaseModel

from .llm_gateway import LLMGateway, LLMSettings
from .db import (
    init_db,
    upsert_template,
    get_template as db_get_template,
    list_templates,
    delete_template,
    save_session,
    list_sessions as db_list_sessions,
    get_session as db_get_session,
)
from .validator import Validator
from .session_fsm import SessionFSM
import logging

init_db()
app = FastAPI(title="MonshinMate API")

logger = logging.getLogger("api")


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
    # 既定テンプレート（initial/followup）を投入（存在すれば上書き）
    base_items = [
        {"id": "chief_complaint", "label": "主訴", "type": "string", "required": True},
        {"id": "onset", "label": "発症時期", "type": "string", "required": False},
    ]
    # デフォルト ID を用意
    upsert_template("default", "initial", base_items)
    upsert_template("default", "followup", base_items)

    logging.basicConfig(level=logging.INFO)
    logging.getLogger(__name__).info("startup completed")

default_llm_settings = LLMSettings(
    provider="ollama", model="llama2", temperature=0.2, system_prompt="", enabled=True
)
llm_gateway = LLMGateway(default_llm_settings)

# 管理者ログイン用のパスワード（簡易実装）
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin")

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
    try:
        # DB に触れてみる
        _ = list_templates()
        # LLM 疎通
        if llm_gateway.test_connection().get("status") != "ok":
            raise RuntimeError("llm not ok")
        return {"status": "ready"}
    except Exception as e:  # noqa: BLE001 - 依存の死活用途のため握りつぶす
        return {"status": "not_ready", "detail": str(e)}


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
    when: WhenCondition | None = None


class Questionnaire(BaseModel):
    """問診テンプレートの構造。"""

    id: str
    # 互換のため GET はクエリで受けるが、保存系は明示
    items: list[QuestionnaireItem]


class QuestionnaireUpsert(BaseModel):
    """テンプレート保存用モデル。"""

    id: str
    visit_type: str
    items: list[QuestionnaireItem]


@app.get("/questionnaires/{questionnaire_id}/template", response_model=Questionnaire)
def get_questionnaire_template(questionnaire_id: str, visit_type: str) -> Questionnaire:
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
                {"id": "chief_complaint", "label": "主訴", "type": "string", "required": True},
                {"id": "onset", "label": "発症時期", "type": "string", "required": False},
            ],
        }
        # 呼び出し互換のため、要求された ID をそのまま設定
        return Questionnaire(id=questionnaire_id, items=[QuestionnaireItem(**it) for it in default_tpl["items"]])
    return Questionnaire(id=tpl["id"], items=[QuestionnaireItem(**it) for it in tpl["items"]])


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
    )
    return {"status": "ok"}


@app.delete("/questionnaires/{questionnaire_id}")
def delete_questionnaire(questionnaire_id: str, visit_type: str) -> dict:
    """テンプレートを削除する。"""
    delete_template(questionnaire_id, visit_type)
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
    """現在の LLM 設定を取得する。"""

    return llm_gateway.settings


@app.put("/llm/settings", response_model=LLMSettings)
def update_llm_settings(settings: LLMSettings) -> LLMSettings:
    """LLM 設定を更新する。"""

    llm_gateway.update_settings(settings)
    return llm_gateway.settings


@app.post("/llm/settings/test")
def test_llm_settings() -> dict:
    """LLM 接続テスト（スタブ）。"""
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


class AdminLoginRequest(BaseModel):
    """管理者ログインリクエスト。"""

    password: str


@app.post("/admin/login")
def admin_login(payload: AdminLoginRequest) -> dict:
    """管理画面へのログインを行う。"""

    if payload.password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="unauthorized")
    return {"status": "ok"}


class SessionCreateRequest(BaseModel):
    """セッション作成時に受け取る情報。"""

    patient_name: str
    dob: str
    visit_type: str
    answers: dict[str, Any]
    questionnaire_id: str = "default"

class Session(BaseModel):
    """セッションの内容を表すモデル。

    現段階ではメモリ上保持の最小実装。plannedSystem.md に沿って
    追加質問の上限や進捗状態を保持する。
    """

    id: str
    patient_name: str
    dob: str
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
    finalized_at: datetime | None = None


class SessionCreateResponse(BaseModel):
    """セッション作成時のレスポンス。"""

    id: str
    patient_name: str
    dob: str
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
    visit_type: str
    questionnaire_id: str
    answers: dict[str, Any]
    summary: str | None = None
    finalized_at: str | None = None


@app.post("/sessions", response_model=SessionCreateResponse)
def create_session(req: SessionCreateRequest) -> SessionCreateResponse:
    """新しいセッションを作成して返す。"""
    session_id = str(uuid4())
    tpl = db_get_template(req.questionnaire_id, req.visit_type)
    if tpl is None:
        tpl = db_get_template("default", req.visit_type)
    if tpl is None:
        tpl = {
            "id": "default",
            "items": [
                {"id": "chief_complaint", "label": "主訴", "type": "string", "required": True},
                {"id": "onset", "label": "発症時期", "type": "string", "required": False},
            ],
        }
    items = [QuestionnaireItem(**it) for it in tpl["items"]]
    Validator.validate_partial(items, req.answers)
    session = Session(
        id=session_id,
        patient_name=req.patient_name,
        dob=req.dob,
        visit_type=req.visit_type,
        questionnaire_id=req.questionnaire_id,
        template_items=items,
        answers=req.answers,
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
    question = fsm.next_question()
    save_session(session)
    if not question:
        logger.info("llm_question_limit id=%s", session_id)
        return {"questions": []}
    logger.info("llm_question id=%s item=%s", session_id, question["id"])
    return {"questions": [question]}


@app.post("/sessions/{session_id}/finalize")
def finalize_session(session_id: str) -> dict:
    """セッションを確定し要約を返す。"""

    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    SessionFSM(session, llm_gateway).update_completion()
    # 必須が未完了の場合も、フェイルセーフとして現状で要約を返し進行可能とする
    summary = llm_gateway.summarize(session.answers)
    session.summary = summary
    session.finalized_at = datetime.utcnow()
    session.completion_status = "finalized"
    global METRIC_SUMMARIES
    METRIC_SUMMARIES += 1
    logger.info("session_finalized id=%s", session_id)
    save_session(session)
    return {
        "summary": summary,
        "answers": session.answers,
        "finalized_at": session.finalized_at.isoformat(),
        "status": session.completion_status,
    }


@app.get("/admin/sessions", response_model=list[SessionSummary])
def admin_list_sessions() -> list[SessionSummary]:
    """保存済みセッションの一覧を返す。"""
    sessions = db_list_sessions()
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
        visit_type=s["visit_type"],
        questionnaire_id=s["questionnaire_id"],
        answers=s.get("answers", {}),
        summary=s.get("summary"),
        finalized_at=s.get("finalized_at"),
    )


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

    - 個人特定情報は送らない前提。
    - 必要に応じてファイルやDBへ積む設計に拡張可能。
    """
    try:
        count = len(payload.events)
    except Exception:
        count = 0
    logger.info("ui_metrics received=%d", count)
    return {"status": "ok", "received": count}
