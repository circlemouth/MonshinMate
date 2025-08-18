"""SQLite ベースの簡易永続化レイヤー。

テンプレート・セッション・回答を管理する。
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Iterable


DEFAULT_DB_PATH = os.environ.get(
    "MONSHINMATE_DB", str(Path(__file__).resolve().parent / "app.sqlite3")
)


def _dict_factory(cursor: sqlite3.Cursor, row: tuple[Any, ...]) -> dict[str, Any]:
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def get_conn(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = _dict_factory
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db(db_path: str = DEFAULT_DB_PATH) -> None:
    """最小限のテーブル群を作成する。"""
    conn = get_conn(db_path)
    try:
        # テンプレート
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS questionnaire_templates (
                id TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                items_json TEXT NOT NULL,
                PRIMARY KEY (id, visit_type)
            )
            """,
        )

        # セッション本体
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                patient_name TEXT NOT NULL,
                dob TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                questionnaire_id TEXT NOT NULL,
                answers_json TEXT NOT NULL,
                summary TEXT,
                remaining_items_json TEXT,
                completion_status TEXT NOT NULL,
                attempt_counts_json TEXT,
                additional_questions_used INTEGER NOT NULL,
                max_additional_questions INTEGER NOT NULL,
                finalized_at TEXT
            )
            """,
        )

        # 回答履歴
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_responses (
                session_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                answer_json TEXT NOT NULL,
                ts TEXT NOT NULL,
                PRIMARY KEY (session_id, item_id),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
            """,
        )

        conn.commit()
    finally:
        conn.close()


def upsert_template(
    template_id: str, visit_type: str, items: Iterable[dict[str, Any]], db_path: str = DEFAULT_DB_PATH
) -> None:
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


def get_template(
    template_id: str, visit_type: str, db_path: str = DEFAULT_DB_PATH
) -> dict[str, Any] | None:
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


def save_session(session: Any, db_path: str = DEFAULT_DB_PATH) -> None:
    """セッション情報と回答を保存する。"""
    conn = get_conn(db_path)
    try:
        conn.execute(
            """
            INSERT INTO sessions (
                id, patient_name, dob, visit_type, questionnaire_id, answers_json,
                summary, remaining_items_json, completion_status, attempt_counts_json,
                additional_questions_used, max_additional_questions, finalized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                patient_name=excluded.patient_name,
                dob=excluded.dob,
                visit_type=excluded.visit_type,
                questionnaire_id=excluded.questionnaire_id,
                answers_json=excluded.answers_json,
                summary=excluded.summary,
                remaining_items_json=excluded.remaining_items_json,
                completion_status=excluded.completion_status,
                attempt_counts_json=excluded.attempt_counts_json,
                additional_questions_used=excluded.additional_questions_used,
                max_additional_questions=excluded.max_additional_questions,
                finalized_at=excluded.finalized_at
            """,
            (
                session.id,
                session.patient_name,
                session.dob,
                session.visit_type,
                session.questionnaire_id,
                json.dumps(session.answers, ensure_ascii=False),
                session.summary,
                json.dumps(session.remaining_items, ensure_ascii=False),
                session.completion_status,
                json.dumps(session.attempt_counts, ensure_ascii=False),
                session.additional_questions_used,
                session.max_additional_questions,
                session.finalized_at.isoformat() if session.finalized_at else None,
            ),
        )

        conn.execute("DELETE FROM session_responses WHERE session_id=?", (session.id,))
        ts = session.finalized_at.isoformat() if session.finalized_at else ""
        for item_id, ans in session.answers.items():
            conn.execute(
                """
                INSERT INTO session_responses (session_id, item_id, answer_json, ts)
                VALUES (?, ?, ?, ?)
                """,
                (session.id, item_id, json.dumps(ans, ensure_ascii=False), ts),
            )
        conn.commit()
    finally:
        conn.close()


def get_session(session_id: str, db_path: str = DEFAULT_DB_PATH) -> dict[str, Any] | None:
    """DB からセッションを取得する。"""
    conn = get_conn(db_path)
    try:
        srow = conn.execute(
            "SELECT * FROM sessions WHERE id=?",
            (session_id,),
        ).fetchone()
        if not srow:
            return None
        rrows = conn.execute(
            "SELECT item_id, answer_json FROM session_responses WHERE session_id=?",
            (session_id,),
        ).fetchall()
        answers = {r["item_id"]: json.loads(r["answer_json"]) for r in rrows}
        srow["answers"] = answers
        srow["remaining_items"] = json.loads(srow.get("remaining_items_json") or "[]")
        srow["attempt_counts"] = json.loads(srow.get("attempt_counts_json") or "{}")
        return srow
    finally:
        conn.close()
