#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
監査ログ（audit_logs テーブル）を簡易にダンプするユーティリティ。

使い方:
  python backend/tools/audit_dump.py                 # 直近 100 件
  python backend/tools/audit_dump.py --limit 200     # 直近 200 件
  MONSHINMATE_DB=/path/to/app.sqlite3 python backend/tools/audit_dump.py

注意:
- パスワード平文/ハッシュは保存していないため、本ツールの出力にも含まれません。
"""
from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path


DEFAULT_DB_PATH = os.environ.get(
    "MONSHINMATE_DB", str(Path(__file__).resolve().parents[1] / "app" / "app.sqlite3")
)


def main() -> None:
    ap = argparse.ArgumentParser(description="audit_logs ダンプ")
    ap.add_argument("--db", dest="db_path", default=DEFAULT_DB_PATH, help=f"DB ファイルパス (既定: {DEFAULT_DB_PATH})")
    ap.add_argument("--limit", type=int, default=100, help="取得件数（新しい順）")
    args = ap.parse_args()

    if not Path(args.db_path).exists():
        print(f"DB が見つかりません: {args.db_path}")
        return

    conn = sqlite3.connect(args.db_path)
    try:
        cur = conn.execute(
            "SELECT ts, event, COALESCE(username,''), COALESCE(note,'') FROM audit_logs ORDER BY id DESC LIMIT ?",
            (args.limit,),
        )
        rows = cur.fetchall()
        if not rows:
            print("監査ログは空です。")
            return
        print(f"Showing last {len(rows)} records (newest first):\n")
        for ts, event, username, note in rows:
            user = f" username={username}" if username else ""
            extra = f" note={note}" if note else ""
            print(f"{ts} {event}{user}{extra}")
    except sqlite3.Error as e:
        print(f"エラー: {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

