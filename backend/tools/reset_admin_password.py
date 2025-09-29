#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
管理者パスワードをオフラインで強制初期化するメンテナンススクリプト。

機能:
- 新しいパスワードをハッシュ化して `users.username='admin'` に設定
- is_initial_password=1, is_totp_enabled=0, totp_mode='off', totp_secret=NULL に更新（TOTP無効化）
- admin ユーザーが存在しない場合は作成
- 既存DBに不足するカラム（`is_initial_password`, `totp_mode`, `password_updated_at`, `totp_changed_at`）を自動追加（存在時は無視）

注意:
- 実行前に必ず DB バックアップを取得してください（Docker Compose 既定: ./data/sqlite/app.sqlite3 をコピー）。
- スクリプトはローカル実行のみを想定しています。

使い方:
  python backend/tools/reset_admin_password.py                    # 対話的に入力
  python backend/tools/reset_admin_password.py --password NEWPASS  # 非対話

DB パスの決定:
- 環境変数 MONSHINMATE_DB があればそれを使用
- なければ従来の backend/app/app.sqlite3 を既定とする（旧構成との互換用）
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from getpass import getpass
from pathlib import Path
from datetime import datetime, UTC
import logging

from passlib.context import CryptContext


DEFAULT_DB_PATH = os.environ.get(
    "MONSHINMATE_DB", str(Path(__file__).resolve().parents[1] / "app" / "app.sqlite3")
)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def ensure_users_table(conn: sqlite3.Connection) -> None:
    # 最低限 users テーブルがあることを保証（なければ作成）
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            hashed_password TEXT NOT NULL,
            totp_secret TEXT,
            is_totp_enabled INTEGER NOT NULL DEFAULT 0,
            is_initial_password INTEGER NOT NULL DEFAULT 1,
            totp_mode TEXT NOT NULL DEFAULT 'off'
        )
        """
    )
    # 既存DB向けに不足カラムを後付け（存在すれば例外を無視）
    try:
        conn.execute(
            "ALTER TABLE users ADD COLUMN is_initial_password INTEGER NOT NULL DEFAULT 1"
        )
    except Exception:
        pass
    try:
        conn.execute(
            "ALTER TABLE users ADD COLUMN totp_mode TEXT NOT NULL DEFAULT 'off'"
        )
    except Exception:
        pass
    try:
        conn.execute(
            "ALTER TABLE users ADD COLUMN password_updated_at TEXT"
        )
    except Exception:
        pass
    try:
        conn.execute(
            "ALTER TABLE users ADD COLUMN totp_changed_at TEXT"
        )
    except Exception:
        pass
    conn.commit()


def reset_admin_password(db_path: str, new_password: str) -> None:
    if len(new_password) < 8:
        raise SystemExit("エラー: パスワードは8文字以上で入力してください。")

    hashed = pwd_context.hash(new_password)
    conn = connect(db_path)
    try:
        ensure_users_table(conn)

        row = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()
        now = datetime.now(UTC).isoformat()
        if row:
            # 既存ユーザーを更新
            conn.execute(
                """
                UPDATE users
                SET hashed_password = ?,
                    is_initial_password = 1,
                    is_totp_enabled = 0,
                    totp_secret = NULL,
                    totp_mode = 'off',
                    password_updated_at = ?,
                    totp_changed_at = ?
                WHERE username = 'admin'
                """,
                (hashed, now, now),
            )
        else:
            # ユーザーが存在しない場合は作成
            conn.execute(
                """
                INSERT INTO users (username, hashed_password, is_initial_password, is_totp_enabled, totp_secret, totp_mode, password_updated_at, totp_changed_at)
                VALUES ('admin', ?, 1, 0, NULL, 'off', ?, ?)
                """,
                (hashed, now, now),
            )
        conn.commit()
        try:
            conn.execute(
                "INSERT INTO audit_logs(ts, event, username, note) VALUES (?, ?, 'admin', ?)",
                (datetime.now(UTC).isoformat(), 'forced_password_reset', f"totp_disabled=1 initial_password=1"),
            )
            conn.commit()
        except Exception:
            pass
        logging.warning(
            "forced_password_reset username=admin totp_disabled=1 initial_password=1 db=%s",
            db_path,
        )
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="管理者パスワードの強制初期化")
    parser.add_argument("--db", dest="db_path", default=DEFAULT_DB_PATH, help=f"DBファイルパス (既定: {DEFAULT_DB_PATH})")
    parser.add_argument("--password", dest="password", help="新しいパスワード（8文字以上）")
    args = parser.parse_args()

    db_path = args.db_path
    if not Path(db_path).exists():
        print(f"警告: DB ファイルが見つかりません: {db_path}")
        print("新規作成が必要な場合は、バックエンド起動時の init_db に委ねることを推奨します。")

    pw = args.password
    if not pw:
        print("新しいパスワードを入力してください（8文字以上）")
        pw1 = getpass("Password: ")
        pw2 = getpass("Confirm : ")
        if pw1 != pw2:
            raise SystemExit("エラー: 確認用パスワードが一致しません。")
        pw = pw1

    # 最終確認
    print("注意: この操作は admin アカウントのパスワードを直ちに上書きし、TOTP を無効化します。")
    confirm = input("続行しますか？ (yes/no): ").strip().lower()
    if confirm not in ("y", "yes"):
        print("中止しました。")
        sys.exit(1)

    logging.basicConfig(level=logging.INFO)
    reset_admin_password(db_path, pw)
    print("完了: パスワードを更新し、TOTP を無効化しました。初期パスワード状態として扱われます。")


if __name__ == "__main__":
    main()
