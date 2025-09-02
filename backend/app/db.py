"""永続化レイヤー。

テンプレート・セッション・回答を管理する。既定では SQLite を使用するが、
環境変数で CouchDB を指定した場合はセッション情報のみ CouchDB に保存する。
"""
from __future__ import annotations

import json
import os
import sqlite3
import couchdb
from pathlib import Path
from datetime import datetime, UTC
from typing import Any, Iterable
import base64

from passlib.context import CryptContext
from cryptography.fernet import Fernet, InvalidToken
import logging


DEFAULT_DB_PATH = os.environ.get(
    "MONSHINMATE_DB", str(Path(__file__).resolve().parent / "app.sqlite3")
)

# TOTPシークレット暗号化用のキー
FERNET_KEY = os.getenv(
    "TOTP_ENC_KEY",
    base64.urlsafe_b64encode(b"0" * 32).decode(),
)
fernet = Fernet(FERNET_KEY)

# パスワードハッシュ化のコンテキスト
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# CouchDB 設定
COUCHDB_URL = os.getenv("COUCHDB_URL")
COUCHDB_DB_NAME = os.getenv("COUCHDB_DB", "monshin_sessions")
COUCHDB_USER = os.getenv("COUCHDB_USER")
COUCHDB_PASSWORD = os.getenv("COUCHDB_PASSWORD")
couch_db = None
if COUCHDB_URL:
    try:
        _server = couchdb.Server(COUCHDB_URL)
        if COUCHDB_USER and COUCHDB_PASSWORD:
            _server.resource.credentials = (COUCHDB_USER, COUCHDB_PASSWORD)
        # `_users` データベースが存在しないと認証キャッシュでエラーが出るため、
        # 初回起動時に自動作成しておく。
        try:  # pragma: no cover - 既存環境では作成済みの場合があるため
            _server["_users"]
        except couchdb.http.ResourceNotFound:  # pragma: no cover - 実行時のみ
            _server.create("_users")
        except Exception:
            pass
        try:
            couch_db = _server[COUCHDB_DB_NAME]
        except couchdb.http.ResourceNotFound:
            couch_db = _server.create(COUCHDB_DB_NAME)
    except Exception:
        couch_db = None


