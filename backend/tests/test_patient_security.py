"""Synthetic-only patient isolation and endpoint-policy integration tests."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import threading
import time

import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app import db, main
from app.api_policy import route_policy
from app.db.sqlite_adapter import SQLiteAdapter
from app.patient_security import rate_limit
from app.security_state import get_state, update_state
from security_support import bootstrap_admin_headers


@pytest.fixture
def context(tmp_path, monkeypatch):
    adapter = SQLiteAdapter(str(tmp_path / "synthetic.sqlite3"))
    adapter.init()
    monkeypatch.setattr(db, "_adapter", adapter)
    monkeypatch.setattr(main.llm_gateway.settings, "enabled", False)
    main.sessions.clear()
    db.upsert_template("default", "initial", [
        {"id": "chief_complaint", "label": "症状", "type": "string", "required": True},
        {"id": "personal_info", "label": "患者基本情報", "type": "personal_info", "required": False},
    ], llm_followup_enabled=False, llm_followup_max_questions=0)
    return TestClient(main.app), adapter


def create(client):
    response = client.post("/sessions", json={"patient_name": "合成患者", "dob": "2000-01-01",
        "gender": "other", "visit_type": "initial", "answers": {"chief_complaint": "合成症状"}})
    assert response.status_code == 200, response.text
    data = response.json()
    return data, {"Authorization": "Bearer " + data["session_token"]}


def test_all_admin_routes_deny_anonymous_without_side_effects(context):
    client, _ = context
    count = 0
    for route in main.app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in route.methods:
            if route_policy(route.path, method) != "admin":
                continue
            path = route.path.replace("{session_id}", "synthetic-id").replace("{questionnaire_id}", "default").replace("{filename}", "x.png").replace("{fmt}", "csv")
            response = client.request(method, path, json={})
            assert response.status_code == 401, (method, path, response.status_code, response.text)
            count += 1
    assert count > 35
    assert db.list_sessions() == []


def test_patient_capability_is_not_id_or_admin_credential(context):
    client, _ = context
    first, headers = create(client)
    second, wrong = create(client)
    path = f"/sessions/{first['id']}/answers"
    payload = {"answers": {"chief_complaint": "更新"}}
    assert client.post(path, json=payload).status_code == 401
    assert client.post(path, headers=wrong, json=payload).status_code == 401
    admin = bootstrap_admin_headers(client)
    assert client.post(path, headers=admin, json=payload).status_code == 401
    assert client.get("/admin/sessions", headers=headers).status_code == 401
    assert client.post(path, headers=headers, json=payload).status_code == 200
    record = db.get_session(first["id"])
    assert record["answers"]["chief_complaint"] == "更新"
    assert "session_token" not in record
    stored = get_state("patient:capability:" + first["id"])[1]
    assert first["session_token"] not in str(stored)


def test_finalize_receipt_idempotent_and_immutable(context):
    client, _ = context
    data, headers = create(client)
    base = f"/sessions/{data['id']}"
    first = client.post(base + "/finalize", headers=headers)
    assert first.status_code == 200, first.text
    assert set(first.json()) == {"id", "status", "finalized_at"}
    assert first.json()["status"] == "finalized"
    main.sessions.clear()
    assert client.post(base + "/finalize", headers=headers).json() == first.json()
    for path in ("/answers", "/llm-answers", "/llm-answers/batch", "/llm-questions"):
        assert client.post(base + path, headers=headers, json={"answers": {}, "item_id": "chief_complaint", "answer": "攻撃"}).status_code == 409
    assert db.get_session(data["id"])["answers"]["chief_complaint"] == "合成症状"
    assert first.headers["cache-control"] == "no-store"
    assert first.headers["x-content-type-options"] == "nosniff"


def test_expiry_and_legacy_session_have_no_token_exchange(context):
    client, _ = context
    data, headers = create(client)
    update_state("patient:capability:" + data["id"], lambda state: {**state, "expires_at": time.time() - 1})
    assert client.post(f"/sessions/{data['id']}/finalize", headers=headers).status_code == 401
    assert client.post("/sessions/legacy-record/finalize", headers=headers).status_code == 401
    assert client.post(f"/sessions/{data['id']}/token").status_code == 404


def test_unknown_and_oversized_answers_are_rejected_without_db_changes(context):
    client, _ = context
    data, headers = create(client)
    path = f"/sessions/{data['id']}/answers"
    for answers in ({"llm_999": "unissued"}, {"chief_complaint": "x" * 4001}, {str(i): "x" for i in range(201)}):
        assert client.post(path, headers=headers, json={"answers": answers}).status_code == 422
    assert client.post(path, headers=headers, content=b"x" * (256 * 1024 + 1)).status_code == 413
    assert db.get_session(data["id"])["answers"]["chief_complaint"] == "合成症状"


def test_distributed_lease_blocks_concurrent_finalize_and_delete(context, monkeypatch):
    client, _ = context
    data, headers = create(client)
    admin = bootstrap_admin_headers(client)
    original = main.save_session
    entered, release = threading.Event(), threading.Event()
    def pause(session):
        entered.set()
        assert release.wait(10)
        original(session)
    monkeypatch.setattr(main, "save_session", pause)
    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(client.post, f"/sessions/{data['id']}/finalize", headers=headers)
        try:
            assert entered.wait(10)
            assert client.post(f"/sessions/{data['id']}/finalize", headers=headers).status_code == 409
            assert client.delete(f"/admin/sessions/{data['id']}", headers=admin).status_code == 409
        finally:
            release.set()
        assert future.result().status_code == 200
    assert db.get_session(data["id"])["completion_status"] == "finalized"


def test_rate_limit_shared_between_adapter_instances(context, monkeypatch):
    _, adapter = context
    rate_limit("synthetic:quota", 1)
    monkeypatch.setattr(db, "_adapter", SQLiteAdapter(adapter.default_db_path))
    with pytest.raises(HTTPException) as exc:
        rate_limit("synthetic:quota", 1)
    assert exc.value.status_code == 429


def test_no_legacy_live_session_after_admin_delete(context):
    client, _ = context
    data, headers = create(client)
    admin = bootstrap_admin_headers(client)
    assert client.delete(f"/admin/sessions/{data['id']}", headers=admin).status_code == 200
    assert client.post(f"/sessions/{data['id']}/finalize", headers=headers).status_code == 401
    assert db.get_session(data["id"]) is None
