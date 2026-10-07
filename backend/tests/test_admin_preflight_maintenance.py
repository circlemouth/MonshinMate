"""Synthetic read-only migration preflight and independent maintenance entry point."""
from __future__ import annotations

import importlib.util
import json
import logging
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from types import SimpleNamespace

import bcrypt
import pytest
from starlette.testclient import TestClient

from app.maintenance import app as maintenance

spec = importlib.util.spec_from_file_location("preflight_tool", Path(__file__).parents[1] / "tools/provision_admin.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


@pytest.fixture
def legacy_db(tmp_path, monkeypatch):
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    monkeypatch.delenv("COUCHDB_URL", raising=False)
    path = tmp_path / "synthetic.sqlite3"
    hashed = bcrypt.hashpw(b"OldSafe9!", bcrypt.gensalt(4)).decode()
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE users (username TEXT, hashed_password TEXT, is_initial_password INTEGER, is_totp_enabled INTEGER, totp_mode TEXT, totp_secret TEXT)")
        connection.execute("INSERT INTO users VALUES (?,?,?,?,?,?)", ("admin", hashed, 0, 0, "off", None))
    return path, hashed


def run_cli(monkeypatch, path):
    monkeypatch.setattr(sys, "argv", ["provision_admin", "preflight-legacy", "--db", str(path), "--confirm"])
    provision.main()


def test_preflight_sqlite_has_no_writes_and_no_application_imports(legacy_db, monkeypatch, capsys):
    path, hashed = legacy_db
    before = path.read_bytes()
    before_names = sorted(item.name for item in path.parent.iterdir())
    import builtins
    real_import = builtins.__import__
    def guard(name, *args, **kwargs):
        if name == "app" or name.startswith("app."):
            pytest.fail("SQLite preflight must not import application adapters")
        return real_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guard)
    run_cli(monkeypatch, path)
    output = capsys.readouterr()
    assert json.loads(output.out) == {"eligibility": "eligible", "reason": "eligible"}
    assert output.err == ""
    assert hashed not in output.out
    assert "OldSafe9!" not in output.out
    assert path.read_bytes() == before
    assert sorted(item.name for item in path.parent.iterdir()) == before_names
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [("users",)]


@pytest.mark.parametrize("change,reason", [
    ("DELETE FROM users", "legacy_absent"),
    ("UPDATE users SET is_initial_password=1", "initial_or_unclassified"),
    ("UPDATE users SET is_initial_password=NULL", "initial_or_unclassified"),
    ("UPDATE users SET is_totp_enabled=1", "legacy_mfa_or_protected"),
    ("UPDATE users SET totp_mode='reset_only'", "legacy_mfa_or_protected"),
    ("UPDATE users SET totp_secret='synthetic-secret'", "legacy_mfa_or_protected"),
    ("UPDATE users SET hashed_password='synthetic-malformed-hash'", "hash_invalid"),
])
def test_preflight_fixed_refusal_enums(legacy_db, change, reason):
    path, _ = legacy_db
    with sqlite3.connect(path) as connection:
        connection.execute(change)
    before = path.read_bytes()
    assert provision.preflight_legacy_admin(db_path=path) == {"eligibility": "ineligible", "reason": reason}
    assert path.read_bytes() == before


def test_preflight_default_and_existing_shared_state(legacy_db):
    path, _ = legacy_db
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE users SET hashed_password=?", (bcrypt.hashpw(b"admin", bcrypt.gensalt(4)).decode(),))
    assert provision.preflight_legacy_admin(db_path=path)["reason"] == "known_default"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE security_state (key TEXT PRIMARY KEY, revision INTEGER, value TEXT)")
        connection.execute("INSERT INTO security_state VALUES ('admin:account:v1',1,'{}')")
        connection.execute("DROP TABLE users")
    before = path.read_bytes()
    assert provision.preflight_legacy_admin(db_path=path)["reason"] == "shared_state_exists"
    assert path.read_bytes() == before