def _dict_factory(cursor: sqlite3.Cursor, row: tuple[Any, ...]) -> dict[str, Any]:
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def get_conn(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = _dict_factory
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db(db_path: str = DEFAULT_DB_PATH) -> None:
    """最小限のテーブル群を作成し、初期データを投入する。"""
    conn = get_conn(db_path)
    try:
        # テンプレート
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS questionnaire_templates (
                id TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                items_json TEXT NOT NULL,
                llm_followup_enabled INTEGER NOT NULL DEFAULT 1,
                llm_followup_max_questions INTEGER NOT NULL DEFAULT 5,
                PRIMARY KEY (id, visit_type)
            )
            """
        )

        # 既存DB向けにカラムを後付け（存在時は無視）
        try:
            conn.execute(
                "ALTER TABLE questionnaire_templates ADD COLUMN llm_followup_enabled INTEGER NOT NULL DEFAULT 1"
            )
        except Exception:
            pass
        try:
            conn.execute(
                "ALTER TABLE questionnaire_templates ADD COLUMN llm_followup_max_questions INTEGER NOT NULL DEFAULT 5"
            )
        except Exception:
            pass

        # サマリープロンプト（テンプレート/種別ごとに管理）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS summary_prompts (
                id TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                prompt_text TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (id, visit_type)
            )
            """
        )

        # 追加質問プロンプト（テンプレート/種別ごとに管理）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS followup_prompts (
                id TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                prompt_text TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (id, visit_type)
            )
            """
        )
        # 既存DB向けに enabled カラムを後付け（存在時は無視）
        try:
            conn.execute(
                "ALTER TABLE summary_prompts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0"
            )
        except Exception:
            pass

        # セッション本体
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                patient_name TEXT NOT NULL,
                dob TEXT NOT NULL,
                gender TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                questionnaire_id TEXT NOT NULL,
                answers_json TEXT NOT NULL,
                summary TEXT,
                remaining_items_json TEXT,
                completion_status TEXT NOT NULL,
                attempt_counts_json TEXT,
                additional_questions_used INTEGER NOT NULL,
                max_additional_questions INTEGER NOT NULL,
                followup_prompt TEXT,
                finalized_at TEXT
            )
            """
        )
        try:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN followup_prompt TEXT"
            )
        except Exception:
            pass
        try:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN gender TEXT"
            )
        except Exception:
            pass

        # 回答履歴
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_responses (
                session_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                answer_json TEXT NOT NULL,
                -- 追加質問の場合に限り、提示した質問文を保持する
                question_text TEXT,
                ts TEXT NOT NULL,
                PRIMARY KEY (session_id, item_id),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
            """
        )
        # 既存DB向けに question_text カラムを後付け（存在時は無視）
        try:
            conn.execute(
                "ALTER TABLE session_responses ADD COLUMN question_text TEXT"
            )
        except Exception:
            pass

        # LLM 設定（単一行）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_settings (
                id TEXT PRIMARY KEY,
                json TEXT NOT NULL
            )
            """
        )

        # アプリ全体の設定（単一行）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                id TEXT PRIMARY KEY,
                json TEXT NOT NULL
            )
            """
        )

        # ユーザー管理テーブル
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                hashed_password TEXT NOT NULL,
                totp_secret TEXT,
                is_totp_enabled INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        # is_initial_password カラムを後付け
        try:
            conn.execute(
                "ALTER TABLE users ADD COLUMN is_initial_password INTEGER NOT NULL DEFAULT 1"
            )
        except Exception:
            pass
        # totp_mode カラムを後付け（'off' | 'reset_only' | 'login_and_reset'）
        try:
            conn.execute(
                "ALTER TABLE users ADD COLUMN totp_mode TEXT NOT NULL DEFAULT 'off'"
            )
        except Exception:
            pass
        # 監査用途のタイムスタンプ列を後付け
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

        # 監査ログテーブル（存在しない場合のみ作成）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                event TEXT NOT NULL,
                username TEXT,
                note TEXT
            )
            """
        )

        # users テーブル変更の監査トリガ（存在しない場合のみ作成）
        try:
            conn.execute(
                """
                CREATE TRIGGER IF NOT EXISTS audit_users_password_update
                AFTER UPDATE OF hashed_password ON users
                BEGIN
                    INSERT INTO audit_logs(ts, event, username, note)
                    VALUES (datetime('now'), 'users.password_updated', NEW.username, NULL);
                END;
                """
            )
        except Exception:
            pass
        try:
            conn.execute(
                """
                CREATE TRIGGER IF NOT EXISTS audit_users_totp_secret_update
                AFTER UPDATE OF totp_secret ON users
                BEGIN
                    INSERT INTO audit_logs(ts, event, username, note)
                    VALUES (datetime('now'), 'users.totp_secret_updated', NEW.username, NULL);
                END;
                """
            )
        except Exception:
            pass
        try:
            conn.execute(
                """
                CREATE TRIGGER IF NOT EXISTS audit_users_totp_status_update
                AFTER UPDATE OF is_totp_enabled ON users
                BEGIN
                    INSERT INTO audit_logs(ts, event, username, note)
                    VALUES (datetime('now'), 'users.totp_status_updated', NEW.username, CAST(NEW.is_totp_enabled AS TEXT));
                END;
                """
            )
        except Exception:
            pass
        try:
            conn.execute(
                """
                CREATE TRIGGER IF NOT EXISTS audit_users_totp_mode_update
                AFTER UPDATE OF totp_mode ON users
                BEGIN
                    INSERT INTO audit_logs(ts, event, username, note)
                    VALUES (datetime('now'), 'users.totp_mode_updated', NEW.username, NEW.totp_mode);
                END;
                """
            )
        except Exception:
            pass
        try:
            conn.execute(
                """
                CREATE TRIGGER IF NOT EXISTS audit_users_insert
                AFTER INSERT ON users
                BEGIN
                    INSERT INTO audit_logs(ts, event, username, note)
                    VALUES (datetime('now'), 'users.created', NEW.username, NULL);
                END;
                """
            )
        except Exception:
            pass

        conn.commit()

        # --- レガシー設定の整理 ---
        old_settings_row = conn.execute("SELECT json FROM app_settings WHERE id='global'").fetchone()
        if old_settings_row:
            try:
                settings = json.loads(old_settings_row["json"])
                if "admin_password" in settings:
                    # 旧バージョンの admin_password を無視し、設定から削除する
                    del settings["admin_password"]
                    conn.execute(
                        "UPDATE app_settings SET json = ? WHERE id = 'global'",
                        (json.dumps(settings, ensure_ascii=False),),
                    )
                    conn.commit()
                    logging.getLogger("security").warning(
                        "legacy_admin_password_ignored db=%s", db_path
                    )
            except (json.JSONDecodeError, KeyError):
                pass

        # --- データ移行と初期ユーザー作成 ---
        admin_user = conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
        if not admin_user:
            password_to_set = "admin"  # 既定値
            is_initial = 1
            seed_source = "default"

            # 環境変数からの上書き
            password_from_env = os.getenv("ADMIN_PASSWORD")
            if password_from_env and password_from_env != "admin":
                password_to_set = password_from_env
                is_initial = 0
                seed_source = "env"

            # パスワードをハッシュ化して 'admin' ユーザーを作成
            hashed_password = pwd_context.hash(password_to_set)
            conn.execute(
                """
                INSERT INTO users (username, hashed_password, is_initial_password)
                VALUES ('admin', ?, ?)
                """,
                (hashed_password, is_initial),
            )
            conn.commit()
            try:
                now = datetime.now(UTC).isoformat()
                conn.execute(
                    "UPDATE users SET password_updated_at = ? WHERE username = 'admin'",
                    (now,),
                )
                conn.commit()
            except Exception:
                pass
            logging.getLogger("security").warning(
                "admin_user_created from_init is_initial=%s seed_source=%s db=%s",
                bool(is_initial),
                seed_source,
                db_path,
            )
            try:
                conn.execute(
                    "INSERT INTO audit_logs(ts, event, username, note) VALUES (?, ?, ?, ?)",
                    (datetime.now(UTC).isoformat(), 'admin_user_created', 'admin', f'seed_source={seed_source}'),
                )
                conn.commit()
            except Exception:
                pass
            try:
                conn.execute(
                    "INSERT INTO audit_logs(ts, event, username, note) VALUES (?, ?, ?, ?)",
                    (datetime.now(UTC).isoformat(), 'admin_user_created', 'admin', None),
                )
                conn.commit()
            except Exception:
                pass

    finally:
        conn.close()


