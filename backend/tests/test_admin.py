from pathlib import Path
import sys
import time
import sqlite3
import os
import json

from fastapi.testclient import TestClient
import pyotp

# DBを初期化してクリーンな状態からテストする
DB_PATH = Path(__file__).resolve().parents[1] / "app" / "app.sqlite3"
if DB_PATH.exists():
    DB_PATH.unlink()

sys.path.append(str(Path(__file__).resolve().parents[1]))
from app.main import app
from app.db import get_user_by_username, init_db, fernet, verify_password

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
    conn = sqlite3.connect(DB_PATH)
    raw_secret = conn.execute("SELECT totp_secret FROM users WHERE username='admin'").fetchone()[0]
    conn.close()
    assert raw_secret != secret
    assert fernet.decrypt(raw_secret.encode()).decode() == secret
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
    assert res.json()["detail"] == "パスワードが間違っています"

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


def test_totp_mode_change_does_not_enable_without_verification():
    """TOTPモード変更だけでは有効化されないことを確認する。"""
    if DB_PATH.exists():
        DB_PATH.unlink()
    init_db()
    local_client = TestClient(app)

    # QRコード生成とモード設定（旧仕様ではここで有効化されていた）
    res = local_client.get("/admin/totp/setup")
    assert res.status_code == 200
    res = local_client.put("/admin/totp/mode", json={"mode": "login_and_reset"})
    assert res.status_code == 200

    # 検証前は is_totp_enabled が False のまま
    status = local_client.get("/admin/auth/status").json()
    assert status["is_totp_enabled"] is False

    # 正しいコードを検証して初めて有効化される
    secret = get_user_by_username("admin")["totp_secret"]
    totp = pyotp.TOTP(secret)
    res = local_client.post("/admin/totp/verify", json={"totp_code": totp.now()})
    assert res.status_code == 200
    status = local_client.get("/admin/auth/status").json()
    assert status["is_totp_enabled"] is True


def test_totp_disable_clears_secret_and_reissue():
    """二段階認証を無効化するとシークレットが削除され、再設定時に新しいシークレットが発行されることを確認。"""
    if DB_PATH.exists():
        DB_PATH.unlink()
    init_db()
    local_client = TestClient(app)

    # まず二段階認証を有効化
    res = local_client.get("/admin/totp/setup")
    assert res.status_code == 200
    old_secret = get_user_by_username("admin")["totp_secret"]
    totp = pyotp.TOTP(old_secret)
    res = local_client.post("/admin/totp/verify", json={"totp_code": totp.now()})
    assert res.status_code == 200

    # 無効化するときは確認のために正しいTOTPコードが必要
    res = local_client.post("/admin/totp/disable", json={"totp_code": totp.now()})
    assert res.status_code == 200
    user = get_user_by_username("admin")
    assert user["totp_secret"] is None
    assert user["is_totp_enabled"] == 0

    # 再度セットアップすると新しいシークレットが発行される
    res = local_client.get("/admin/totp/setup")
    assert res.status_code == 200
    new_secret = get_user_by_username("admin")["totp_secret"]
    assert new_secret is not None
    assert new_secret != old_secret

def test_legacy_admin_password_ignored():
    """旧 app_settings の admin_password が無視されることを確認。"""
    if DB_PATH.exists():
        DB_PATH.unlink()
    # 旧設定に admin_password を残した状態で DB を準備
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE app_settings (id TEXT PRIMARY KEY, json TEXT NOT NULL)")
    conn.execute(
        "INSERT INTO app_settings(id, json) VALUES('global', ?)",
        ('{"admin_password":"should_not_use"}',),
    )
    conn.commit()
    conn.close()

    os.environ.pop("ADMIN_PASSWORD", None)
    init_db()
    local_client = TestClient(app)
    res = local_client.get("/admin/auth/status")
    assert res.status_code == 200
    # admin ユーザーはデフォルトパスワードで作成されるはず
    user = get_user_by_username("admin")
    assert verify_password("admin", user["hashed_password"])
    # 旧設定は削除されている
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT json FROM app_settings WHERE id='global'").fetchone()
    conn.close()
    settings = json.loads(row[0]) if row else {}
    assert "admin_password" not in settings


def test_admin_password_endpoint_rejects_when_flag_stale():
    """is_initial_password フラグが誤って残っていても直接更新できないことを確認。"""
    if DB_PATH.exists():
        DB_PATH.unlink()
    init_db()
    local_client = TestClient(app)
    # 初回パスワード変更
    res = local_client.post("/admin/password", json={"password": "ChangeOnce1"})
    assert res.status_code == 200
    # フラグだけを再び1に戻す
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE users SET is_initial_password=1 WHERE username='admin'"
    )
    conn.commit()
    conn.close()
    # 直接更新は拒否される
    res = local_client.post("/admin/password", json={"password": "ChangeTwice2"})
    assert res.status_code == 403
