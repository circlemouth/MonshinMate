
#!/usr/bin/env python3
"""既存ユーザーのTOTPシークレットを暗号化するユーティリティ。"""
import os
import sqlite3
from cryptography.fernet import Fernet, InvalidToken
from pathlib import Path
from app.db import DEFAULT_DB_PATH, fernet

DB_PATH = Path(os.getenv("MONSHINMATE_DB", DEFAULT_DB_PATH))


def main() -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        cur.execute("SELECT username, totp_secret FROM users WHERE totp_secret IS NOT NULL")
        rows = cur.fetchall()
        for username, secret in rows:
            try:
                fernet.decrypt(secret.encode())
                continue  # 既に暗号化済み
            except InvalidToken:
                encrypted = fernet.encrypt(secret.encode()).decode()
                cur.execute("UPDATE users SET totp_secret=? WHERE username=?", (encrypted, username))
                print(f"encrypted totp_secret for {username}")
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