def upsert_template(
    template_id: str,
    visit_type: str,
    items: Iterable[dict[str, Any]],
    llm_followup_enabled: bool = True,
    llm_followup_max_questions: int = 5,
    db_path: str = DEFAULT_DB_PATH,
) -> None:
    conn = get_conn(db_path)
    try:
        normalized_items = [
            {**it, "type": "multi"} if it.get("type") == "single" else it for it in items
        ]
        items_json = json.dumps(list(normalized_items), ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO questionnaire_templates (id, visit_type, items_json, llm_followup_enabled, llm_followup_max_questions)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id, visit_type) DO UPDATE SET items_json=excluded.items_json, llm_followup_enabled=excluded.llm_followup_enabled, llm_followup_max_questions=excluded.llm_followup_max_questions
            """,
            (
                template_id,
                visit_type,
                items_json,
                1 if llm_followup_enabled else 0,
                llm_followup_max_questions,
            ),
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
            "SELECT id, visit_type, items_json, llm_followup_enabled, llm_followup_max_questions FROM questionnaire_templates WHERE id=? AND visit_type=?",
            (template_id, visit_type),
        ).fetchone()
        if not row:
            return None
        items = json.loads(row["items_json"]) or []
        for it in items:
            if it.get("type") == "single":
                it["type"] = "multi"
        return {
            "id": row["id"],
            "visit_type": row["visit_type"],
            "items": items,
            "llm_followup_enabled": bool(row.get("llm_followup_enabled", 1)),
            "llm_followup_max_questions": int(
                row.get("llm_followup_max_questions", 5)
            ),
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


def upsert_summary_prompt(
    template_id: str,
    visit_type: str,
    prompt_text: str,
    enabled: bool = False,
    db_path: str = DEFAULT_DB_PATH,
) -> None:
    """サマリー生成用プロンプトと有効設定を保存/更新する。"""
    conn = get_conn(db_path)
    try:
        conn.execute(
            """
            INSERT INTO summary_prompts (id, visit_type, prompt_text, enabled)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id, visit_type) DO UPDATE SET
                prompt_text=excluded.prompt_text,
                enabled=excluded.enabled
            """,
            (template_id, visit_type, prompt_text, 1 if enabled else 0),
        )
        conn.commit()
    finally:
        conn.close()


def upsert_followup_prompt(
    template_id: str,
    visit_type: str,
    prompt_text: str,
    enabled: bool = False,
    db_path: str = DEFAULT_DB_PATH,
) -> None:
    """追加質問生成用プロンプトと有効設定を保存/更新する。"""
    conn = get_conn(db_path)
    try:
        conn.execute(
            """
            INSERT INTO followup_prompts (id, visit_type, prompt_text, enabled)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id, visit_type) DO UPDATE SET
                prompt_text=excluded.prompt_text,
                enabled=excluded.enabled
            """,
            (template_id, visit_type, prompt_text, 1 if enabled else 0),
        )
        conn.commit()
    finally:
        conn.close()


def get_summary_config(
    template_id: str, visit_type: str, db_path: str = DEFAULT_DB_PATH
) -> dict[str, Any] | None:
    """サマリー生成用プロンプトと有効設定を取得する。未設定なら None。"""
    conn = get_conn(db_path)
    try:
        row = conn.execute(
            "SELECT prompt_text, enabled FROM summary_prompts WHERE id=? AND visit_type=?",
            (template_id, visit_type),
        ).fetchone()
        if not row:
            return None
        return {"prompt": row["prompt_text"], "enabled": bool(row["enabled"])}
    finally:
        conn.close()


def get_followup_config(
    template_id: str, visit_type: str, db_path: str = DEFAULT_DB_PATH
) -> dict[str, Any] | None:
    """追加質問生成用プロンプトと有効設定を取得する。未設定なら None。"""
    conn = get_conn(db_path)
    try:
        row = conn.execute(
            "SELECT prompt_text, enabled FROM followup_prompts WHERE id=? AND visit_type=?",
            (template_id, visit_type),
        ).fetchone()
        if not row:
            return None
        return {"prompt": row["prompt_text"], "enabled": bool(row["enabled"])}
    finally:
        conn.close()


def get_followup_prompt(
    template_id: str, visit_type: str, db_path: str = DEFAULT_DB_PATH
) -> str | None:
    cfg = get_followup_config(template_id, visit_type, db_path)
    return cfg["prompt"] if cfg else None


def get_summary_prompt(
    template_id: str, visit_type: str, db_path: str = DEFAULT_DB_PATH
) -> str | None:
    cfg = get_summary_config(template_id, visit_type, db_path)
    return cfg["prompt"] if cfg else None


def save_llm_settings(settings: dict[str, Any], db_path: str = DEFAULT_DB_PATH) -> None:
    """LLM 設定を JSON として保存（単一行: id='global'）。"""
    conn = get_conn(db_path)
    try:
        conn.execute(
            """
            INSERT INTO llm_settings (id, json)
            VALUES ('global', ?)
            ON CONFLICT(id) DO UPDATE SET json=excluded.json
            """,
            (json.dumps(settings, ensure_ascii=False),),
        )
        conn.commit()
    finally:
        conn.close()


def load_llm_settings(db_path: str = DEFAULT_DB_PATH) -> dict[str, Any] | None:
    """保存済み LLM 設定を取得。無ければ None。"""
    conn = get_conn(db_path)
    try:
        row = conn.execute("SELECT json FROM llm_settings WHERE id='global'").fetchone()
        if not row:
            return None
        try:
            return json.loads(row["json"]) or None
        except Exception:
            return None
    finally:
        conn.close()


def save_app_settings(settings: dict[str, Any], db_path: str = DEFAULT_DB_PATH) -> None:
    """アプリ共通設定（JSON）を保存（単一行: id='global'）。"""
    conn = get_conn(db_path)
    try:
        conn.execute(
            """
            INSERT INTO app_settings (id, json)
            VALUES ('global', ?)
            ON CONFLICT(id) DO UPDATE SET json=excluded.json
            """,
            (json.dumps(settings, ensure_ascii=False),),
        )
        conn.commit()
    finally:
        conn.close()


def load_app_settings(db_path: str = DEFAULT_DB_PATH) -> dict[str, Any] | None:
    """アプリ共通設定を取得。無ければ None。"""
    conn = get_conn(db_path)
    try:
        row = conn.execute("SELECT json FROM app_settings WHERE id='global'").fetchone()
        if not row:
            return None
        try:
            return json.loads(row["json"]) or None
        except Exception:
            return None
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
    if couch_db:
        doc = {
            "_id": session.id,
            "patient_name": session.patient_name,
            "dob": session.dob,
            "gender": session.gender,
            "visit_type": session.visit_type,
            "questionnaire_id": session.questionnaire_id,
            "answers": session.answers,
            "summary": session.summary,
            "remaining_items": session.remaining_items,
            "completion_status": session.completion_status,
            "attempt_counts": session.attempt_counts,
            "additional_questions_used": session.additional_questions_used,
            "max_additional_questions": session.max_additional_questions,
            "followup_prompt": session.followup_prompt,
            "finalized_at": session.finalized_at.isoformat() if session.finalized_at else None,
            "llm_question_texts": getattr(session, "llm_question_texts", {}) or {},
        }
        couch_db.save(doc)
        return
    conn = get_conn(db_path)
    try:
        conn.execute(
            """
            INSERT INTO sessions (
                id, patient_name, dob, gender, visit_type, questionnaire_id, answers_json,
                summary, remaining_items_json, completion_status, attempt_counts_json,
                additional_questions_used, max_additional_questions, followup_prompt, finalized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                patient_name=excluded.patient_name,
                dob=excluded.dob,
                gender=excluded.gender,
                visit_type=excluded.visit_type,
                questionnaire_id=excluded.questionnaire_id,
                answers_json=excluded.answers_json,
                summary=excluded.summary,
                remaining_items_json=excluded.remaining_items_json,
                completion_status=excluded.completion_status,
                attempt_counts_json=excluded.attempt_counts_json,
                additional_questions_used=excluded.additional_questions_used,
                max_additional_questions=excluded.max_additional_questions,
                followup_prompt=excluded.followup_prompt,
                finalized_at=excluded.finalized_at
            """,
            (
                session.id,
                session.patient_name,
                session.dob,
                session.gender,
                session.visit_type,
                session.questionnaire_id,
                json.dumps(session.answers, ensure_ascii=False),
                session.summary,
                json.dumps(session.remaining_items, ensure_ascii=False),
                session.completion_status,
                json.dumps(session.attempt_counts, ensure_ascii=False),
                session.additional_questions_used,
                session.max_additional_questions,
                session.followup_prompt,
                session.finalized_at.isoformat() if session.finalized_at else None,
            ),
        )

        conn.execute("DELETE FROM session_responses WHERE session_id=?", (session.id,))
        ts = session.finalized_at.isoformat() if session.finalized_at else ""
        # LLM 追加質問の提示文マッピング（存在しない場合は空）
        llm_qtexts = getattr(session, "llm_question_texts", {}) or {}
        for item_id, ans in session.answers.items():
            qtext = None
            # 追加質問IDは `llm_` 接頭辞で管理している
            if isinstance(item_id, str) and item_id.startswith("llm_"):
                qtext = llm_qtexts.get(item_id)
            conn.execute(
                """
                INSERT INTO session_responses (session_id, item_id, answer_json, question_text, ts)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session.id,
                    item_id,
                    json.dumps(ans, ensure_ascii=False),
                    qtext,
                    ts,
                ),
            )
        conn.commit()
    finally:
        conn.close()



