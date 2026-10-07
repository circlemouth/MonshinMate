from fastapi.testclient import TestClient
import pytest
from app.main import app
from app import db
from app.db.sqlite_adapter import SQLiteAdapter
from security_support import bootstrap_admin_headers


@pytest.fixture
def client(tmp_path, monkeypatch):
    adapter = SQLiteAdapter(str(tmp_path / "database-status.sqlite3"))
    adapter.init()
    monkeypatch.setattr(db, "_adapter", adapter)
    with TestClient(app) as test_client:
        assert test_client.get("/system/database-status").status_code == 401
        test_client.headers.update(bootstrap_admin_headers(test_client))
        yield test_client


def test_database_status_sqlite(client) -> None:
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "sqlite"


def test_database_status_couchdb(client, monkeypatch) -> None:
    from app import main

    monkeypatch.setattr(main, "COUCHDB_URL", "http://dummy")
    monkeypatch.setattr(main, "get_current_persistence_backend", lambda: "sqlite")

    class Dummy:
        def info(self):
            return {}

    monkeypatch.setattr(main, "couch_db", Dummy())
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "couchdb"


def test_database_status_error(client, monkeypatch) -> None:
    from app import main

    monkeypatch.setattr(main, "COUCHDB_URL", "http://dummy")
    monkeypatch.setattr(main, "get_current_persistence_backend", lambda: "sqlite")

    class Dummy:
        def info(self):
            raise Exception("fail")

    monkeypatch.setattr(main, "couch_db", Dummy())
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "error"


def test_old_endpoint_removed(client) -> None:
    res = client.get("/system/couchdb-status")
    assert res.status_code == 404


def test_database_status_firestore(client, monkeypatch) -> None:
    from types import SimpleNamespace
    from app import main

    monkeypatch.setattr(main, "get_current_persistence_backend", lambda: "firestore")
    monkeypatch.setattr(main, "check_firestore_health", lambda: True)
    monkeypatch.setattr(
        main,
        "get_settings",
        lambda: SimpleNamespace(firestore=SimpleNamespace(use_emulator=False)),
    )
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "firestore"


def test_database_status_firestore_emulator(client, monkeypatch) -> None:
    from types import SimpleNamespace
    from app import main

    monkeypatch.setattr(main, "get_current_persistence_backend", lambda: "firestore")
    monkeypatch.setattr(main, "check_firestore_health", lambda: True)
    monkeypatch.setattr(
        main,
        "get_settings",
        lambda: SimpleNamespace(firestore=SimpleNamespace(use_emulator=True)),
    )
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "firestore_emulator"


def test_firestore_health_never_logs_provider_details(monkeypatch, caplog) -> None:
    class BrokenFirestore:
        name = "firestore"

        def health_check(self):
            raise RuntimeError("SYNTHETIC-PATIENT-AND-SECRET-MARKER")

    monkeypatch.setattr(db, "_adapter", BrokenFirestore())
    assert db.check_firestore_health() is False
    assert "firestore_health_check_failed" in caplog.text
    assert "SYNTHETIC-PATIENT-AND-SECRET-MARKER" not in caplog.text


def test_database_status_firestore_error(client, monkeypatch) -> None:
    from types import SimpleNamespace
    from app import main

    monkeypatch.setattr(main, "get_current_persistence_backend", lambda: "firestore")
    monkeypatch.setattr(main, "check_firestore_health", lambda: False)
    monkeypatch.setattr(
        main,
        "get_settings",
        lambda: SimpleNamespace(firestore=SimpleNamespace(use_emulator=False)),
    )
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "error"
