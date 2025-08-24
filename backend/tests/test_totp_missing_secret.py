from pathlib import Path
import sys

from fastapi.testclient import TestClient

DB_PATH = Path(__file__).resolve().parents[1] / "app" / "app.sqlite3"

sys.path.append(str(Path(__file__).resolve().parents[1]))
from app.main import app
from app.db import get_user_by_username, get_conn, init_db


def test_login_disables_totp_when_secret_missing():
    """TOTP有効フラグのみ立っている状態ではログイン時に自動無効化されること"""
    if DB_PATH.exists():
        DB_PATH.unlink()
    init_db()
    client = TestClient(app)

    new_password = "TempPass123!"
    res = client.post("/admin/password", json={"password": new_password})
    assert res.status_code == 200

    conn = get_conn()
    conn.execute(
        "UPDATE users SET is_totp_enabled=1, totp_mode='login_and_reset', totp_secret=NULL WHERE username='admin'"
    )
    conn.commit()
    conn.close()

    res = client.post("/admin/login", json={"password": new_password})
    assert res.status_code == 200
    assert res.json()["status"] == "ok"

    admin_user = get_user_by_username("admin")
    assert admin_user["is_totp_enabled"] == 0
    assert admin_user["totp_mode"] == "off"