def list_sessions(
    patient_name: str | None = None,
    dob: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    db_path: str = DEFAULT_DB_PATH,
) -> list[dict[str, Any]]:
    """保存済みセッションの概要一覧を取得する。

    検索条件が指定された場合はそれに応じてフィルタする。
    """
    if couch_db:
        docs = [r.doc for r in couch_db.view("_all_docs", include_docs=True)]
        result: list[dict[str, Any]] = []
        for d in docs:
            if patient_name and patient_name not in d.get("patient_name", ""):
                continue
            if dob and dob != d.get("dob"):
                continue
            f_at = d.get("finalized_at")
            if start_date and f_at and f_at < f"{start_date}T00:00:00":
                continue
            if end_date and f_at and f_at > f"{end_date}T23:59:59":
                continue
            result.append(
                {
                    "id": d.get("_id"),
                    "patient_name": d.get("patient_name"),
                    "dob": d.get("dob"),
                    "visit_type": d.get("visit_type"),
                    "finalized_at": d.get("finalized_at"),
                }
            )
        result.sort(key=lambda x: x.get("finalized_at") or "", reverse=True)
        return result
    conn = get_conn(db_path)
    try:
        query = "SELECT id, patient_name, dob, visit_type, finalized_at FROM sessions"
        conditions: list[str] = []
        params: list[Any] = []
        if patient_name:
            conditions.append("patient_name LIKE ?")
            params.append(f"%{patient_name}%")
        if dob:
            conditions.append("dob = ?")
            params.append(dob)
        if start_date and end_date:
            conditions.append("DATE(finalized_at) BETWEEN ? AND ?")
            params.extend([start_date, end_date])
        elif start_date:
            conditions.append("DATE(finalized_at) >= ?")
            params.append(start_date)
        elif end_date:
            conditions.append("DATE(finalized_at) <= ?")
            params.append(end_date)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY COALESCE(finalized_at, '') DESC"
        rows = conn.execute(query, params).fetchall()
        return list(rows)
    finally:
        conn.close()


