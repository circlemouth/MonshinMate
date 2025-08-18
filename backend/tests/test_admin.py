from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.append(str(Path(__file__).resolve().parents[1]))
from app.main import app  # type: ignore[import]

client = TestClient(app)

def test_admin_login_success():
    res = client.post("/admin/login", json={"password": "admin"})
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}

def test_admin_login_failure():
    res = client.post("/admin/login", json={"password": "wrong"})
    assert res.status_code == 401
