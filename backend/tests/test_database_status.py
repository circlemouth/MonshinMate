from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_database_status_sqlite() -> None:
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "sqlite"


def test_database_status_couchdb(monkeypatch) -> None:
    from app import main

    monkeypatch.setattr(main, "COUCHDB_URL", "http://dummy")

    class Dummy:
        def info(self):
            return {}

    monkeypatch.setattr(main, "couch_db", Dummy())
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "couchdb"


def test_database_status_error(monkeypatch) -> None:
    from app import main

    monkeypatch.setattr(main, "COUCHDB_URL", "http://dummy")

    class Dummy:
        def info(self):
            raise Exception("fail")

    monkeypatch.setattr(main, "couch_db", Dummy())
    res = client.get("/system/database-status")
    assert res.status_code == 200
    assert res.json()["status"] == "error"


def test_old_endpoint_removed() -> None:
    res = client.get("/system/couchdb-status")
    assert res.status_code == 404