def get_session(session_id: str, db_path: str = DEFAULT_DB_PATH) -> dict[str, Any] | None:
    """DB からセッションを取得する。"""
    if couch_db:
        doc = couch_db.get(session_id)
        if not doc:
            return None
        doc["id"] = doc.pop("_id")
        return doc
    conn = get_conn(db_path)
    try:
        srow = conn.execute(
            "SELECT * FROM sessions WHERE id=?",
            (session_id,),
        ).fetchone()
        if not srow:
            return None
        rrows = conn.execute(
            "SELECT item_id, answer_json, question_text FROM session_responses WHERE session_id=?",
            (session_id,),
        ).fetchall()
        answers = {r["item_id"]: json.loads(r["answer_json"]) for r in rrows}
        # LLM 追加質問の質問文マッピングも返却に含める（API レイヤでは必要に応じて利用）
        llm_qtexts: dict[str, str] = {}
        for r in rrows:
            iid = r.get("item_id")
            qtext = r.get("question_text")
            if iid and isinstance(iid, str) and iid.startswith("llm_") and qtext:
                llm_qtexts[iid] = qtext
        srow["answers"] = answers
        if llm_qtexts:
            srow["llm_question_texts"] = llm_qtexts
        srow["remaining_items"] = json.loads(srow.get("remaining_items_json") or "[]")
        srow["attempt_counts"] = json.loads(srow.get("attempt_counts_json") or "{}")
        return srow
    finally:
        conn.close()

