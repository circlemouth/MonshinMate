"""Fixed initial-intake identity data is independent of clinical templates."""
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.clinical_context import clinical_answers
from app.db.sqlite_adapter import SQLiteAdapter


PERSONAL_INFO = {
    "name": " Synthetic Patient ",
    "kana": " synthetic ",
    "postal_code": " 000-0000 ",
    "address": " Synthetic address ",
    "phone": " 000-000-0000 ",
}
CLINICAL_ITEM = {"id": "q1", "label": "Synthetic symptom", "type": "string", "required": True}


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    adapter = SQLiteAdapter(str(tmp_path / "synthetic.sqlite3"))
    adapter.init()
    monkeypatch.setattr(db, "_adapter", adapter)
    monkeypatch.setattr(main, "get_summary_config", lambda *a, **k: {"enabled": False})
    monkeypatch.setattr(main, "get_followup_config", lambda *a, **k: {"enabled": False})
    monkeypatch.setattr(main, "_send_push_finalize_notification", lambda *a, **k: None)
    monkeypatch.setattr(main.llm_gateway, "generate_followups", lambda *a, **k: pytest.fail("unexpected LLM call"))
    main.sessions.clear()
    yield adapter
    main.sessions.clear()


def payload(answers=None, visit_type="initial", **extra):
    return {"patient_name": "Synthetic Patient", "dob": "2000-01-01", "gender": "female",
            "visit_type": visit_type, "answers": deepcopy(answers if answers is not None else {"personal_info": PERSONAL_INFO}),
            **extra}


def save_template(items, visit_type="initial", template_id="synthetic"):
    db.upsert_template(template_id, visit_type, deepcopy(items), llm_followup_enabled=False, llm_followup_max_questions=0)


@pytest.mark.parametrize("identity_items", [
    [],
    [{"id": "personal_info", "label": "患者基本情報", "type": "personal_info", "required": True}],
    [{"id": "personal_info", "label": "Reserved ID collision", "type": "string", "required": True}],
    [{"id": "personal_info", "label": "患者基本情報", "type": "personal_info", "required": True,
      "gender_enabled": True, "gender": "male"}],
    [{"id": "personal_info", "label": "患者基本情報", "type": "personal_info", "required": True,
      "gender_enabled": False, "gender": "male"}],
    [{"id": "patient_basic_info", "label": "Legacy identity", "type": "personal_info"}],
    [{"id": "parent", "label": "Parent", "type": "yesno", "followups": {"yes": [
        {"id": "personal_info", "label": "Nested reserved ID", "type": "string"}]}}],
], ids=["missing", "canonical", "reserved-type", "gender-on", "gender-off", "legacy-alias", "nested"])
@pytest.mark.parametrize("implicit_selection", [False, True], ids=["explicit", "configured"])
def test_initial_identity_create_restore_answers_finalize_without_template_mutation(identity_items, implicit_selection):
    items = [deepcopy(CLINICAL_ITEM), *deepcopy(identity_items)]
    save_template(items)
    original = deepcopy(db.get_template("synthetic", "initial"))
    if implicit_selection:
        db.save_app_settings({"default_questionnaire_id": "synthetic"})
    request = payload(**({} if implicit_selection else {"questionnaire_id": "synthetic"}))
    client = TestClient(main.app)
    created = client.post("/sessions", json=request)
    assert created.status_code == 200, created.text
    data = created.json()
    expected = {key: value.strip() for key, value in PERSONAL_INFO.items()}
    assert data["answers"]["personal_info"] == expected
    assert "personal_info" not in data["remaining_items"]
    assert "q1" in data["remaining_items"]
    assert data["questionnaire_id"] == "synthetic"
    assert data["session_token"] and data["expires_at"]
    stored = db.get_session(data["id"])
    assert stored["answers"]["personal_info"] == expected
    assert "session_token" not in stored
    headers = {"Authorization": "Bearer " + data["session_token"]}
    base = "/sessions/" + data["id"]
    assert client.post(base + "/answers", json={"answers": {}}).status_code == 401
    main.sessions.clear()  # All patient requests reconstruct the DB template.
    answered = client.post(base + "/answers", headers=headers,
                           json={"answers": {"personal_info": PERSONAL_INFO, "q1": "synthetic answer"}})
    assert answered.status_code == 200, answered.text
    assert "personal_info" not in answered.json()["remaining_items"]
    assert clinical_answers(main._get_session(data["id"])) == {"q1": "synthetic answer"}
    unknown = client.post(base + "/answers", headers=headers, json={"answers": {"arbitrary_unknown": "no"}})
    assert unknown.status_code == 422
    assert unknown.json()["detail"] == "unknown answer item"
    assert client.post(base + "/llm-questions", headers=headers).json() == {"questions": []}
    finalized = client.post(base + "/finalize", headers=headers)
    assert finalized.status_code == 200, finalized.text
    assert client.post(base + "/answers", headers=headers, json={"answers": {}}).status_code == 409
    assert db.get_template("synthetic", "initial") == original


