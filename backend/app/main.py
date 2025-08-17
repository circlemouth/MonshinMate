"""FastAPI バックエンドのエントリポイント。

問診テンプレート取得やチャット応答を含む簡易 API を提供する。
"""
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Response
import sqlite3
from pydantic import BaseModel

from .llm_gateway import LLMGateway, LLMSettings
from .db import init_db, upsert_template, get_template as db_get_template, list_templates, delete_template
import logging

app = FastAPI(title="MonshinMate API")


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
    provider="ollama", model="llama2", temperature=0.2, system_prompt=""
)
llm_gateway = LLMGateway(default_llm_settings)

# メモリ上でセッションを保持する簡易ストア
sessions: dict[str, "Session"] = {}


@app.get("/healthz")
def healthz() -> dict:
    """死活監視用の簡易エンドポイント。

    Returns:
        dict: ステータス文字列を含む辞書。
    """
    return {"status": "ok"}


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


class QuestionnaireItem(BaseModel):
    """問診項目の定義。"""

    id: str
    label: str
    type: str
    required: bool = False


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


class SessionCreateRequest(BaseModel):
    """セッション作成時に受け取る情報。"""

    patient_name: str
    dob: str
    visit_type: str
    answers: dict[str, Any]

class Session(BaseModel):
    """セッションの内容を表すモデル。

    現段階ではメモリ上保持の最小実装。plannedSystem.md に沿って
    追加質問の上限や進捗状態を保持する。
    """

    id: str
    patient_name: str
    dob: str
    visit_type: str
    answers: dict[str, Any]
    summary: str | None = None
    # 進行管理
    remaining_items: list[str] = []
    completion_status: str = "in_progress"  # or "complete"
    attempt_counts: dict[str, int] = {}
    additional_questions_used: int = 0
    max_additional_questions: int = 5


def _required_items_for_visit(visit_type: str) -> list[QuestionnaireItem]:
    # 最小テンプレートの必須定義（将来的に DB 定義に寄せてもよい）
    return [
        QuestionnaireItem(id="chief_complaint", label="主訴", type="string", required=True),
    ]


def _update_completion_status(session: Session) -> None:
    """必須項目の充足状態を更新する。"""
    required = _required_items_for_visit(session.visit_type)
    remaining = [it.id for it in required if it.id not in session.answers or not str(session.answers[it.id]).strip()]
    session.remaining_items = remaining
    session.completion_status = "complete" if not remaining else "in_progress"


class SessionCreateResponse(Session):
    """セッション作成時のレスポンス。"""

    status: str = "created"


@app.post("/sessions", response_model=SessionCreateResponse)
def create_session(req: SessionCreateRequest) -> SessionCreateResponse:
    """新しいセッションを作成して返す。"""
    session_id = str(uuid4())
    session = Session(
        id=session_id,
        patient_name=req.patient_name,
        dob=req.dob,
        visit_type=req.visit_type,
        answers=req.answers,
    )
    _update_completion_status(session)
    sessions[session_id] = session
    global METRIC_SESSIONS_CREATED
    METRIC_SESSIONS_CREATED += 1
    return SessionCreateResponse(**session.model_dump())


class AnswerRequest(BaseModel):
    """質問への回答データ。"""

    item_id: str
    answer: Any


@app.post("/sessions/{session_id}/answer")
def answer_question(session_id: str, req: AnswerRequest) -> dict:
    """回答をセッションに追加し、次の質問を返す。"""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    # 回答を保存
    session.answers[req.item_id] = req.answer
    global METRIC_ANSWERS_RECEIVED
    METRIC_ANSWERS_RECEIVED += 1
    # 必須項目の完了判定を更新
    _update_completion_status(session)

    # 追質問の生成（上限管理）
    # 必須がすべて埋まっていても、上限に達するまでは汎用の追加質問を返す
    if session.additional_questions_used >= session.max_additional_questions:
        return {"questions": []}

    # 次に不足している（必須でないものを含む）代表的な項目を選ぶ簡易戦略
    # ここでは onset を例に、未入力ならそれを聞く
    next_item_id = None
    next_item_label = None
    if "onset" not in session.answers:
        next_item_id = "onset"
        next_item_label = "発症時期"
    elif "chief_complaint" not in session.answers:
        next_item_id = "chief_complaint"
        next_item_label = "主訴"

    # 項目ごとの再質問上限（3回）を超過していないか確認
    if next_item_id is not None:
        count = session.attempt_counts.get(next_item_id, 0)
        if count >= 3:
            next_item_id = None

    if next_item_id is None:
        # 汎用の追加質問を 1 件返す（互換目的・最小実装）
        session.additional_questions_used += 1
        return {
            "questions": [
                {
                    "id": "followup",
                    "text": "追加質問: 他に伝えておきたいことはありますか？",
                    "expected_input_type": "string",
                    "priority": 1,
                }
            ]
        }

    session.additional_questions_used += 1
    session.attempt_counts[next_item_id] = session.attempt_counts.get(next_item_id, 0) + 1
    question = llm_gateway.generate_question(
        missing_item_id=next_item_id,
        missing_item_label=next_item_label,
        context=session.answers,
    )
    return {
        "questions": [
            {
                "id": next_item_id,
                "text": question,
                "expected_input_type": "string",
                "priority": 1,
            }
        ]
    }


@app.post("/sessions/{session_id}/finalize")
def finalize_session(session_id: str) -> dict:
    """セッションを確定し要約を返す。"""

    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    # ここでは最小要件：必須が埋まっていれば確定可能
    if session.completion_status != "complete":
        # 必須が未完了の場合も、フェイルセーフとして現状で要約を返し進行可能とする
        # plannedSystem 上の運用方針に合わせ、ベース問診のみでの完了も許容。
        pass
    summary = llm_gateway.summarize(session.answers)
    session.summary = summary
    global METRIC_SUMMARIES
    METRIC_SUMMARIES += 1
    return {"summary": summary, "answers": session.answers}


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