def test_preflight_missing_database_never_creates_it(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    path = tmp_path / "not-created.sqlite3"
    with pytest.raises(SystemExit) as error:
        run_cli(monkeypatch, path)
    assert error.value.code == 1
    output = capsys.readouterr()
    assert json.loads(output.out) == {"eligibility": "unavailable", "reason": "backend_unavailable"}
    assert output.err == ""
    assert not path.exists()


@pytest.mark.parametrize("setting", [None, "1", "", "false"])
def test_preflight_requires_explicit_policy_before_read(monkeypatch, setting):
    monkeypatch.delenv("MONSHINMATE_ADMIN_REQUIRE_MFA", raising=False)
    if setting is not None:
        monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", setting)
    monkeypatch.setattr(provision, "_read_configured_legacy", lambda: pytest.fail("No read without optional policy"))
    assert provision.preflight_legacy_admin() == {"eligibility": "ineligible", "reason": "policy_not_optional"}


def test_preflight_remote_only_calls_explicit_readonly_hook(monkeypatch):
    from app import db
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    monkeypatch.delenv("COUCHDB_URL", raising=False)
    called = []
    def readonly():
        called.append("read")
        return True, None
    monkeypatch.setattr(db, "get_active_adapter", lambda: SimpleNamespace(read_legacy_admin_preflight=readonly))
    monkeypatch.setattr(db, "init_db", lambda: pytest.fail("preflight must never init"))
    monkeypatch.setattr(db, "security_compare_and_swap_state", lambda *args: pytest.fail("preflight must never CAS"))
    monkeypatch.setattr(db, "get_user_by_username", lambda *args: pytest.fail("preflight must not decrypt legacy secrets"))
    assert provision.preflight_legacy_admin()["reason"] == "shared_state_exists"
    assert called == ["read"]


def test_preflight_remote_missing_hook_never_falls_back(monkeypatch):
    from app import db
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    monkeypatch.delenv("COUCHDB_URL", raising=False)
    monkeypatch.setattr(db, "get_active_adapter", lambda: SimpleNamespace())
    assert provision.preflight_legacy_admin()["reason"] == "backend_unavailable"


def test_preflight_couch_refuses_before_adapter_import(monkeypatch):
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    monkeypatch.setenv("COUCHDB_URL", "http://synthetic.invalid")
    import builtins
    real_import = builtins.__import__
    def guard(name, *args, **kwargs):
        if name == "app" or name.startswith("app."):
            pytest.fail("CouchDB preflight must refuse before mutating import")
        return real_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guard)
    assert provision.preflight_legacy_admin()["reason"] == "backend_unavailable"


@pytest.mark.parametrize("arguments", [[], ["--configured-backend"],
    ["--configured-backend", "--confirm", "--password", "synthetic-secret"]])
def test_preflight_argument_errors_are_enums_only(monkeypatch, capsys, arguments):
    monkeypatch.setattr(sys, "argv", ["provision_admin", "preflight-legacy", *arguments])
    monkeypatch.setattr(provision, "preflight_legacy_admin", lambda **kwargs: pytest.fail("Invalid arguments must not read"))
    with pytest.raises(SystemExit) as error:
        provision.main()
    assert error.value.code == 2
    output = capsys.readouterr()
    assert json.loads(output.out) == {"eligibility": "ineligible", "reason": "invalid_arguments"}
    assert output.err == ""
    assert "synthetic-secret" not in output.out


def test_preflight_redacts_library_output_and_exceptions(monkeypatch, capsys):
    monkeypatch.setenv("MONSHINMATE_ADMIN_REQUIRE_MFA", "0")
    def failing_read():
        print("synthetic-sensitive-stdout")
        print("synthetic-sensitive-stderr", file=sys.stderr)
        logging.error("synthetic-sensitive-log")
        raise RuntimeError("synthetic-sensitive-exception")
    monkeypatch.setattr(provision, "_read_configured_legacy", failing_read)
    result = provision.preflight_legacy_admin()
    output = capsys.readouterr()
    assert output.out == output.err == ""
    assert result == {"eligibility": "unavailable", "reason": "backend_unavailable"}


@pytest.mark.parametrize("method,path", [("GET", "/"), ("GET", "/admin/auth/status"),
    ("POST", "/admin/login"), ("POST", "/sessions"), ("PUT", "/settings"),
    ("DELETE", "/sessions/synthetic"), ("OPTIONS", "/anything"), ("POST", "/healthz"), ("HEAD", "/")])
def test_maintenance_catchall_no_store(method, path):
    with TestClient(maintenance) as client:
        response = client.request(method, path, content=b"synthetic-secret-not-echoed")
    assert response.status_code == 503
    assert response.headers["retry-after"] == "300"
    assert response.headers["cache-control"] == "no-store"
    assert "synthetic-secret" not in response.text
    if method == "HEAD":
        assert response.content == b""


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_maintenance_health_safe(method):
    with TestClient(maintenance) as client:
        response = client.request(method, "/healthz")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    if method == "GET":
        assert response.json() == {"status": "maintenance"}


def test_maintenance_import_does_not_import_application_or_validate_keys():
    code = '''
import importlib.abc, sys
class Guard(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith("app.") and fullname != "app.maintenance":
            raise AssertionError("Forbidden application import")
sys.meta_path.insert(0, Guard())
from app.maintenance import app
assert callable(app)
assert "app.db" not in sys.modules and "app.main" not in sys.modules
'''
    env = {**os.environ, "MONSHINMATE_ENV": "production", "SECRET_KEY": "", "TOTP_ENC_KEY": "",
           "MONSHINMATE_ADMIN_REQUIRE_MFA": "invalid"}
    result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0
    assert result.stdout == result.stderr == ""
