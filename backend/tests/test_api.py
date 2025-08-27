from pathlib import Path
import sys

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app, on_startup  # type: ignore[import]
from app.db import get_session as db_get_session
from app.llm_gateway import DEFAULT_FOLLOWUP_PROMPT
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
    # 氏名(name)・生年月日(dob)はセッション作成時に別途入力するためテンプレートから除外
    expected = {"sex", "postal_code", "address", "phone", "chief_complaint", "symptom_location", "onset"}
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
        "gender": "male",
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
    assert data["summary"] == ""
    assert data["status"] == "finalized"
    assert "finalized_at" in data and data["finalized_at"]


def test_add_answers() -> None:
    """複数回答の保存ができることを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "佐藤花子",
        "dob": "1985-05-05",
        "gender": "female",
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


def test_finalize_with_summary_enabled() -> None:
    """サマリー作成モード有効時に要約が生成されることを確認する。"""
    on_startup()
    # サマリー作成を有効化
    client.post(
        "/questionnaires/default/summary-prompt",
        json={"visit_type": "initial", "prompt": "", "enabled": True},
    )
    payload = {
        "patient_name": "佐藤健",
        "dob": "1992-03-03",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "発熱"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]

    fin = client.post(f"/sessions/{session_id}/finalize")
    assert fin.status_code == 200
    data = fin.json()
    assert data["summary"].startswith("要約")

def test_blank_answer_saved_as_not_applicable() -> None:
    """空欄回答が「該当なし」として保存されることを確認する。"""
    on_startup()
    payload = {
        "patient_name": "空欄太郎",
        "dob": "1999-09-09",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": ""},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    data = res.json()
    session_id = data["id"]
    assert data["answers"]["chief_complaint"] == "該当なし"

    finalize_res = client.post(f"/sessions/{session_id}/finalize")
    assert finalize_res.status_code == 200
    final_data = finalize_res.json()
    assert final_data["answers"]["chief_complaint"] == "該当なし"

def test_llm_question_loop() -> None:
    """追加質問エンドポイントが順次質問を返すことを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "テスト太郎",
        "dob": "2000-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=create_payload)
    session_id = res.json()["id"]
    q_list = client.post(f"/sessions/{session_id}/llm-questions").json()["questions"]
    assert len(q_list) >= 2
    assert q_list[0]["id"] == "llm_1"
    assert q_list[1]["id"] == "llm_2"
    client.post(
        f"/sessions/{session_id}/llm-answers",
        json={"item_id": q_list[0]["id"], "answer": "昨日から"},
    )
    client.post(
        f"/sessions/{session_id}/llm-answers",
        json={"item_id": q_list[1]["id"], "answer": "咳"},
    )


