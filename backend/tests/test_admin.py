"""Security regressions. Fixtures use fresh tmp_path databases, never source DBs."""
from __future__ import annotations

import json
import time
from urllib.parse import parse_qs, urlparse

import pyotp
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from app import admin_security as auth, db
from app.admin_security_routes import router
from app.db.sqlite_adapter import SQLiteAdapter
from app.security_state import get_state, update_state

PASSWORD = "SyntheticPassword123!"


@pytest.fixture
def context(tmp_path, monkeypatch):
    adapter = SQLiteAdapter(str(tmp_path / "isolated.sqlite3"))
    adapter.init()
    monkeypatch.setattr(db, "_adapter", adapter)
    # All synthetic JWT times are in the recent past (jose uses wall clock).
    clock = [int(time.time()) // 30 * 30 - 240]
    monkeypatch.setattr(auth, "_now", lambda: clock[0])
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    return client, clock, adapter


def enroll(context):
    client, clock, _ = context
    credential = auth.issue_offline_credential("bootstrap")
    response = client.post("/admin/bootstrap", json={"credential": credential, "new_password": PASSWORD})
    assert response.status_code == 200
    enrollment_token = response.json()["enrollment_token"]
    headers = {"Authorization": "Bearer " + enrollment_token}
    setup = client.post("/admin/totp/setup", headers=headers)
    assert setup.status_code == 200
    assert setup.headers["cache-control"] == "no-store"
    data = setup.json()
    secret = parse_qs(urlparse(data["provisioning_uri"]).query)["secret"][0]
    result = client.post("/admin/totp/verify", headers=headers, json={
        "enrollment_id": data["enrollment_id"], "totp_code": pyotp.TOTP(secret).at(clock[0]),
    })
    assert result.status_code == 200
    token = result.json()["access_token"]
    return token, secret


def access(token):
    return {"Authorization": "Bearer " + token}


def reauth(context, token, secret):
    client, clock, _ = context
    clock[0] += 30
    result = client.post("/admin/reauth", headers=access(token), json={
        "password": PASSWORD, "totp_code": pyotp.TOTP(secret).at(clock[0]),
    })
    assert result.status_code == 200
    return {**access(token), "X-Admin-Reauth": result.json()["reauth_token"]}


def test_admin_auth_flow(context):
    client, clock, _ = context
    assert client.post("/admin/login", json={"password": "admin"}).status_code == 401
    token, secret = enroll(context)
    assert auth.decode_access("Bearer " + token)["amr"] == ["pwd", "otp"]
    assert client.get("/admin/auth/status", headers=access(token)).json()["is_authenticated"] is True
    assert client.post("/admin/login/totp", json={"totp_code": "000000"}).status_code == 422
    challenge = client.post("/admin/login", json={"password": PASSWORD}).json()["challenge_token"]
    clock[0] += 30
    result = client.post("/admin/login/totp", json={"challenge_token": challenge, "totp_code": pyotp.TOTP(secret).at(clock[0])})
    assert result.status_code == 200
    assert client.post("/admin/login/totp", json={"challenge_token": challenge, "totp_code": pyotp.TOTP(secret).at(clock[0])}).status_code == 401


@pytest.mark.parametrize("path", ["/admin/password", "/admin/password/reset/request", "/admin/password/reset/confirm", "/admin/password/reset/emergency"])
def test_legacy_flows_are_gone(context, path):
    assert context[0].post(path, json={}).status_code == 410


def test_setup_requires_authorization_and_never_rereads_secret(context):
    client, _, _ = context
    token, _ = enroll(context)
    assert client.get("/admin/totp/setup").status_code == 410
    assert client.post("/admin/totp/setup").status_code == 401
    assert client.post("/admin/totp/setup", headers=access(token)).status_code == 401
    assert client.get("/admin/totp/mode").status_code == 401
    assert client.put("/admin/totp/mode", json={"mode": "off"}).status_code == 410


def test_password_change_preserves_mfa_and_revokes_every_old_token(context):
    client, _, _ = context
    token, secret = enroll(context)
    assert client.post("/admin/password/change", headers=access(token), json={
        "current_password": PASSWORD, "new_password": "ReplacementPassword!",
    }).status_code == 401
    headers = reauth(context, token, secret)
    challenge = client.post("/admin/login", json={"password": PASSWORD}).json()["challenge_token"]
    result = client.post("/admin/password/change", headers=headers, json={
        "current_password": PASSWORD, "new_password": "ReplacementPassword!",
    })
    assert result.status_code == 200
    assert auth.account()["mfa"] is True
    with pytest.raises(Exception) as exc:
        auth.decode_access("Bearer " + token)
    assert exc.value.status_code == 401
    assert client.post("/admin/login", json={"password": PASSWORD}).status_code == 401
    assert client.post("/admin/login", json={"password": "ReplacementPassword!"}).json()["status"] == "totp_required"
    assert client.post("/admin/login/totp", json={"challenge_token": challenge, "totp_code": "000000"}).status_code == 401


@pytest.mark.parametrize("bad_secret", [None, "plaintext-secret", "gAAAA-corrupt"])
def test_missing_or_undecryptable_secret_fails_closed(context, bad_secret):
    client, _, _ = context
    token, _ = enroll(context)
    update_state(auth.ACCOUNT_KEY, lambda s: {**s, "totp_secret": bad_secret})
    assert client.post("/admin/login", json={"password": PASSWORD}).status_code == 503
    assert client.get("/admin/totp/mode", headers=access(token)).status_code == 503
    assert auth.account()["mfa"] is True


def test_pending_enrollment_keeps_active_secret_until_verified(context):
    client, clock, _ = context
    token, secret = enroll(context)
    headers = reauth(context, token, secret)
    original = auth.account()["totp_secret"]
    first = client.post("/admin/totp/regenerate", headers=headers).json()
    second = client.post("/admin/totp/setup", headers=headers).json()
    assert first["provisioning_uri"] != second["provisioning_uri"]
    assert auth.account()["totp_secret"] == original
    assert auth.account()["mfa"] is True
    first_secret = parse_qs(urlparse(first["provisioning_uri"]).query)["secret"][0]
    assert client.post("/admin/totp/verify", headers=headers, json={"enrollment_id": first["enrollment_id"], "totp_code": pyotp.TOTP(first_secret).at(clock[0])}).status_code == 401
    secret2 = parse_qs(urlparse(second["provisioning_uri"]).query)["secret"][0]
    assert client.post("/admin/totp/verify", headers=headers, json={"enrollment_id": second["enrollment_id"], "totp_code": pyotp.TOTP(secret2).at(clock[0])}).status_code == 200
    assert auth.account()["totp_secret"] != original
    assert client.get("/admin/totp/mode", headers=access(token)).status_code == 401


def test_offline_recovery_is_one_time_and_revokes_immediately(context):
    client, _, _ = context
    token, _ = enroll(context)
    credential = auth.issue_offline_credential("recovery")
    assert credential not in json.dumps(auth.account())
    assert client.get("/admin/totp/mode", headers=access(token)).status_code == 401
    assert client.post("/admin/login", json={"password": PASSWORD}).status_code == 401
    payload = {"credential": credential, "new_password": "RecoveredPassword123!"}
    response = client.post("/admin/recovery", json=payload)
    assert response.status_code == 200
    assert "access_token" not in response.json()
    assert client.post("/admin/recovery", json=payload).status_code == 401
    assert client.post("/admin/login", json={"password": payload["new_password"]}).json()["status"] == "enrollment_required"
    assert client.get("/admin/totp/mode", headers=access(response.json()["enrollment_token"])).status_code == 401


@pytest.mark.parametrize("password", ["short", "a" * 73, "あ" * 25])
def test_password_byte_limits(context, password):
    client, _, _ = context
    credential = auth.issue_offline_credential("bootstrap")
    assert client.post("/admin/bootstrap", json={"credential": credential, "new_password": password}).status_code == 400
    assert client.post("/admin/login", json={"password": password}).status_code == 401


def test_challenge_attempt_bound_and_expiry(context):
    client, clock, _ = context
    _, secret = enroll(context)
    challenge = client.post("/admin/login", json={"password": PASSWORD}).json()["challenge_token"]
    for _ in range(5):
        assert client.post("/admin/login/totp", json={"challenge_token": challenge, "totp_code": "bad"}).status_code == 401
    clock[0] += 30
    assert client.post("/admin/login/totp", json={"challenge_token": challenge, "totp_code": pyotp.TOTP(secret).at(clock[0])}).status_code == 401
    challenge = client.post("/admin/login", json={"password": PASSWORD}).json()["challenge_token"]
    clock[0] += 301
    assert client.post("/admin/login/totp", json={"challenge_token": challenge, "totp_code": pyotp.TOTP(secret).at(clock[0])}).status_code == 401


def test_totp_replay_across_challenges(context):
    client, clock, _ = context
    _, secret = enroll(context)
    challenges = [client.post("/admin/login", json={"password": PASSWORD}).json()["challenge_token"] for _ in range(2)]
    clock[0] += 30
    code = pyotp.TOTP(secret).at(clock[0])
    assert client.post("/admin/login/totp", json={"challenge_token": challenges[0], "totp_code": code}).status_code == 200
    assert client.post("/admin/login/totp", json={"challenge_token": challenges[1], "totp_code": code}).status_code == 401


@pytest.mark.parametrize("mutate", [
    lambda c: c.pop("exp"), lambda c: c.pop("iat"), lambda c: c.pop("jti"),
    lambda c: c.pop("ver"), lambda c: c.pop("nbf"), lambda c: c.pop("purpose"),
    lambda c: c.update(aud="patient"), lambda c: c.update(purpose="reset"),
    lambda c: c.update(scope="push:manage"), lambda c: c.update(ver=True),
])
def test_jwt_required_claims_purpose_and_audience(context, mutate):
    client, _, _ = context
    token, _ = enroll(context)
    claims = jwt.get_unverified_claims(token)
    mutate(claims)
    forged = jwt.encode(claims, auth.SECRET_KEY, algorithm="HS256")
    assert client.get("/admin/totp/mode", headers=access(forged)).status_code in {401, 403}


def test_recent_reauth_bound_to_access_and_production_mfa(context, monkeypatch):
    client, clock, _ = context
    token, secret = enroll(context)
    headers = reauth(context, token, secret)
    challenge = client.post("/admin/login", json={"password": PASSWORD}).json()["challenge_token"]
    clock[0] += 30
    second = client.post("/admin/login/totp", json={"challenge_token": challenge, "totp_code": pyotp.TOTP(secret).at(clock[0])}).json()["access_token"]
    assert client.post("/admin/totp/disable", headers={**headers, **access(second)}).status_code == 401
    monkeypatch.setattr(auth, "admin_mfa_required", lambda: True)
    assert client.post("/admin/totp/disable", headers=headers).status_code == 403
    assert auth.account()["mfa"] is True


def test_expired_access_and_reauth_are_rejected(context):
    client, _, _ = context
    token, secret = enroll(context)
    claims = jwt.get_unverified_claims(token)
    claims.update(iat=int(time.time()) - 1000, nbf=int(time.time()) - 1000, exp=int(time.time()) - 100)
    expired = jwt.encode(claims, auth.SECRET_KEY, algorithm="HS256")
    assert client.get("/admin/totp/mode", headers=access(expired)).status_code == 401
    headers = reauth(context, token, secret)
    claims = jwt.get_unverified_claims(headers["X-Admin-Reauth"])
    claims.update(iat=int(time.time()) - 400, nbf=int(time.time()) - 400, exp=int(time.time()) - 100)
    headers["X-Admin-Reauth"] = jwt.encode(claims, auth.SECRET_KEY, algorithm="HS256")
    assert client.post("/admin/totp/disable", headers=headers).status_code == 401


def test_offline_expiry_attempts_and_bootstrap_overwrite_are_rejected(context):
    client, clock, _ = context
    credential = auth.issue_offline_credential("bootstrap", ttl=60)
    clock[0] += 61
    payload = {"credential": credential, "new_password": PASSWORD}
    assert client.post("/admin/bootstrap", json=payload).status_code == 401
    credential = auth.issue_offline_credential("bootstrap")
    for _ in range(5):
        assert client.post("/admin/bootstrap", json={**payload, "credential": "wrong"}).status_code == 401
    assert client.post("/admin/bootstrap", json={**payload, "credential": credential}).status_code == 401


def test_enrollment_attempt_limit_and_wrong_owner(context):
    client, clock, _ = context
    credential = auth.issue_offline_credential("bootstrap")
    token = client.post("/admin/bootstrap", json={"credential": credential, "new_password": PASSWORD}).json()["enrollment_token"]
    setup = client.post("/admin/totp/setup", headers=access(token)).json()
    for _ in range(5):
        assert client.post("/admin/totp/verify", headers=access(token), json={"enrollment_id": setup["enrollment_id"], "totp_code": "bad"}).status_code == 401
    secret = parse_qs(urlparse(setup["provisioning_uri"]).query)["secret"][0]
    assert client.post("/admin/totp/verify", headers=access(token), json={"enrollment_id": setup["enrollment_id"], "totp_code": pyotp.TOTP(secret).at(clock[0])}).status_code == 401
    token2 = client.post("/admin/login", json={"password": PASSWORD}).json()["enrollment_token"]
    assert client.post("/admin/totp/setup", headers=access(token)).status_code == 401
    assert client.post("/admin/totp/verify", headers=access(token2), json={"enrollment_id": setup["enrollment_id"], "totp_code": pyotp.TOTP(secret).at(clock[0])}).status_code == 401


def test_one_challenge_succeeds_only_once_concurrently(context):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi import HTTPException
    client, clock, _ = context
    _, secret = enroll(context)
    challenge = client.post("/admin/login", json={"password": PASSWORD}).json()["challenge_token"]
    clock[0] += 30
    code = pyotp.TOTP(secret).at(clock[0])
    def attempt(_):
        try:
            return auth.login_totp(challenge, code)["status"]
        except HTTPException as exc:
            return exc.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, range(2)))
    assert sorted(map(str, results)) == ["401", "ok"]


def test_local_disable_cannot_bypass_production_mfa(context, monkeypatch):
    client, _, _ = context
    token, secret = enroll(context)
    headers = reauth(context, token, secret)
    assert client.post("/admin/totp/disable", headers=headers).status_code == 200
    local = client.post("/admin/login", json={"password": PASSWORD}).json()["access_token"]
    monkeypatch.setattr(auth, "admin_mfa_required", lambda: True)
    assert client.get("/admin/totp/mode", headers=access(local)).status_code == 403
    assert client.post("/admin/login", json={"password": PASSWORD}).json()["status"] == "enrollment_required"


def test_exports_do_not_include_security_state(context):
    _, _, adapter = context
    enroll(context)
    assert "password_hash" not in json.dumps(adapter.export_questionnaire_settings())
    assert "totp_secret" not in json.dumps(adapter.export_sessions_data())
    assert adapter.export_sessions_data() == []
