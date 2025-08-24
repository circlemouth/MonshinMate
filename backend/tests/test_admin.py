from pathlib import Path
import sys
import time
import sqlite3

from fastapi.testclient import TestClient
import pyotp

# DBを初期化してクリーンな状態からテストする
DB_PATH = Path(__file__).resolve().parents[1] / "app" / "app.sqlite3"
if DB_PATH.exists():
    DB_PATH.unlink()

sys.path.append(str(Path(__file__).resolve().parents[1]))
from app.main import app
from app.db import get_user_by_username, init_db

client = TestClient(app)

def test_admin_auth_flow():
    """管理者認証の全フロー（初期設定→PW変更→TOTP設定→2FAログイン→PWリセット）をテストする。"""
    
    # === Step 1: 初期状態の確認 ===
    res = client.get("/admin/auth/status")
    assert res.status_code == 200
    data = res.json()
    assert data["is_initial_password"] is True
    assert data["is_totp_enabled"] is False

    # === Step 2: パスワード変更 ===
    new_password = "MyNewSecurePassword123"
    res = client.post("/admin/password", json={"password": new_password})
    assert res.status_code == 200

    # === Step 3: 通常ログイン ===
    res = client.post("/admin/login", json={"password": new_password})
    assert res.status_code == 200

    # === Step 4: TOTP設定 ===
    res = client.get("/admin/totp/setup")
    assert res.status_code == 200
    admin_user = get_user_by_username("admin")
    assert admin_user is not None
    secret = admin_user["totp_secret"]
    assert secret is not None
    totp = pyotp.TOTP(secret)
    res = client.post("/admin/totp/verify", json={"totp_code": totp.now()})
    assert res.status_code == 200

    # === Step 5: 2段階認証ログイン ===
    res = client.post("/admin/login", json={"password": new_password})
    assert res.status_code == 200
    assert res.json() == {"status": "totp_required"}
    res = client.post("/admin/login/totp", json={"totp_code": totp.now()})
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "message": "Login successful"}

    # === Step 6: パスワードリセット ===
    # 不正なTOTPコードでリセット要求 → 失敗
    res = client.post("/admin/password/reset/request", json={"totp_code": "000000"})
    assert res.status_code == 401

    # 正しいTOTPコードでリセット要求 → 成功、トークン取得
    res = client.post("/admin/password/reset/request", json={"totp_code": totp.now()})
    assert res.status_code == 200
    reset_token = res.json()["reset_token"]
    assert reset_token

    # トークンを使ってパスワードをリセット
    password_after_reset = "ResetPassword456"
    res = client.post(
        "/admin/password/reset/confirm",
        json={"token": reset_token, "new_password": password_after_reset},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "ok"

    # === Step 7: リセット後の最終確認 ===
    # 古いパスワードでログイン → 失敗
    res = client.post("/admin/login", json={"password": new_password})
    assert res.status_code == 401

    # 新しいパスワードでログイン → 成功（2段階認証）
    res = client.post("/admin/login", json={"password": password_after_reset})
    assert res.status_code == 200
    assert res.json() == {"status": "totp_required"}

    res = client.post("/admin/login/totp", json={"totp_code": totp.now()})
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_totp_flag_without_secret_disables_totp_on_login():
    """TOTPフラグが有効なのにシークレットが無い場合、自動で無効化されることを確認。"""
    if DB_PATH.exists():
        DB_PATH.unlink()
    init_db()
    local_client = TestClient(app)
    # DB初期化のためにステータス確認
    res = local_client.get("/admin/auth/status")
    assert res.status_code == 200

    # シークレット無しでTOTPフラグだけ有効化
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE users SET is_totp_enabled=1, totp_mode='login_and_reset', totp_secret=NULL WHERE username='admin'"
    )
    conn.commit()
    conn.close()

    # 正しいパスワードでログインすると自動的にTOTPが無効化される
    res = local_client.post("/admin/login", json={"password": "admin"})
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
    admin_user = get_user_by_username("admin")
    assert admin_user["is_totp_enabled"] == 0
    assert admin_user["totp_mode"] == "off"
