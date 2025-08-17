"""最小の SQLite ベース永続化レイヤー。

問診テンプレートの CRUD を提供する。依存は標準ライブラリのみ（sqlite3）。
本番移行時は SQLAlchemy/SQLModel への置き換えを想定。
"""
from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


DEFAULT_DB_PATH = os.environ.get("MONSHINMATE_DB", str(Path(__file__).resolve().parent / "app.sqlite3"))


def _dict_factory(cursor: sqlite3.Cursor, row: tuple[Any, ...]) -> dict[str, Any]:
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def get_conn(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = _dict_factory
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db(db_path: str = DEFAULT_DB_PATH) -> None:
    """テンプレート用のテーブルを作成する。"""
    conn = get_conn(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS questionnaire_templates (
                id TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                items_json TEXT NOT NULL,
                PRIMARY KEY (id, visit_type)
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def upsert_template(template_id: str, visit_type: str, items: Iterable[dict[str, Any]], db_path: str = DEFAULT_DB_PATH) -> None:
    conn = get_conn(db_path)
    try:
        items_json = json.dumps(list(items), ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO questionnaire_templates (id, visit_type, items_json)
            VALUES (?, ?, ?)
            ON CONFLICT(id, visit_type) DO UPDATE SET items_json=excluded.items_json
            """,
            (template_id, visit_type, items_json),
        )
        conn.commit()
    finally:
        conn.close()


def get_template(template_id: str, visit_type: str, db_path: str = DEFAULT_DB_PATH) -> dict[str, Any] | None:
    conn = get_conn(db_path)
    try:
        row = conn.execute(
            "SELECT id, visit_type, items_json FROM questionnaire_templates WHERE id=? AND visit_type=?",
            (template_id, visit_type),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "visit_type": row["visit_type"],
            "items": json.loads(row["items_json"]) or [],
        }
    finally:
        conn.close()


def list_templates(db_path: str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    conn = get_conn(db_path)
    try:
        rows = conn.execute(
            "SELECT id, visit_type FROM questionnaire_templates ORDER BY id, visit_type"
        ).fetchall()
        return list(rows)
    finally:
        conn.close()


def delete_template(template_id: str, visit_type: str, db_path: str = DEFAULT_DB_PATH) -> None:
    conn = get_conn(db_path)
    try:
        conn.execute(
            "DELETE FROM questionnaire_templates WHERE id=? AND visit_type=?",
            (template_id, visit_type),
        )
        conn.commit()
    finally:
        conn.close()

