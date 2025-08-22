from pathlib import Path
import sys

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app, on_startup  # type: ignore[import]
from app.db import get_session as db_get_session
from fastapi.testclient import TestClient


client = TestClient(app)


def test_get_questionnaire_template() -> None:
    """テンプレート取得エンドポイントが固定データを返すことを確認する。"""
    on_startup()
    res = client.get("/questionnaires/sample/template?visit_type=initial")
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == "sample"
    assert any(item["id"] == "chief_complaint" for item in data["items"])


def test_default_template_contains_items() -> None:
    """デフォルトテンプレートに必要な項目が含まれることを確認する。"""
    on_startup()
    res = client.get("/questionnaires/default/template?visit_type=initial")
    assert res.status_code == 200
    ids = {item["id"] for item in res.json()["items"]}
    expected = {"name", "dob", "sex", "postal_code", "address", "phone", "chief_complaint", "symptom_location", "onset"}
    assert expected.issubset(ids)


def test_llm_chat() -> None:
    """チャットエンドポイントが応答を返すことを確認する。"""
    on_startup()
    res = client.post("/llm/chat", json={"message": "こんにちは"})
    assert res.status_code == 200
    assert res.json()["reply"].startswith("LLM応答")


def test_llm_settings_get_and_update() -> None:
    """LLM 設定の取得と更新ができることを確認する。"""
    on_startup()
    client.put("/llm/settings", json={"provider": "ollama", "model": "llama2", "temperature": 0.2, "system_prompt": "", "enabled": True})
    res = client.get("/llm/settings")
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "ollama"
    assert data["enabled"] is True

    payload = {
        "provider": "lm_studio",
        "model": "test-model",
        "temperature": 0.5,
        "system_prompt": "test",
        "enabled": True,
    }
    res = client.put("/llm/settings", json=payload)
    assert res.status_code == 200
    res = client.get("/llm/settings")
    updated = res.json()
    assert updated["provider"] == "lm_studio"
    assert updated["enabled"] is True
    chat_res = client.post("/llm/chat", json={"message": "hi"})
    assert chat_res.json()["reply"].startswith("LLM応答[lm_studio:test-model")


def test_create_session() -> None:
    """セッション作成が行われ ID が発行されることを確認する。"""
    on_startup()
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

    # 追加質問の取得と回答
    q_res = client.post(f"/sessions/{session_id}/llm-questions")
    assert q_res.status_code == 200
    q_data = q_res.json()
    assert q_data["questions"]
    first_q = q_data["questions"][0]
    ans_res = client.post(
        f"/sessions/{session_id}/llm-answers",
        json={"item_id": first_q["id"], "answer": "昨日から"},
    )
    assert ans_res.status_code == 200

    finalize_res = client.post(f"/sessions/{session_id}/finalize")
    assert finalize_res.status_code == 200
    data = finalize_res.json()
    assert data["summary"].startswith("要約")
    assert data["status"] == "finalized"
    assert "finalized_at" in data and data["finalized_at"]


def test_add_answers() -> None:
    """複数回答の保存ができることを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "佐藤花子",
        "dob": "1985-05-05",
        "visit_type": "initial",
        "answers": {},
    }
    res = client.post("/sessions", json=create_payload)
    assert res.status_code == 200
    session_id = res.json()["id"]

    add_payload = {"answers": {"chief_complaint": "腹痛", "onset": "1週間前から"}}
    add_res = client.post(f"/sessions/{session_id}/answers", json=add_payload)
    assert add_res.status_code == 200
    assert add_res.json()["status"] == "ok"

    finalize_res = client.post(f"/sessions/{session_id}/finalize")
    assert finalize_res.status_code == 200
    data = finalize_res.json()
    assert data["status"] == "finalized"
    assert "finalized_at" in data and data["finalized_at"]
    ans = data["answers"]
    assert ans["chief_complaint"] == "腹痛"
    assert ans["onset"] == "1週間前から"


def test_llm_question_loop() -> None:
    """追加質問エンドポイントが順次質問を返すことを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "テスト太郎",
        "dob": "2000-01-01",
        "visit_type": "initial",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=create_payload)
    session_id = res.json()["id"]

    q1 = client.post(f"/sessions/{session_id}/llm-questions").json()["questions"][0]
    assert q1["id"] == "onset"
    client.post(
        f"/sessions/{session_id}/llm-answers",
        json={"item_id": "onset", "answer": "昨日から"},
    )
    q2 = client.post(f"/sessions/{session_id}/llm-questions").json()["questions"][0]
    assert q2["id"] == "followup"


