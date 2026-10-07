"""Persistent CAS, failure closure and production configuration regressions."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

import couchdb
from fastapi import HTTPException
import pytest

from app import db
from app.db import sqlite_adapter
from app.db.sqlite_adapter import SQLiteAdapter
from app.security_state import compare_and_swap_state, get_state, update_state


@pytest.fixture
def adapter(tmp_path, monkeypatch):
    instance = SQLiteAdapter(str(tmp_path / "state.sqlite3"))
    instance.init()
    monkeypatch.setattr(db, "_adapter", instance)
    return instance


def test_cas_persists_across_adapter_instances(adapter):
    assert get_state("test:counter") == (None, None)
    assert compare_and_swap_state("test:counter", None, {"count": 1})
    assert not compare_and_swap_state("test:counter", None, {"count": 2})
    revision, _ = get_state("test:counter")
    second = SQLiteAdapter(adapter.default_db_path)
    assert second.security_get_state("test:counter") == (revision, {"count": 1})
    assert second.security_compare_and_swap_state("test:counter", revision, {"count": 2})
    assert not compare_and_swap_state("test:counter", revision, {"count": 99})
    assert get_state("test:counter")[1] == {"count": 2}


def test_concurrent_updates_do_not_lose_writes(adapter):
    def increment(_):
        return update_state("test:concurrency", lambda state: {"count": (state or {}).get("count", 0) + 1})
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(increment, range(24)))
    assert get_state("test:concurrency")[1] == {"count": 24}


def test_state_failure_has_no_memory_fallback(adapter, monkeypatch):
    def fail(*args):
        raise OSError("unavailable")
    monkeypatch.setattr(adapter, "security_get_state", fail)
    with pytest.raises(HTTPException) as exc:
        get_state("test:unavailable")
    assert exc.value.status_code == 503
    with pytest.raises(HTTPException):
        update_state("test:unavailable", lambda state: {})


def test_contention_retry_is_bounded(adapter, monkeypatch):
    calls = []
    def conflict(*args):
        calls.append(1)
        return False
    monkeypatch.setattr(adapter, "security_compare_and_swap_state", conflict)
    with pytest.raises(HTTPException) as exc:
        update_state("test:contention", lambda state: {})
    assert exc.value.status_code == 503
    assert len(calls) == 12


def test_namespace_required(adapter):
    with pytest.raises(ValueError):
        get_state("unqualified")


class FakeCouch:
    """Revision CAS double, never contacts a real CouchDB server."""
    def __init__(self):
        self.docs = {}
        self.lock = threading.Lock()

    def get(self, key):
        value = self.docs.get(key)
        return json.loads(json.dumps(value)) if value else None

    def save(self, doc):
        with self.lock:
            old = self.docs.get(doc["_id"])
            if (old and old["_rev"] != doc.get("_rev")) or (not old and "_rev" in doc):
                raise couchdb.http.ResourceConflict()
            revision = str(int(old["_rev"]) + 1) if old else "1"
            self.docs[doc["_id"]] = {**json.loads(json.dumps(doc)), "_rev": revision}
            return doc["_id"], revision


def test_couch_revision_cas_and_no_sqlite_fallback(adapter, monkeypatch):
    fake = FakeCouch()
    monkeypatch.setattr(sqlite_adapter, "COUCHDB_URL", "http://synthetic.invalid")
    monkeypatch.setattr(adapter, "_security_couch_db", lambda: fake)
    assert get_state("test:couch") == (None, None)
    assert compare_and_swap_state("test:couch", None, {"count": 1})
    revision, _ = get_state("test:couch")
    assert compare_and_swap_state("test:couch", revision, {"count": 2})
    assert not compare_and_swap_state("test:couch", revision, {"count": 3})
    assert not compare_and_swap_state("test:couch", None, {"count": 4})
    def unavailable():
        raise OSError("Couch offline")
    monkeypatch.setattr(adapter, "_security_couch_db", unavailable)
    with pytest.raises(HTTPException) as exc:
        get_state("test:couch")
    assert exc.value.status_code == 503


@pytest.mark.parametrize("cloud", [False, True])
def test_production_missing_keys_fails_before_database_write(tmp_path, cloud):
    env = dict(os.environ)
    env.pop("SECRET_KEY", None)
    env.pop("TOTP_ENC_KEY", None)
    env["MONSHINMATE_ENV"] = "local" if cloud else "production"
    if cloud:
        env["K_SERVICE"] = "synthetic-cloud-service"
    target = tmp_path / "must-not-create.sqlite3"
    env["MONSHINMATE_DB"] = str(target)
    result = subprocess.run([sys.executable, "-c", "import app.db; app.db.init_db()"], env=env, capture_output=True, text=True)
    assert result.returncode != 0
    assert "Production SECRET_KEY" in result.stderr
    assert not target.exists()


@pytest.mark.parametrize("key", ["", "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="])
def test_production_missing_or_weak_encryption_key_is_rejected(tmp_path, key):
    import secrets
    env = dict(os.environ)
    env["MONSHINMATE_ENV"] = "production"
    env["SECRET_KEY"] = secrets.token_urlsafe(48)
    env["TOTP_ENC_KEY"] = key
    target = tmp_path / "must-not-create.sqlite3"
    env["MONSHINMATE_DB"] = str(target)
    result = subprocess.run([sys.executable, "-c", "import app.db; app.db.init_db()"], env=env, capture_output=True, text=True)
    assert result.returncode != 0
    assert "Production TOTP_ENC_KEY" in result.stderr
    assert not target.exists()


def test_firestore_without_security_cas_is_gated_before_constructor(tmp_path):
    module = tmp_path / "synthetic_firestore_adapter.py"
    module.write_text("class FirestoreAdapter:\n    def __init__(self, settings):\n        raise AssertionError('constructor must not run')\n")
    env = dict(os.environ)
    env["PERSISTENCE_BACKEND"] = "firestore"
    env["MONSHINMATE_FIRESTORE_ADAPTER"] = "synthetic_firestore_adapter:FirestoreAdapter"
    env["PYTHONPATH"] = str(tmp_path) + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run([sys.executable, "-c", "import app.db"], env=env, capture_output=True, text=True)
    assert result.returncode != 0
    assert "persistent security CAS support" in result.stderr
    assert "constructor must not run" not in result.stderr


def test_offline_tool_writes_only_private_one_time_credential(tmp_path):
    output = tmp_path / "credential.txt"
    target = tmp_path / "offline.sqlite3"
    tool = Path(__file__).resolve().parents[1] / "tools" / "provision_admin.py"
    command = [sys.executable, str(tool), "bootstrap", "--db", str(target), "--output", str(output), "--confirm"]
    result = subprocess.run(command, env=dict(os.environ), capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    credential = output.read_text().strip()
    assert len(credential) >= 64
    assert credential not in result.stdout + result.stderr
    assert output.stat().st_mode & 0o777 == 0o600
    state = SQLiteAdapter(str(target)).security_get_state("admin:account:v1")[1]
    assert state["locked"] is True
    assert credential not in json.dumps(state)
    second = subprocess.run(command, env=dict(os.environ), capture_output=True, text=True)
    assert second.returncode != 0
    assert output.read_text().strip() == credential
