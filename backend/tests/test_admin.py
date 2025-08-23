from pathlib import Path
import sys

from fastapi.testclient import TestClient

# DB を初期化してクリーンな状態からテストする
DB_PATH = Path(__file__).resolve().parents[1] / "app" / "app.sqlite3"
if DB_PATH.exists():
    DB_PATH.unlink()

sys.path.append(str(Path(__file__).resolve().parents[1]))
from app.main import app  # type: ignore[import]

client = TestClient(app)


def test_admin_password_setup_and_login():
    # 初期状態では既定パスワードのまま
    res = client.get("/admin/password/status")
    assert res.status_code == 200
    assert res.json()["is_default"] is True

    # 新しいパスワードを設定
    res = client.post("/admin/password", json={"password": "newpass"})
    assert res.status_code == 200

    # 既定状態ではなくなる
    res = client.get("/admin/password/status")
    assert res.status_code == 200
    assert res.json()["is_default"] is False

    # 新パスワードでログイン成功
    res = client.post("/admin/login", json={"password": "newpass"})
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}

    # 旧パスワードでは失敗
    res = client.post("/admin/login", json={"password": "admin"})
    assert res.status_code == 401
