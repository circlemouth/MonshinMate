"""FastAPI バックエンドのエントリポイント。

問診テンプレート取得やチャット応答を含む簡易 API を提供する。
"""
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

from .llm_gateway import LLMGateway, LLMSettings

app = FastAPI(title="MonshinMate API")

default_llm_settings = LLMSettings(
    provider="ollama", model="llama2", temperature=0.2, system_prompt=""
)
llm_gateway = LLMGateway(default_llm_settings)


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


@app.post("/sessions")
def create_session(req: SessionCreateRequest) -> dict:
    """受け取った回答をそのまま返すスタブ。"""

    return {"status": "received", "answers": req.answers}
