"""API エンドポイントの動作確認テスト。"""
from pathlib import Path
import sys

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app  # type: ignore[import]
from fastapi.testclient import TestClient


client = TestClient(app)


def test_get_questionnaire_template() -> None:
    """テンプレート取得エンドポイントが固定データを返すことを確認する。"""
    res = client.get("/questionnaires/sample/template?visit_type=initial")
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == "sample"
    assert any(item["id"] == "chief_complaint" for item in data["items"])


def test_llm_chat() -> None:
    """チャットエンドポイントが応答を返すことを確認する。"""
    res = client.post("/llm/chat", json={"message": "こんにちは"})
    assert res.status_code == 200
    assert res.json()["reply"].startswith("LLM応答")


def test_llm_settings_get_and_update() -> None:
    """LLM 設定の取得と更新ができることを確認する。"""
    res = client.get("/llm/settings")
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "ollama"

    payload = {
        "provider": "lm_studio",
        "model": "test-model",
        "temperature": 0.5,
        "system_prompt": "test",
    }
    res = client.put("/llm/settings", json=payload)
    assert res.status_code == 200
    res = client.get("/llm/settings")
    assert res.json()["provider"] == "lm_studio"
    chat_res = client.post("/llm/chat", json={"message": "hi"})
    assert chat_res.json()["reply"].startswith("LLM応答[lm_studio:test-model")


def test_create_session() -> None:
    """セッション作成が行われ ID が発行されることを確認する。"""
    payload = {
        "patient_name": "山田太郎",
        "dob": "1990-01-01",
        "visit_type": "initial",
        "answers": {"chief_complaint": "頭痛"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["answers"]["chief_complaint"] == "頭痛"
    assert "id" in data
    assert data["status"] == "created"
    session_id = data["id"]

    # 回答追加と要約処理の確認
    answer_res = client.post(
        f"/sessions/{session_id}/answer",
        json={"item_id": "onset", "answer": "昨日"},
    )
    assert answer_res.status_code == 200
    q = answer_res.json()["questions"][0]["text"]
    assert "追加質問" in q

    finalize_res = client.post(f"/sessions/{session_id}/finalize")
    assert finalize_res.status_code == 200
    assert finalize_res.json()["summary"].startswith("要約")