def test_missing_template_fallback_accepts_fixed_initial_identity():
    client = TestClient(main.app)
    result = client.post("/sessions", json=payload(questionnaire_id="nonexistent"))
    assert result.status_code == 200, result.text
    assert result.json()["answers"]["personal_info"]["name"] == "Synthetic Patient"
    assert db.get_template("nonexistent", "initial") is None
    headers = {"Authorization": "Bearer " + result.json()["session_token"]}
    assert client.post("/sessions/" + result.json()["id"] + "/answers", headers=headers,
                       json={"answers": {"personal_info": PERSONAL_INFO}}).status_code == 200


@pytest.mark.parametrize("value,status", [(None, 400), ([], 400), ("not an object", 400),
                                          ({"name": "x" * 4001}, 422)])
def test_fixed_identity_still_validates_type_and_shape(value, status, monkeypatch):
    save_template([CLINICAL_ITEM])
    monkeypatch.setattr(main, "save_session", lambda *a, **k: pytest.fail("invalid input persisted"))
    monkeypatch.setattr(main, "issue_capability", lambda *a, **k: pytest.fail("invalid input got capability"))
    result = TestClient(main.app).post("/sessions", json=payload({"personal_info": value}, questionnaire_id="synthetic"))
    assert result.status_code == status


def test_other_unknown_answers_still_rejected_before_save(monkeypatch):
    save_template([CLINICAL_ITEM])
    monkeypatch.setattr(main, "save_session", lambda *a, **k: pytest.fail("invalid input persisted"))
    result = TestClient(main.app).post("/sessions", json=payload(
        {"personal_info": PERSONAL_INFO, "arbitrary_unknown": "no"}, questionnaire_id="synthetic"))
    assert result.status_code == 422
    assert result.json()["detail"] == "unknown answer item"


def test_followup_does_not_gain_fixed_identity_exception():
    save_template([CLINICAL_ITEM], visit_type="followup")
    client = TestClient(main.app)
    empty = client.post("/sessions", json=payload({}, "followup", questionnaire_id="synthetic"))
    assert empty.status_code == 200
    headers = {"Authorization": "Bearer " + empty.json()["session_token"]}
    assert client.post("/sessions/" + empty.json()["id"] + "/answers", headers=headers,
                       json={"answers": {"personal_info": PERSONAL_INFO}}).status_code == 422
    response = client.post("/sessions", json=payload(visit_type="followup", questionnaire_id="synthetic"))
    assert response.status_code == 422
    assert response.json()["detail"] == "unknown answer item"


def test_existing_initial_without_identity_keeps_template_and_completion():
    save_template([CLINICAL_ITEM])
    client = TestClient(main.app)
    created = client.post("/sessions", json=payload({"q1": "synthetic answer"}, questionnaire_id="synthetic"))
    assert created.status_code == 200
    assert created.json()["remaining_items"] == []
    before = deepcopy(db.get_session(created.json()["id"]))
    restored = main._get_session(created.json()["id"])
    assert db.get_session(created.json()["id"]) == before
    assert [item.id for item in restored.template_items] == ["q1"]
    assert restored.completion_status == "complete"
    assert "personal_info" not in restored.answers