# --- ユーザー/認証関連の関数 ---

def list_audit_logs(limit: int = 100, db_path: str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """監査ログの一覧（新しい順）。

    注意: パスワードの平文やハッシュは保存していないため、ここにも含まれない。
    """
    conn = get_conn(db_path)
    try:
        rows = conn.execute(
            "SELECT ts, event, username, note FROM audit_logs ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return list(rows)
    finally:
        conn.close()

def get_user_by_username(username: str, db_path: str = DEFAULT_DB_PATH) -> dict[str, Any] | None:
    """ユーザー名でユーザー情報を取得する。"""
    conn = get_conn(db_path)
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if row and row.get("totp_secret"):
            try:
                row["totp_secret"] = fernet.decrypt(row["totp_secret"].encode()).decode()
            except InvalidToken:
                pass
        return row
    finally:
        conn.close()

def update_password(username: str, new_password: str, db_path: str = DEFAULT_DB_PATH) -> None:
    """ユーザーのパスワードを更新し、初期パスワードフラグを解除する。

    パスワード変更の監査ログを出力する（平文やハッシュは記録しない）。
    """
    logger = logging.getLogger("security")
    hashed_password = pwd_context.hash(new_password)
    conn = get_conn(db_path)
    try:
        # 変更前の存在確認（監査の補助情報）
        before = conn.execute(
            "SELECT id FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        now = datetime.now(UTC).isoformat()
        conn.execute(
            "UPDATE users SET hashed_password = ?, is_initial_password = 0, password_updated_at = ? WHERE username = ?",
            (hashed_password, now, username),
        )
        conn.commit()
        logger.warning(
            "password_update username=%s existed_before=%s db=%s",
            username,
            bool(before),
            db_path,
        )
        try:
            conn.execute(
                "INSERT INTO audit_logs(ts, event, username, note) VALUES (?, ?, ?, ?)",
                (now, 'password_update', username, None),
            )
            conn.commit()
        except Exception:
            pass
    finally:
        conn.close()

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """平文パスワードとハッシュ化済みパスワードを比較する。"""
    return pwd_context.verify(plain_password, hashed_password)

def update_totp_secret(username: str, secret: str, db_path: str = DEFAULT_DB_PATH) -> None:
    """TOTPシークレットを保存する。"""
    conn = get_conn(db_path)
    try:
        now = datetime.now(UTC).isoformat()
        encrypted = fernet.encrypt(secret.encode()).decode()
        conn.execute("UPDATE users SET totp_secret = ?, totp_changed_at = ? WHERE username = ?", (encrypted, now, username))
        conn.commit()
        logging.getLogger("security").warning(
            "totp_secret_updated username=%s db=%s",
            username,
            db_path,
        )
    finally:
        conn.close()

def set_totp_status(
    username: str,
    enabled: bool,
    db_path: str = DEFAULT_DB_PATH,
    *,
    clear_secret: bool = False,
) -> None:
    """TOTPの有効/無効状態を設定する。

    無効化時に ``clear_secret=True`` を指定すると、登録済みシークレットも削除する。
    """
    conn = get_conn(db_path)
    try:
        # 有効化時はモードが 'off' の場合 'login_and_reset' に昇格、無効化時は 'off'
        now = datetime.now(UTC).isoformat()
        if enabled:
            conn.execute(
                "UPDATE users SET is_totp_enabled = 1, totp_mode = CASE WHEN COALESCE(totp_mode,'off')='off' THEN 'login_and_reset' ELSE totp_mode END, totp_changed_at = ? WHERE username = ?",
                (now, username),
            )
        else:
            if clear_secret:
                conn.execute(
                    "UPDATE users SET is_totp_enabled = 0, totp_mode = 'off', totp_secret = NULL, totp_changed_at = ? WHERE username = ?",
                    (now, username),
                )
                logging.getLogger("security").warning(
                    "totp_secret_cleared username=%s db=%s",
                    username,
                    db_path,
                )
            else:
                conn.execute(
                    "UPDATE users SET is_totp_enabled = 0, totp_mode = 'off', totp_changed_at = ? WHERE username = ?",
                    (now, username),
                )
        conn.commit()
        logging.getLogger("security").warning(
            "totp_status_changed username=%s enabled=%s db=%s",
            username,
            bool(enabled),
            db_path,
        )
    finally:
        conn.close()

def get_totp_mode(username: str, db_path: str = DEFAULT_DB_PATH) -> str:
    """TOTP モードを返す。シークレット未設定の場合は 'off' を返す。"""
    conn = get_conn(db_path)
    try:
        row = conn.execute(
            "SELECT is_totp_enabled, totp_mode, totp_secret FROM users WHERE username=?",
            (username,),
        ).fetchone()
        if not row or not row.get("totp_secret"):
            return "off"
        mode = row.get("totp_mode")
        if mode in ("off", "reset_only", "login_and_reset"):
            return mode
        # 後方互換: is_totp_enabled が 1 なら login_and_reset とみなす
        return "login_and_reset" if int(row.get("is_totp_enabled") or 0) else "off"
    finally:
        conn.close()

def set_totp_mode(username: str, mode: str, db_path: str = DEFAULT_DB_PATH) -> None:
    """TOTP モードを設定する。"""
    if mode not in ('off', 'reset_only', 'login_and_reset'):
        raise ValueError('invalid totp mode')
    conn = get_conn(db_path)
    try:
        now = datetime.now(UTC).isoformat()
        if mode == 'off':
            # 無効化時はシークレットも削除する
            conn.execute(
                "UPDATE users SET totp_mode = 'off', is_totp_enabled = 0, totp_secret = NULL, totp_changed_at = ? WHERE username = ?",
                (now, username),
            )
        else:
            conn.execute(
                "UPDATE users SET totp_mode = ?, totp_changed_at = ? WHERE username = ?",
                (mode, now, username),
            )
        conn.commit()
        row = conn.execute(
            "SELECT is_totp_enabled FROM users WHERE username = ?", (username,)
        ).fetchone()
        logging.getLogger("security").warning(
            "totp_mode_changed username=%s mode=%s enabled=%s db=%s",
            username,
            mode,
            bool(row["is_totp_enabled"]) if row else None,
            db_path,
        )
    finally:
        conn.close()
