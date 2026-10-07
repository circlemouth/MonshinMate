"""Atomic import and unanswered-question durability, synthetic SQLite only."""
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image


@pytest.fixture
def storage(tmp_path):
    root = Path(__file__).resolve().parents[2]
    if not root.name.startswith("monshinmate-security-tests-") or os.getenv("MONSHINMATE_ENV") != "test":
        pytest.skip("Use source-only run_security_tests.py")
    from app.db import sqlite_adapter as sa
    path = str(tmp_path / "synthetic.sqlite")
    sa.init_db(path)
    return sa, sa.SQLiteAdapter(db_path=path), path


def session_record(sid="synthetic"):
    return {"id": sid, "patient_name": "Synthetic Patient", "dob": "2000-01-02", "gender": "other",
            "visit_type": "initial", "questionnaire_id": "synthetic-template", "answers": {"symptom": "pain"},
            "completion_status": "finalized", "finalized_at": "2026-01-01T01:00:00+00:00",
            "question_texts": {"symptom": "Synthetic question"}, "llm_question_texts": {"llm_1": "Issued question"}}


def live_session(sid="original"):
    return SimpleNamespace(**{**session_record(sid), "summary": None, "remaining_items": [], "attempt_counts": {},
                             "additional_questions_used": 1, "max_additional_questions": 3, "followup_prompt": None,
                             "started_at": None, "pending_llm_questions": [{"id": "llm_2", "question": "Queued question"}],
                             "template_items": []})


def snapshot(sa, path):
    conn = sa.get_conn(path)
    try:
        return {table: conn.execute(f"SELECT * FROM {table} ORDER BY 1,2").fetchall()
                for table in ("sessions", "session_responses", "security_state", "questionnaire_templates", "summary_prompts",
                              "followup_prompts", "app_settings", "llm_settings", "binary_assets")}
    finally:
        conn.close()


def execute(sa, path, sql):
    conn = sa.get_conn(path)
    try:
        conn.execute(sql)
        conn.commit()
    finally:
        conn.close()


def raster():
    out = io.BytesIO()
    Image.new("RGB", (2, 2), "blue").save(out, format="PNG")
    return out.getvalue()


def test_unanswered_question_metadata_survives_save_reload(storage):
    sa, adapter, path = storage
    session = live_session()
    adapter.save_session(session)
    loaded = adapter.get_session(session.id)
    assert "llm_1" not in loaded["answers"]
    assert loaded["llm_question_texts"] == session.llm_question_texts
    assert loaded["pending_llm_questions"] == session.pending_llm_questions
    assert loaded["question_texts"] == session.question_texts
    # A second worker/save replaces the durable maps, not an in-memory cache.
    session.llm_question_texts["llm_2"] = "Queued question"
    session.pending_llm_questions = []
    adapter.save_session(session)
    loaded = adapter.get_session(session.id)
    assert loaded["pending_llm_questions"] == []
    assert loaded["llm_question_texts"]["llm_2"] == "Queued question"
    exported = adapter.export_sessions_data([session.id])[0]
    assert exported["llm_question_texts"] == session.llm_question_texts
    assert exported["question_texts"] == session.question_texts


def test_couch_document_preserves_unanswered_question_metadata(storage, monkeypatch):
    sa, adapter, path = storage
    class FakeCouch(dict):
        def __bool__(self):
            return True
        def save(self, doc):
            self[doc["_id"]] = dict(doc)
        def get(self, key):
            value = super().get(key)
            return dict(value) if value else None
    database = FakeCouch()
    monkeypatch.setattr(sa, "get_couch_db", lambda: database)
    session = live_session()
    adapter.save_session(session)
    loaded = adapter.get_session(session.id)
    assert loaded["pending_llm_questions"] == session.pending_llm_questions
    assert loaded["llm_question_texts"] == session.llm_question_texts
    assert loaded["question_texts"] == session.question_texts


def test_metadata_migration_idempotent(storage):
    sa, adapter, path = storage
    for column in ("pending_llm_questions_json", "llm_question_texts_json", "question_texts_json"):
        execute(sa, path, f"ALTER TABLE sessions DROP COLUMN {column}")
    sa.init_db(path)
    sa.init_db(path)
    adapter.save_session(live_session())
    assert adapter.get_session("original")["pending_llm_questions"][0]["id"] == "llm_2"