@pytest.mark.parametrize("answers,status", [
    ({"personal_info": {"name": {"a": {"b": {"c": {"d": {"e": {"f": "deep"}}}}}}}}, 422),
    ({"personal_info": {str(i): "x" for i in range(201)}}, 422),
    ({"personal_info": {"name": ["x"] * 101}}, 422),
    ({"personal_info": {"name": {"k" * 129: "x"}}}, 422),
    ({"personal_info": {str(i): "x" * 4000 for i in range(70)}}, 413),
])
def test_fixed_identity_cannot_bypass_global_limits(answers, status, monkeypatch):
    save_template([CLINICAL_ITEM])
    client = TestClient(main.app)
    valid = client.post("/sessions", json=payload(questionnaire_id="synthetic"))
    assert valid.status_code == 200
    before = deepcopy(db.get_session(valid.json()["id"]))
    monkeypatch.setattr(main, "save_session", lambda *a, **k: pytest.fail("oversized input persisted"))
    monkeypatch.setattr(main, "issue_capability", lambda *a, **k: pytest.fail("oversized input got capability"))
    assert client.post("/sessions", json=payload(answers, questionnaire_id="synthetic")).status_code == status
    headers = {"Authorization": "Bearer " + valid.json()["session_token"]}
    assert client.post("/sessions/" + valid.json()["id"] + "/answers", headers=headers,
                       json={"answers": answers}).status_code == status
    assert db.get_session(valid.json()["id"]) == before


def test_default_template_without_identity_and_followup_known_identity():
    save_template([CLINICAL_ITEM], template_id="default")
    client = TestClient(main.app)
    assert client.post("/sessions", json=payload(questionnaire_id="absent")).status_code == 200
    save_template([{"id": "personal_info", "label": "Identity", "type": "personal_info"}], visit_type="followup")
    known = client.post("/sessions", json=payload(visit_type="followup", questionnaire_id="synthetic"))
    assert known.status_code == 200
    assert known.json()["answers"]["personal_info"]["name"] == "Synthetic Patient"
    headers = {"Authorization": "Bearer " + known.json()["session_token"]}
    assert client.post("/sessions/" + known.json()["id"] + "/answers", headers=headers,
                       json={"answers": {"personal_info": PERSONAL_INFO}}).status_code == 200


def test_fixed_identity_not_sent_to_followup_or_summary_llm(monkeypatch):
    db.upsert_template("synthetic", "initial", [CLINICAL_ITEM], llm_followup_enabled=True, llm_followup_max_questions=1)
    monkeypatch.setattr(main, "get_summary_config", lambda *a, **k: {"enabled": True})
    monkeypatch.setattr(main.llm_gateway, "settings", main.llm_gateway.settings.model_copy(update={"enabled": True}, deep=True))
    captured = []

    def followups(*, context, **kwargs):
        captured.append(context)
        return ["Synthetic followup"]

    def summarize(prompt, context, labels, **kwargs):
        captured.append(context)
        assert labels == {"q1": "Synthetic symptom", "llm_1": "Synthetic followup"}
        return "Synthetic summary"

    monkeypatch.setattr(main.llm_gateway, "generate_followups", followups)
    monkeypatch.setattr(main.llm_gateway, "has_remote_backend", lambda: True)
    monkeypatch.setattr(main.llm_gateway, "summarize_with_prompt", summarize)
    client = TestClient(main.app)
    result = client.post("/sessions", json=payload({"personal_info": PERSONAL_INFO, "q1": "synthetic symptom"}, questionnaire_id="synthetic"))
    assert result.status_code == 200
    base = "/sessions/" + result.json()["id"]
    headers = {"Authorization": "Bearer " + result.json()["session_token"]}
    assert client.post(base + "/llm-questions", headers=headers).status_code == 200
    assert client.post(base + "/llm-answers", headers=headers, json={"item_id": "llm_1", "answer": "synthetic followup answer"}).status_code == 200
    finalized = client.post(base + "/finalize", headers=headers)
    assert finalized.status_code == 200, finalized.text
    assert captured == [{"q1": "synthetic symptom"}, {"q1": "synthetic symptom", "llm_1": "synthetic followup answer"}]
    assert client.post(base + "/finalize", headers=headers).json() == finalized.json()
    assert len(captured) == 2
