"""Firestore Adapter integration tests (requires Firestore emulator)."""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace

import pytest

from app.config import get_settings
from app.db.firestore_adapter import FirestoreAdapter


def _require_emulator() -> None:
    if not os.getenv("FIRESTORE_EMULATOR_HOST"):
        pytest.skip("FIRESTORE_EMULATOR_HOST is not set; start the emulator to run this test")


@pytest.fixture(scope="module")
def firestore_adapter(monkeypatch):
    _require_emulator()
    monkeypatch.setenv("PERSISTENCE_BACKEND", "firestore")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    settings = get_settings()
    adapter = FirestoreAdapter(settings.firestore)
    adapter.init()
    yield adapter


def test_template_crud_and_rename(firestore_adapter: FirestoreAdapter):
    adapter = firestore_adapter
    template_id = f"tpl_{uuid.uuid4().hex}"
    new_template_id = f"tpl_{uuid.uuid4().hex}"
    visit_type = "initial"
    items = [{"id": "q1", "type": "text", "label": "主訴"}]

    adapter.upsert_template(template_id, visit_type, items)
    adapter.upsert_summary_prompt(template_id, visit_type, "summary", enabled=True)
    adapter.upsert_followup_prompt(template_id, visit_type, "followup", enabled=False)

    stored = adapter.get_template(template_id, visit_type)
    assert stored is not None
    assert stored["id"] == template_id
    assert stored["visit_type"] == visit_type

    adapter.rename_template(template_id, new_template_id)
    renamed = adapter.get_template(new_template_id, visit_type)
    assert renamed is not None
    assert renamed["id"] == new_template_id

    adapter.delete_template(new_template_id, visit_type)


def test_session_and_user_flow(firestore_adapter: FirestoreAdapter):
    adapter = firestore_adapter
    session_id = f"sess_{uuid.uuid4().hex}"
    template_id = f"tpl_{uuid.uuid4().hex}"
    visit_type = "initial"

    adapter.upsert_template(template_id, visit_type, [])

    session_data = {
        "id": session_id,
        "patient_name": "テスト太郎",
        "dob": "1990-01-01",
        "gender": "male",
        "visit_type": visit_type,
        "questionnaire_id": template_id,
        "answers": {"q1": "頭痛"},
        "summary": "",
        "remaining_items": [],
        "completion_status": "finalized",
        "attempt_counts": {},
        "additional_questions_used": 0,
        "max_additional_questions": 5,
        "llm_question_texts": {},
        "question_texts": {"q1": "主訴"},
        "started_at": "2025-10-23T00:00:00+00:00",
        "finalized_at": "2025-10-23T01:00:00+00:00",
    }
    adapter.save_session(SimpleNamespace(**session_data))

    fetched = adapter.get_session(session_id)
    assert fetched is not None
    assert fetched["patient_name"] == "テスト太郎"
    assert fetched["answers"]["q1"] == "頭痛"

    listed = adapter.list_sessions()
    assert any(s["id"] == session_id for s in listed)

    adapter.delete_session(session_id)
    adapter.delete_template(template_id, visit_type)

    username = f"user_{uuid.uuid4().hex[:6]}"
    adapter.update_password(username, "Passw0rd!")
    user = adapter.get_user_by_username(username)
    assert user is not None
    assert user["username"] == username
    assert adapter.verify_password("Passw0rd!", user["hashed_password"])

    adapter.update_totp_secret(username, "JBSWY3DPEHPK3PXP")
    adapter.set_totp_status(username, True)
    mode = adapter.get_totp_mode(username)
    assert mode in {"login_and_reset", "reset_only", "off"}
    adapter.set_totp_mode(username, "reset_only")

    logs = adapter.list_audit_logs(limit=10)
    assert isinstance(logs, list)