@pytest.mark.parametrize("mode", ["merge", "replace"])
def test_questionnaire_atomic_failure_rolls_back_assets_settings_and_data(storage, mode):
    sa, adapter, path = storage
    adapter.save_app_settings({"display_name": "Original", "patient_summary_api_key_hash": "secret-hash"})
    execute(sa, path, "CREATE TRIGGER fail_second_asset BEFORE INSERT ON binary_assets WHEN NEW.id='z-fail.png' "
                      "BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
    before = snapshot(sa, path)
    with pytest.raises(HTTPException) as exc:
        adapter.atomic_import_questionnaire_settings({
            "templates": [{"id": "new-template", "visit_type": "initial", "items": []}],
            "app_settings": {"display_name": "New"},
        }, mode=mode, images={name: {"content": raster()} for name in ("good.png", "z-fail.png")})
    assert exc.value.status_code == 503
    assert snapshot(sa, path) == before


@pytest.mark.parametrize("mode", ["merge", "replace"])
def test_questionnaire_import_preserves_security_and_credentials(storage, mode):
    sa, adapter, path = storage
    adapter.save_app_settings({"display_name": "Original", "patient_summary_api_key_hash": "local-secret"})
    adapter.save_llm_settings({"provider": "openai", "enabled": False, "api_key": "local-key",
                               "provider_profiles": {"openai": {"api_key": "local-profile-key", "model": "old"}}})
    assert adapter.security_compare_and_swap_state("admin:synthetic", None, {"secret": "admin-secret"})
    result = adapter.atomic_import_questionnaire_settings({
        "templates": [{"id": "new-template", "visit_type": "initial", "items": []}],
        "summary_prompts": [{"id": "new-template", "visit_type": "initial", "prompt": "Summarize", "enabled": True}],
        "app_settings": {"display_name": "New", "patient_summary_api_key_hash": "injected"},
        "llm_settings": {"enabled": False, "api_key": "injected", "provider_profiles": {
            "openai": {"api_key": "injected", "model": "new"}}},
    }, mode=mode, images={"good.png": {"content": raster() + b"trailer"}})
    assert result["templates"] == 1
    assert adapter.load_app_settings()["patient_summary_api_key_hash"] == "local-secret"
    settings = adapter.load_llm_settings()
    assert settings["api_key"] == "local-key"
    assert settings["provider_profiles"]["openai"]["api_key"] == "local-profile-key"
    assert settings["provider_profiles"]["openai"]["model"] == "new"
    assert adapter.security_get_state("admin:synthetic")[1] == {"secret": "admin-secret"}
    assert not adapter.load_binary_asset("questionnaire_item_image", "good.png")["content"].endswith(b"trailer")


@pytest.mark.parametrize("mode", ["merge", "replace"])
def test_session_atomic_failure_restores_records_responses_and_capabilities(storage, mode):
    sa, adapter, path = storage
    adapter.save_session(live_session())
    adapter.security_compare_and_swap_state("patient:capability:original", None, {"status": "finalized", "token_hash": "old"})
    adapter.security_compare_and_swap_state("admin:synthetic", None, {"secret": "admin-secret"})
    execute(sa, path, "CREATE TRIGGER fail_second_session BEFORE INSERT ON sessions WHEN NEW.id='reject' "
                      "BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
    before = snapshot(sa, path)
    with pytest.raises(HTTPException) as exc:
        adapter.atomic_import_sessions_data([session_record("new"), session_record("reject")], mode=mode)
    assert exc.value.status_code == 503
    assert snapshot(sa, path) == before


@pytest.mark.parametrize("mode", ["merge", "replace"])
@pytest.mark.parametrize("state", [{"status": "open"}, {"status": "finalized", "operation": "running"}])
def test_import_refuses_live_or_inflight_patient_writer(storage, mode, state):
    sa, adapter, path = storage
    adapter.save_session(live_session())
    adapter.security_compare_and_swap_state("patient:capability:original", None, state)
    before = snapshot(sa, path)
    with pytest.raises(HTTPException) as exc:
        adapter.atomic_import_sessions_data([session_record("original")], mode=mode)
    assert exc.value.status_code == 409
    assert snapshot(sa, path) == before


@pytest.mark.parametrize("mode", ["merge", "replace"])
def test_imported_sessions_do_not_reuse_capabilities_or_touch_admin_state(storage, mode):
    sa, adapter, path = storage
    adapter.save_session(live_session())
    adapter.security_compare_and_swap_state("patient:capability:original", None,
                                      {"status": "finalized", "token_hash": "old", "receipt": {"id": "old"}})
    adapter.security_compare_and_swap_state("admin:synthetic", None, {"secret": "admin-secret"})
    records = [session_record("original"), session_record("new")]
    records[0]["capability_hash"] = "injected"
    assert adapter.atomic_import_sessions_data(records, mode=mode) == {"sessions": 2}
    for session_id in ("original", "new"):
        state = adapter.security_get_state("patient:capability:" + session_id)[1]
        assert state["status"] == "deleted" and "token_hash" not in state and "receipt" not in state
        assert "capability_hash" not in adapter.get_session(session_id)
        assert adapter.get_session(session_id)["answers"] == {"symptom": "pain"}
    assert adapter.security_get_state("admin:synthetic")[1] == {"secret": "admin-secret"}
    assert not adapter.security_compare_and_swap_state("patient:capability:original", 1, {"status": "open"})
    assert not adapter.security_compare_and_swap_state("patient:capability:new", None, {"status": "open"})


def test_couch_import_fails_before_sqlite_or_network_mutation(storage, monkeypatch):
    sa, adapter, path = storage
    before = snapshot(sa, path)
    monkeypatch.setattr(sa, "COUCHDB_URL", "https://couch.example.invalid")
    monkeypatch.setattr(sa, "get_couch_db", lambda: pytest.fail("Couch network access"))
    for invoke in (lambda: adapter.atomic_import_sessions_data([], mode="replace"),
                   lambda: adapter.atomic_import_questionnaire_settings({"templates": []}, mode="replace")):
        with pytest.raises(HTTPException) as exc:
            invoke()
        assert exc.value.status_code == 501
    assert snapshot(sa, path) == before