def test_followup_session_flow() -> None:
    """再診テンプレートでもセッションが完了することを確認する。"""
    on_startup()
    payload = {
        "patient_name": "再診太郎",
        "dob": "1995-12-12",
        "visit_type": "followup",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]
    q_res = client.post(f"/sessions/{session_id}/llm-questions")
    assert q_res.status_code == 200
    q = q_res.json()["questions"][0]
    assert q["id"] == "onset"
    client.post(
        f"/sessions/{session_id}/llm-answers",
        json={"item_id": "onset", "answer": "昨日から"},
    )
    fin = client.post(f"/sessions/{session_id}/finalize")
    assert fin.status_code == 200
    assert fin.json()["status"] == "finalized"


def test_llm_disabled() -> None:
    """LLM 無効設定時は追加質問を行わないことを確認する。"""
    on_startup()
    # LLM を無効化
    client.put("/llm/settings", json={"provider": "ollama", "model": "llama2", "temperature": 0.2, "system_prompt": "", "enabled": False})
    payload = {
        "patient_name": "無効太郎",
        "dob": "1990-01-01",
        "visit_type": "initial",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=payload)
    session_id = res.json()["id"]
    q_res = client.post(f"/sessions/{session_id}/llm-questions")
    assert q_res.status_code == 200
    assert q_res.json()["questions"] == []
    # 後片付け：LLM を有効化に戻す
    client.put("/llm/settings", json={"provider": "ollama", "model": "llama2", "temperature": 0.2, "system_prompt": "", "enabled": True})


def test_admin_session_list_and_detail() -> None:
    """管理用セッション一覧と詳細取得を確認する。"""
    on_startup()
    payload = {
        "patient_name": "一覧太郎",
        "dob": "1980-01-01",
        "visit_type": "initial",
        "answers": {"chief_complaint": "発熱"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]
    fin = client.post(f"/sessions/{session_id}/finalize")
    assert fin.status_code == 200

    list_res = client.get("/admin/sessions")
    assert list_res.status_code == 200
    sessions = list_res.json()
    assert any(s["id"] == session_id for s in sessions)

    detail_res = client.get(f"/admin/sessions/{session_id}")
    assert detail_res.status_code == 200
    detail = detail_res.json()
    assert detail["patient_name"] == "一覧太郎"
    assert detail["answers"]["chief_complaint"] == "発熱"


def test_questionnaire_options() -> None:
    """選択肢付きテンプレートの保存と取得を確認する。"""
    on_startup()
    payload = {
        "id": "opt",
        "visit_type": "initial",
        "items": [
            {
                "id": "color",
                "label": "色",
                "type": "single",
                "required": True,
                "options": ["red", "blue"],
            },
            {
                "id": "fruits",
                "label": "好きな果物",
                "type": "multi",
                "required": False,
                "options": ["apple", "banana"],
                "allow_freetext": True,
            },
        ],
    }
    res = client.post("/questionnaires", json=payload)
    assert res.status_code == 200
    get_res = client.get("/questionnaires/opt/template?visit_type=initial")
    assert get_res.status_code == 200
    data = get_res.json()
    assert data["items"][0]["options"] == ["red", "blue"]
    assert data["items"][1]["type"] == "multi"
    assert data["items"][1]["allow_freetext"] is True
    # 後片付け
    del_res = client.delete("/questionnaires/opt?visit_type=initial")
    assert del_res.status_code == 200


def test_questionnaire_when() -> None:
    """表示条件付きテンプレートの保存と取得を確認する。"""
    on_startup()
    payload = {
        "id": "cond",
        "visit_type": "initial",
        "items": [
            {
                "id": "symptom",
                "label": "症状の有無",
                "type": "single",
                "required": True,
                "options": ["あり", "なし"],
            },
            {
                "id": "detail",
                "label": "詳細",
                "type": "string",
                "required": False,
                "when": {"item_id": "symptom", "equals": "あり"},
            },
        ],
    }
    res = client.post("/questionnaires", json=payload)
    assert res.status_code == 200
    get_res = client.get("/questionnaires/cond/template?visit_type=initial")
    assert get_res.status_code == 200
    data = get_res.json()
    assert data["items"][1]["when"]["item_id"] == "symptom"
    # 後片付け
    del_res = client.delete("/questionnaires/cond?visit_type=initial")
    assert del_res.status_code == 200


def test_session_persisted() -> None:
    """セッションと回答がDBに保存されることを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "保存太郎",
        "dob": "1999-09-09",
        "visit_type": "initial",
        "answers": {"chief_complaint": "めまい"},
    }
    res = client.post("/sessions", json=create_payload)
    session_id = res.json()["id"]
    client.post(
        f"/sessions/{session_id}/answers",
        json={"answers": {"onset": "昨日から"}},
    )
    client.post(f"/sessions/{session_id}/finalize")
    record = db_get_session(session_id)
    assert record is not None
    assert record["answers"]["onset"] == "昨日から"

