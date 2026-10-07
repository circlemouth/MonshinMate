"""Synthetic boundary, minimization, and interrupted-finalization regressions."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import db, main
from app.api_policy import RequestBoundaryMiddleware, route_policy
from app.clinical_context import clinical_answers
from app.security_state import update_state
from test_patient_security import context, create  # shared fresh SQLite fixture


@pytest.mark.parametrize("headers,chunks,expected", [
    ([], [b"x" * 200000, b"y" * 100000], 413),
    ([(b"content-length", b"1")], [b"x" * 262145], 413),
    ([(b"content-length", b"-1")], [], 400),
    ([(b"content-length", b"invalid")], [], 400),
    ([], [b"small"], 200),
])
def test_body_boundary_before_parser_and_secure_error_headers(headers, chunks, expected):
    called = []
    responses = []
    chunks = list(chunks)

    async def receive():
        if not chunks:
            return {"type": "http.disconnect"}
        return {"type": "http.request", "body": chunks.pop(0), "more_body": bool(chunks)}

    async def app(scope, receive, send):
        called.append((await receive())["body"])
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"cache-control", b"public")]})
        await send({"type": "http.response.body", "body": b"{}"})

    async def send(message):
        responses.append(message)

    asyncio.run(RequestBoundaryMiddleware(app)(
        {"type": "http", "path": "/sessions", "headers": headers}, receive, send))
    assert responses[0]["status"] == expected
    assert bool(called) == (expected == 200)
    output = dict(responses[0]["headers"])
    assert output[b"cache-control"] == b"no-store"
    assert output[b"x-content-type-options"] == b"nosniff"
    assert output[b"referrer-policy"] == b"no-referrer"


def test_new_routes_default_to_admin():
    assert route_policy("/system/future-diagnostics", "GET") == "admin"
    assert route_policy("/system/bootstrap", "PUT") == "admin"
    assert route_policy("/admin/totp/future-reset", "POST") == "admin"


def test_auth_router_future_endpoint_is_default_deny(context):
    from fastapi import FastAPI, APIRouter
    from fastapi.testclient import TestClient
    from app.admin_security_routes import router as auth_router
    isolated = FastAPI()
    extension = APIRouter(route_class=auth_router.route_class)
    @extension.get("/admin/future-security-operation")
    def new_operation():
        return {"sensitive": True}
    isolated.include_router(extension)
    assert TestClient(isolated).get("/admin/future-security-operation").status_code == 401


def test_clinical_allowlist_excludes_identity_and_unknown_answers():
    session = SimpleNamespace(template_items=[
        {"id": "symptom", "label": "症状", "type": "string", "followups": {"yes": [
            {"id": "duration", "label": "期間", "type": "string"}]}},
        {"id": "custom_identity", "label": "患者氏名", "type": "string"},
        {"id": "personal_info", "type": "personal_info"},
    ], answers={"symptom": "頭痛", "duration": "1日", "custom_identity": "合成氏名",
                 "personal_info": {"name": "合成氏名"}, "injected": "secret",
                 "llm_1": "継続", "llm_2": "住所", "llm_999": "未発行"},
        llm_question_texts={"llm_1": "症状の経過", "llm_2": "住所"})
    assert clinical_answers(session) == {"symptom": "頭痛", "duration": "1日", "llm_1": "継続"}


def test_public_readiness_never_discloses_model_error(context, monkeypatch):
    client, _ = context
    monkeypatch.setattr(main.llm_gateway.settings, "enabled", True)
    monkeypatch.setattr(main.llm_gateway.settings, "base_url", "https://api.openai.com")
    monkeypatch.setattr(main.llm_gateway, "get_status_snapshot", lambda: {
        "status": "error", "detail": "synthetic-private-provider-error", "source": "secret-host"})
    assert client.get("/readyz").json() == {"status": "not_ready"}


def test_invalid_provider_profile_never_logs_raw_credentials(caplog):
    settings = main.LLMSettings(provider="openai", model="synthetic-model", temperature=0.0, enabled=False)
    marker = "SYNTHETIC-SECRET-MUST-NOT-LOG"
    main._apply_provider_profile_payload(settings, {marker: {"api_key": {"secret": marker}}})
    assert "llm_temp_settings_profile_parse_failed" in caplog.text
    assert marker not in caplog.text


def test_long_patient_identifier_denied_without_backend_failure(context):
    client, _ = context
    _, headers = create(client)
    assert client.post("/sessions/" + "x" * 300 + "/finalize", headers=headers).status_code == 401


def test_abandoned_operation_is_not_stolen(context):
    client, _ = context
    session, headers = create(client)
    update_state("patient:capability:" + session["id"], lambda state: {
        **state, "operation": "abandoned-synthetic-operation", "operation_started_at": 0})
    assert client.post(f"/sessions/{session['id']}/finalize", headers=headers).status_code == 409
    assert db.get_session(session["id"])["completion_status"] != "finalized"


def test_saved_finalize_recovers_receipt_without_repeating_model(context, monkeypatch):
    client, _ = context
    session, headers = create(client)
    db.upsert_summary_prompt("default", "initial", "合成要約", True)
    calls = []
    monkeypatch.setattr(main.llm_gateway, "has_remote_backend", lambda: True)
    monkeypatch.setattr(main.llm_gateway, "summarize_with_prompt", lambda *a, **k: calls.append(1) or "合成要約")
    original = main.finalize_receipt
    def unavailable(*args):
        raise HTTPException(503, "synthetic interrupted receipt")
    monkeypatch.setattr(main, "finalize_receipt", unavailable)
    path = f"/sessions/{session['id']}/finalize"
    assert client.post(path, headers=headers).status_code == 503
    assert db.get_session(session["id"])["completion_status"] == "finalized"
    monkeypatch.setattr(main, "finalize_receipt", original)
    assert client.post(path, headers=headers).status_code == 200
    assert calls == [1]
