"""Synthetic-only password policy and explicit offline migration regressions."""
from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import bcrypt
import pytest
from fastapi import HTTPException

from app import admin_security as auth, db, security_config, security_state
from test_admin import context, enroll, reauth, access, PASSWORD  # noqa: F401

spec = importlib.util.spec_from_file_location("provision_admin", Path(__file__).parents[1] / "tools/provision_admin.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


@pytest.fixture
def optional(context, monkeypatch):
    monkeypatch.setenv("K_SERVICE", "synthetic-production")
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    return context


def bootstrap(context):
    credential = auth.issue_offline_credential("bootstrap")
    return auth.consume_offline_credential("bootstrap", credential, PASSWORD)["access_token"]


def test_production_password_only_change_and_revocation(optional):
    client, _, _ = optional
    token = bootstrap(optional)
    assert auth.decode_access("Bearer " + token)["amr"] == ["pwd"]
    assert auth.auth_status("Bearer " + token)["mfa_required"] is False
    assert client.post("/admin/login", json={"password": PASSWORD}).json()["status"] == "ok"
    assert client.post("/admin/reauth", headers=access(token), json={"password": "wrong"}).status_code == 401
    result = client.post("/admin/reauth", headers=access(token), json={"password": PASSWORD})
    recent = result.json()["reauth_token"]
    assert client.post("/admin/password/change", headers=access(token), json={
        "current_password": PASSWORD, "new_password": "ChangedPassword123!"}).status_code == 401
    other = auth.login(PASSWORD)["access_token"]
    with pytest.raises(HTTPException):
        auth.change_password("Bearer " + other, recent, PASSWORD, "ChangedPassword123!")
    auth.change_password("Bearer " + token, recent, PASSWORD, "ChangedPassword123!")
    assert auth.account()["mfa"] is False
    for old in (token, other):
        with pytest.raises(HTTPException) as error:
            auth.decode_access("Bearer " + old)
        assert error.value.status_code == 401
    assert client.post("/admin/login", json={"password": PASSWORD}).status_code == 401
    assert auth.login("ChangedPassword123!")["status"] == "ok"


def test_optional_recovery_one_use_and_immediate_revocation(optional):
    token = bootstrap(optional)
    credential = auth.issue_offline_credential("recovery")
    with pytest.raises(HTTPException):
        auth.decode_access("Bearer " + token)
    with pytest.raises(HTTPException):
        auth.login(PASSWORD)
    result = auth.consume_offline_credential("recovery", credential, "RecoveredPassword123!")
    assert result["status"] == "ok"
    assert "enrollment_token" not in result
    with pytest.raises(HTTPException):
        auth.consume_offline_credential("recovery", credential, "RecoveredPassword123!")


@pytest.mark.parametrize("setting,production,expected", [(None, True, True), (None, False, False),
    ("0", True, False), ("1", False, True), ("1", True, True)])
def test_policy_defaults_and_overrides(monkeypatch, setting, production, expected):
    monkeypatch.setattr(security_config, "is_production", lambda: production)
    monkeypatch.delenv("MONSHINMATE_ADMIN_REQUIRE_MFA", raising=False)
    if setting is not None:
        monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", setting)
    assert security_config.admin_mfa_required() is expected


@pytest.mark.parametrize("setting", ["", "false", "true", "2", " 0", "0 ", "01"])
def test_malformed_policy_fails_closed(optional, monkeypatch, setting):
    token = bootstrap(optional)
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", setting)
    for operation in (security_config.validate_security_configuration, lambda: auth.login(PASSWORD),
                      lambda: auth.decode_access("Bearer " + token), lambda: auth.auth_status(None)):
        with pytest.raises(RuntimeError, match="exactly 0 or 1"):
            operation()


@pytest.mark.parametrize("setting", [None, "1"])
def test_production_mandatory_still_enrolls(context, monkeypatch, setting):
    monkeypatch.setenv("K_SERVICE", "synthetic-production")
    monkeypatch.delenv("MONSHINMATE_ADMIN_REQUIRE_MFA", raising=False)
    if setting:
        monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", setting)
    credential = auth.issue_offline_credential("bootstrap")
    result = auth.consume_offline_credential("bootstrap", credential, PASSWORD)
    assert result["status"] == "enrollment_required"
    assert "access_token" not in result
    assert auth.auth_status(None)["mfa_required"] is True


def test_policy_switch_does_not_clear_existing_enrollment(context, monkeypatch):
    credential = auth.issue_offline_credential("bootstrap")
    auth.consume_offline_credential("bootstrap", credential, PASSWORD)
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    assert auth.login(PASSWORD)["status"] == "enrollment_required"
    assert auth.auth_status(None)["mfa_required"] is True


def test_optional_keeps_existing_mfa_and_disable_safeguards(context, monkeypatch):
    token, secret = enroll(context)
    monkeypatch.setenv("K_SERVICE", "synthetic-production")
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    assert auth.login(PASSWORD)["status"] == "totp_required"
    with pytest.raises(HTTPException):
        auth.reauthenticate("Bearer " + token, PASSWORD, None)
    with pytest.raises(HTTPException):
        auth.disable_totp("Bearer " + token, None)
    headers = reauth(context, token, secret)
    auth.disable_totp(headers["Authorization"], headers["X-Admin-Reauth"])
    with pytest.raises(HTTPException):
        auth.decode_access("Bearer " + token)
    assert auth.login(PASSWORD)["status"] == "ok"


@pytest.mark.parametrize("changes", [
    {"mfa": True, "totp_secret": None}, {"mfa": "false"}, {"mfa": None},
    {"enrollment_required": None}, {"locked": "false"}, {"version": True},
    {"totp_secret": "unexpected"}, {"pending": {"id": "synthetic"}},
    {"locked": True}, {"offline": {"kind": "recovery"}}, {"offline": {}}, {"pending": {}},
    {"enrollment_grant": "synthetic-stale-grant"},
])
def test_protected_or_malformed_account_never_password_only(optional, changes):
    token = bootstrap(optional)
    security_state.update_state(auth.ACCOUNT_KEY, lambda state: {**state, **changes})
    with pytest.raises(HTTPException):
        auth.login(PASSWORD)
    with pytest.raises(HTTPException):
        auth.decode_access("Bearer " + token)


def test_password_only_rate_limit_and_scope(optional):
    token = bootstrap(optional)
    recent = auth.reauthenticate("Bearer " + token, PASSWORD, None)["reauth_token"]
    with pytest.raises(HTTPException):
        auth.decode_access("Bearer " + recent)
    for _ in range(20):
        with pytest.raises(HTTPException):
            auth.login("bad")
    with pytest.raises(HTTPException) as error:
        auth.login(PASSWORD)
    assert error.value.status_code == 429


@pytest.fixture
def legacy(optional, monkeypatch):
    # Intentionally below today's length requirement: migration MUST reuse it.
    record = {"username": "admin", "hashed_password": bcrypt.hashpw(b"OldSafe9!", bcrypt.gensalt(4)).decode(),
              "is_initial_password": 0, "is_totp_enabled": 0, "totp_mode": "off", "totp_secret": None}
    monkeypatch.setattr(db, "get_user_by_username", lambda username: copy.deepcopy(record))
    return record


def migrate():
    provision.migrate_legacy_admin(confirmed=True, acknowledge_password_only=True)


def test_migration_exact_hash_short_password_reuse_and_idempotency(legacy):
    before = copy.deepcopy(legacy)
    migrate()
    assert auth.account()["password_hash"] == before["hashed_password"]
    assert legacy == before
    assert auth.login("OldSafe9!")["status"] == "ok"
    snapshot = security_state.get_state(auth.ACCOUNT_KEY)
    with pytest.raises(HTTPException) as error:
        migrate()
    assert error.value.status_code == 409
    assert security_state.get_state(auth.ACCOUNT_KEY) == snapshot


@pytest.mark.parametrize("existing", [{}, {"locked": True}, {"offline": {"kind": "bootstrap"}},
                                       {"pending": {}}, {"password_hash": "synthetic"}])
def test_migration_refuses_every_existing_record(legacy, existing, monkeypatch):
    security_state.update_state(auth.ACCOUNT_KEY, lambda _: existing)
    def unexpected_read(_):
        pytest.fail("Existing new state must be rejected before legacy read")
    monkeypatch.setattr(db, "get_user_by_username", unexpected_read)
    with pytest.raises(HTTPException) as error:
        migrate()
    assert error.value.status_code == 409
    assert auth.account() == existing


@pytest.mark.parametrize("changes", [
    {"username": "other"}, {"is_initial_password": True}, {"is_initial_password": None},
    {"is_initial_password": "0"}, {"is_totp_enabled": 1}, {"is_totp_enabled": None},
    {"totp_mode": "reset_only"}, {"totp_mode": "login_and_reset"}, {"totp_mode": None},
    {"totp_secret": "synthetic"}, {"locked": True}, {"hashed_password": "not-a-hash"},
    {"hashed_password": None}, {"hashed_password": "$2b$99$" + "A" * 53},
    {"hashed_password": "$2b$04$" + "!" * 53},
])
def test_migration_refuses_unsafe_legacy(legacy, changes):
    legacy.update(changes)
    with pytest.raises(ValueError):
        migrate()
    assert security_state.get_state(auth.ACCOUNT_KEY) == (None, None)


def test_migration_refuses_known_default_even_with_noninitial_flag(legacy):
    legacy["hashed_password"] = bcrypt.hashpw(b"admin", bcrypt.gensalt(4)).decode()
    with pytest.raises(ValueError, match="default"):
        migrate()
    assert auth.account() == {}


def test_migration_cas_conflict_never_overwrites(legacy, monkeypatch):
    original = security_state.compare_and_swap_state
    def race(key, revision, state):
        assert revision is None
        assert original(key, None, {"locked": True, "offline": {"kind": "recovery"}})
        return original(key, revision, state)
    monkeypatch.setattr(security_state, "compare_and_swap_state", race)
    with pytest.raises(HTTPException) as error:
        migrate()
    assert error.value.status_code == 409
    assert auth.account() == {"locked": True, "offline": {"kind": "recovery"}}


@pytest.mark.parametrize("confirmed,acknowledged,policy", [(False, True, "0"), (True, False, "0"),
    (True, True, "1"), (True, True, None), (True, True, "false")])
def test_migration_requires_explicit_authorization(legacy, monkeypatch, confirmed, acknowledged, policy):
    monkeypatch.delenv("MONSHINMATE_ADMIN_REQUIRE_MFA", raising=False)
    if policy is not None:
        monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", policy)
    with pytest.raises((ValueError, RuntimeError)):
        provision.migrate_legacy_admin(confirmed=confirmed, acknowledge_password_only=acknowledged)
    assert auth.account() == {}


@pytest.mark.parametrize("arguments", [[], ["--db", "synthetic.sqlite3"],
    ["--db", "synthetic.sqlite3", "--confirm"],
    ["--confirm", "--acknowledge-password-only"]])
def test_cli_requires_target_confirmation_ack_before_io(optional, monkeypatch, arguments):
    monkeypatch.setattr("sys.argv", ["provision_admin", "migrate-legacy", *arguments])
    monkeypatch.setattr(db, "init_db", lambda: pytest.fail("Unsafe CLI reached persistence"))
    with pytest.raises(SystemExit) as error:
        provision.main()
    assert error.value.code == 2


def test_cli_migration_prints_no_credentials(legacy, monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(db, "init_db", lambda: None)
    monkeypatch.setattr("sys.argv", ["provision_admin", "migrate-legacy", "--db", str(tmp_path / "synthetic.sqlite3"),
                                    "--confirm", "--acknowledge-password-only"])
    provision.main()
    output = capsys.readouterr()
    assert "existing password unchanged" in output.out
    assert legacy["hashed_password"] not in output.out + output.err
    assert "OldSafe9!" not in output.out + output.err
    assert auth.login("OldSafe9!")["status"] == "ok"


def test_cli_migration_sanitizes_backend_errors(optional, monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(db, "init_db", lambda: None)
    def failed_read(_):
        raise RuntimeError("synthetic-secret-must-not-be-printed")
    monkeypatch.setattr(db, "get_user_by_username", failed_read)
    monkeypatch.setattr("sys.argv", ["provision_admin", "migrate-legacy", "--db", str(tmp_path / "synthetic.sqlite3"),
                                    "--confirm", "--acknowledge-password-only"])
    with pytest.raises(SystemExit) as error:
        provision.main()
    assert error.value.code == 1
    output = capsys.readouterr()
    assert "synthetic-secret" not in output.out + output.err
    assert "compatibility" in output.err
    assert auth.account() == {}


def test_http_never_automigrates_or_uses_environment_password(legacy, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "OldSafe9!")
    monkeypatch.setenv("ADMIN_EMERGENCY_RESET_PASSWORD", "OldSafe9!")
    def forbidden_read(_):
        pytest.fail("HTTP authentication must not read legacy users")
    monkeypatch.setattr(db, "get_user_by_username", forbidden_read)
    with pytest.raises(HTTPException) as error:
        auth.login("OldSafe9!")
    assert error.value.status_code == 401
    assert security_state.get_state(auth.ACCOUNT_KEY) == (None, None)


def test_policy_tightening_revokes_password_only_and_persists_enrollment(optional, monkeypatch):
    token = bootstrap(optional)
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "1")
    with pytest.raises(HTTPException) as error:
        auth.decode_access("Bearer " + token)
    assert error.value.status_code == 403
    result = auth.login(PASSWORD)
    assert result["status"] == "enrollment_required"
    assert auth.account()["enrollment_required"] is True
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    assert auth.login(PASSWORD)["status"] == "enrollment_required"


@pytest.mark.parametrize("expired", [False, True])
def test_voluntary_setup_does_not_lock_out_password_only_login(optional, expired):
    from urllib.parse import parse_qs, urlparse
    import pyotp
    token = bootstrap(optional)
    authorization = "Bearer " + token
    recent = auth.reauthenticate(authorization, PASSWORD, None)["reauth_token"]
    setup = auth.setup_totp(authorization, recent)
    assert auth.account()["pending"]["kind"] == "voluntary"
    assert auth.account()["enrollment_required"] is False
    if expired:
        security_state.update_state(auth.ACCOUNT_KEY, lambda s: {**s, "pending": {**s["pending"], "exp": auth._now() - 1}})
    fresh = auth.login(PASSWORD)
    assert fresh["status"] == "ok"
    assert auth.decode_access("Bearer " + fresh["access_token"])["amr"] == ["pwd"]
    if expired:
        assert auth.account()["pending"] is None
    else:
        secret = parse_qs(urlparse(setup["provisioning_uri"]).query)["secret"][0]
        verified = auth.verify_enrollment(authorization, recent, setup["enrollment_id"], pyotp.TOTP(secret).at(auth._now()))
        assert auth.decode_access("Bearer " + verified["access_token"])["amr"] == ["pwd", "otp"]
        with pytest.raises(HTTPException):
            auth.decode_access("Bearer " + fresh["access_token"])


def test_concurrent_migrations_only_one_wins(legacy):
    from concurrent.futures import ThreadPoolExecutor
    def attempt(_):
        try:
            migrate()
            return "ok"
        except HTTPException as error:
            return str(error.status_code)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, range(2))) == ["409", "ok"]
    assert auth.account()["password_hash"] == legacy["hashed_password"]