def test_followup_session_flow() -> None:
    """再診テンプレートでもセッションが完了することを確認する。"""
    on_startup()
    payload = {
        "patient_name": "再診太郎",
        "dob": "1995-12-12",
        "gender": "male",
        "visit_type": "followup",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]
    q_res = client.post(f"/sessions/{session_id}/llm-questions")
    assert q_res.status_code == 200
    q = q_res.json()["questions"][0]
    assert q["id"] == "llm_1"
    client.post(
        f"/sessions/{session_id}/llm-answers",
        json={"item_id": q["id"], "answer": "昨日から"},
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
        "gender": "male",
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
        "gender": "male",
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


def test_admin_session_search_filters() -> None:
    """セッション一覧APIの検索フィルタを確認する。"""
    on_startup()
    payload = {
        "patient_name": "検索花子",
        "dob": "1990-12-31",
        "gender": "female",
        "visit_type": "followup",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]
    fin = client.post(f"/sessions/{session_id}/finalize")
    assert fin.status_code == 200

    # 正常にヒットする検索
    list_res = client.get(
        "/admin/sessions",
        params={
            "patient_name": "検索",
            "dob": "1990-12-31",
            "start_date": fin.json()["finalized_at"][:10],
            "end_date": fin.json()["finalized_at"][:10],
        },
    )
    assert list_res.status_code == 200
    sessions = list_res.json()
    assert any(s["id"] == session_id for s in sessions)

    # 不一致の検索ではヒットしない
    nohit_res = client.get(
        "/admin/sessions",
        params={"patient_name": "不存在"},
    )
    assert nohit_res.status_code == 200
    assert all(s["id"] != session_id for s in nohit_res.json())


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
                "description": "説明",
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
    assert data["items"][0]["description"] == "説明"
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


def test_questionnaire_gender_filter() -> None:
    """性別指定の問診項目がフィルタされることを確認する。"""
    on_startup()
    payload = {
        "id": "gender_tpl",
        "visit_type": "initial",
        "items": [
            {"id": "common", "label": "共通", "type": "string", "required": True},
            {"id": "male_only", "label": "男性のみ", "type": "string", "required": False, "gender": "male"},
            {"id": "female_only", "label": "女性のみ", "type": "string", "required": False, "gender": "female"},
            {"id": "both_item", "label": "両方", "type": "string", "required": False, "gender": "both"},
        ],
    }
    res = client.post("/questionnaires", json=payload)
    assert res.status_code == 200
    male_res = client.get("/questionnaires/gender_tpl/template?visit_type=initial&gender=male")
    female_res = client.get("/questionnaires/gender_tpl/template?visit_type=initial&gender=female")
    assert male_res.status_code == 200 and female_res.status_code == 200
    male_items = [it["id"] for it in male_res.json()["items"]]
    female_items = [it["id"] for it in female_res.json()["items"]]
    assert "male_only" in male_items and "female_only" not in male_items
    assert "female_only" in female_items and "male_only" not in female_items
    # gender 未指定および "both" はどちらにも表示される
    assert "common" in male_items and "common" in female_items
    assert "both_item" in male_items and "both_item" in female_items
    client.delete("/questionnaires/gender_tpl?visit_type=initial")


def test_duplicate_questionnaire() -> None:
    """テンプレート複製APIが内容を引き継ぐことを確認する。"""
    on_startup()
    src_initial = {
        "id": "dup_src",
        "visit_type": "initial",
        "items": [{"id": "q1", "label": "Q1", "type": "string", "required": True}],
    }
    src_follow = {
        "id": "dup_src",
        "visit_type": "followup",
        "items": [{"id": "q2", "label": "Q2", "type": "string", "required": False}],
    }
    client.post("/questionnaires", json=src_initial)
    client.post("/questionnaires", json=src_follow)
    client.post(
        "/questionnaires/dup_src/summary-prompt",
        json={"visit_type": "initial", "prompt": "init", "enabled": True},
    )
    client.post(
        "/questionnaires/dup_src/summary-prompt",
        json={"visit_type": "followup", "prompt": "fup", "enabled": False},
    )

    res = client.post("/questionnaires/dup_src/duplicate", json={"new_id": "dup_copy"})
    assert res.status_code == 200

    init_copy = client.get(
        "/questionnaires/dup_copy/template?visit_type=initial"
    ).json()
    follow_copy = client.get(
        "/questionnaires/dup_copy/template?visit_type=followup"
    ).json()
    assert init_copy["items"][0]["label"] == "Q1"
    assert follow_copy["items"][0]["label"] == "Q2"

    init_prompt = client.get(
        "/questionnaires/dup_copy/summary-prompt?visit_type=initial"
    ).json()
    follow_prompt = client.get(
        "/questionnaires/dup_copy/summary-prompt?visit_type=followup"
    ).json()
    assert init_prompt["prompt"] == "init" and init_prompt["enabled"] is True
    assert follow_prompt["prompt"] == "fup" and follow_prompt["enabled"] is False

    client.delete("/questionnaires/dup_src?visit_type=initial")
    client.delete("/questionnaires/dup_src?visit_type=followup")
    client.delete("/questionnaires/dup_copy?visit_type=initial")
    client.delete("/questionnaires/dup_copy?visit_type=followup")


def test_session_persisted() -> None:
    """セッションと回答がDBに保存されることを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "保存太郎",
        "dob": "1999-09-09",
        "gender": "male",
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


def test_llm_followup_disabled_by_template() -> None:
    """テンプレートでLLM追加質問を無効化した場合、質問が返らないことを確認する。"""
    on_startup()
    payload = {
        "id": "nofup",
        "visit_type": "initial",
        "items": [
            {"id": "symptom", "label": "症状は？", "type": "string", "required": True}
        ],
        "llm_followup_enabled": False,
    }
    client.post("/questionnaires", json=payload)
    create_payload = {
        "patient_name": "テスト",
        "dob": "2000-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"symptom": "痛み"},
        "questionnaire_id": "nofup",
    }
    res = client.post("/sessions", json=create_payload)
    session_id = res.json()["id"]
    q_res = client.post(f"/sessions/{session_id}/llm-questions").json()
    assert q_res["questions"] == []
    client.delete("/questionnaires/nofup?visit_type=initial")


def test_llm_followup_max_questions() -> None:
    """テンプレートで設定した追加質問数の上限が反映されることを確認する。"""
    on_startup()
    client.post(
        "/questionnaires",
        json={
            "id": "maxq",
            "visit_type": "initial",
            "items": [
                {"id": "symptom", "label": "症状は？", "type": "string", "required": True}
            ],
            "llm_followup_enabled": True,
            "llm_followup_max_questions": 2,
        },
    )
    res = client.post(
        "/sessions",
        json={
            "patient_name": "上限太郎",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {"symptom": "痛み"},
            "questionnaire_id": "maxq",
        },
    )
    session_id = res.json()["id"]
    q1 = client.post(f"/sessions/{session_id}/llm-questions").json()
    assert len(q1["questions"]) == 2
    q2 = client.post(f"/sessions/{session_id}/llm-questions").json()
    assert q2["questions"] == []
    client.delete("/questionnaires/maxq?visit_type=initial")


def test_followup_prompt_api() -> None:
    """追加質問プロンプトの取得・保存とセッション反映を確認する。"""
    on_startup()
    client.post(
        "/questionnaires",
        json={
            "id": "adv",
            "visit_type": "initial",
            "items": [],
            "llm_followup_enabled": True,
            "llm_followup_max_questions": 1,
        },
    )
    res = client.get("/questionnaires/adv/followup-prompt?visit_type=initial")
    assert res.json()["prompt"] == DEFAULT_FOLLOWUP_PROMPT
    assert res.json()["enabled"] is False
    client.post(
        "/questionnaires/adv/followup-prompt",
        json={
            "visit_type": "initial",
            "prompt": "{max_questions}個以内で返答",
            "enabled": True,
        },
    )
    res = client.get("/questionnaires/adv/followup-prompt?visit_type=initial")
    assert res.json()["prompt"] == "{max_questions}個以内で返答"
    assert res.json()["enabled"] is True
    res = client.post(
        "/sessions",
        json={
            "patient_name": "太郎",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {},
            "questionnaire_id": "adv",
        },
    )
    sid = res.json()["id"]
    rec = db_get_session(sid)
    assert rec["followup_prompt"] == "{max_questions}個以内で返答"
    client.post(
        "/questionnaires/adv/followup-prompt",
        json={
            "visit_type": "initial",
            "prompt": "ignored",
            "enabled": False,
        },
    )
    res = client.post(
        "/sessions",
        json={
            "patient_name": "次郎",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {},
            "questionnaire_id": "adv",
        },
    )
    sid = res.json()["id"]
    rec = db_get_session(sid)
    assert rec["followup_prompt"] == DEFAULT_FOLLOWUP_PROMPT
    client.delete("/questionnaires/adv?visit_type=initial")


def test_summary_prompt_api_default() -> None:
    """サマリープロンプトの既定値取得を確認する。"""
    on_startup()
    res = client.get("/questionnaires/unknown/summary-prompt?visit_type=initial")
    assert res.status_code == 200
    data = res.json()
    assert data["prompt"].startswith("あなたは医療記録作成の専門家です")
    assert data["enabled"] is False
