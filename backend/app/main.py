"""FastAPI バックエンドのエントリポイント。

問診テンプレート取得やチャット応答を含む簡易 API を提供する。
"""
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .llm_gateway import LLMGateway, LLMSettings

app = FastAPI(title="MonshinMate API")

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
    items: list[QuestionnaireItem]


@app.get("/questionnaires/{questionnaire_id}/template", response_model=Questionnaire)
def get_questionnaire_template(questionnaire_id: str, visit_type: str) -> Questionnaire:
    """固定の問診テンプレートを返す。"""

    items = [
        QuestionnaireItem(id="chief_complaint", label="主訴", type="string", required=True),
        QuestionnaireItem(id="onset", label="発症時期", type="string", required=False),
    ]
    return Questionnaire(id=questionnaire_id, items=items)


class ChatRequest(BaseModel):
    """チャットリクエスト。"""

    message: str


class ChatResponse(BaseModel):
    """チャット応答。"""

    reply: str


@app.post("/llm/chat", response_model=ChatResponse)
def llm_chat(req: ChatRequest) -> ChatResponse:
    """LLM との対話を行う。"""

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


class SessionCreateRequest(BaseModel):
    """セッション作成時に受け取る情報。"""

    patient_name: str
    dob: str
    visit_type: str
    answers: dict[str, Any]

class Session(BaseModel):
    """セッションの内容を表すモデル。"""

    id: str
    patient_name: str
    dob: str
    visit_type: str
    answers: dict[str, Any]
    summary: str | None = None


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
    sessions[session_id] = session
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
    session.answers[req.item_id] = req.answer
    question = llm_gateway.generate_question(session.answers)
    return {
        "questions": [
            {
                "id": "followup",
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
    summary = llm_gateway.summarize(session.answers)
    session.summary = summary
    return {"summary": summary, "answers": session.answers}
