"""SQLite ベースの簡易永続化レイヤー。

テンプレート・セッション・回答を管理する。
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from datetime import datetime, UTC
from typing import Any, Iterable

from passlib.context import CryptContext
import logging


DEFAULT_DB_PATH = os.environ.get(
    "MONSHINMATE_DB", str(Path(__file__).resolve().parent / "app.sqlite3")
)

# パスワードハッシュ化のコンテキスト
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


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
                PRIMARY KEY (id, visit_type)
            )
            """
        )

        # 既存DB向けに llm_followup_enabled カラムを後付け（存在時は無視）
        try:
            conn.execute(
                "ALTER TABLE questionnaire_templates ADD COLUMN llm_followup_enabled INTEGER NOT NULL DEFAULT 1"
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
            """
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
            """
        )

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

        # --- データ移行と初期ユーザー作成 ---
        # 'admin' ユーザーが存在しない場合のみ実行
        admin_user = conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
        if not admin_user:
            # 古い app_settings からパスワードを取得
            old_settings_row = conn.execute("SELECT json FROM app_settings WHERE id='global'").fetchone()
            password_to_set = "admin"  # デフォルト
            is_initial = 1
            seed_source = "default"
            if old_settings_row:
                try:
                    settings = json.loads(old_settings_row["json"])
                    if "admin_password" in settings:
                        password_to_set = settings["admin_password"]
                        # 既に設定されていた場合は初期パスワードではない
                        is_initial = 0 if password_to_set != "admin" else 1
                        seed_source = "app_settings"
                        # 移行したので古い設定から削除
                        del settings["admin_password"]
                        conn.execute(
                            "UPDATE app_settings SET json = ? WHERE id = 'global'",
                            (json.dumps(settings, ensure_ascii=False),),
                        )
                except (json.JSONDecodeError, KeyError):
                    pass  # JSONが不正な場合はデフォルト値を使う

            # 環境変数も確認
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
    db_path: str = DEFAULT_DB_PATH,
) -> None:
    conn = get_conn(db_path)
    try:
        items_json = json.dumps(list(items), ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO questionnaire_templates (id, visit_type, items_json, llm_followup_enabled)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id, visit_type) DO UPDATE SET items_json=excluded.items_json, llm_followup_enabled=excluded.llm_followup_enabled
            """,
            (template_id, visit_type, items_json, 1 if llm_followup_enabled else 0),
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
            "SELECT id, visit_type, items_json, llm_followup_enabled FROM questionnaire_templates WHERE id=? AND visit_type=?",
            (template_id, visit_type),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "visit_type": row["visit_type"],
            "items": json.loads(row["items_json"]) or [],
            "llm_followup_enabled": bool(row.get("llm_followup_enabled", 1)),
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


def list_sessions(db_path: str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """保存済みセッションの概要一覧を取得する。"""
    conn = get_conn(db_path)
    try:
        rows = conn.execute(
            "SELECT id, patient_name, dob, visit_type, finalized_at FROM sessions ORDER BY COALESCE(finalized_at, '') DESC"
        ).fetchall()
        return list(rows)
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
        return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
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
    # 注意: 本番環境ではシークレットを暗号化して保存することが望ましい
    conn = get_conn(db_path)
    try:
        now = datetime.now(UTC).isoformat()
        conn.execute("UPDATE users SET totp_secret = ?, totp_changed_at = ? WHERE username = ?", (secret, now, username))
        conn.commit()
        logging.getLogger("security").warning(
            "totp_secret_updated username=%s db=%s",
            username,
            db_path,
        )
    finally:
        conn.close()

def set_totp_status(username: str, enabled: bool, db_path: str = DEFAULT_DB_PATH) -> None:
    """TOTPの有効/無効状態を設定する。"""
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
    """TOTP モードを返す。カラム未設定や NULL の場合は is_totp_enabled から推定。"""
    conn = get_conn(db_path)
    try:
        row = conn.execute("SELECT is_totp_enabled, totp_mode FROM users WHERE username=?", (username,)).fetchone()
        if not row:
            return 'off'
        mode = row.get('totp_mode')
        if mode in ('off', 'reset_only', 'login_and_reset'):
            return mode
        # 後方互換: is_totp_enabled が 1 なら login_and_reset とみなす
        return 'login_and_reset' if int(row.get('is_totp_enabled') or 0) else 'off'
    finally:
        conn.close()

def set_totp_mode(username: str, mode: str, db_path: str = DEFAULT_DB_PATH) -> None:
    """TOTP モードを設定する。"""
    if mode not in ('off', 'reset_only', 'login_and_reset'):
        raise ValueError('invalid totp mode')
    conn = get_conn(db_path)
    try:
        # 'off' なら is_totp_enabled も 0、 それ以外は 1 に合わせる
        enabled = 0 if mode == 'off' else 1
        now = datetime.now(UTC).isoformat()
        conn.execute(
            "UPDATE users SET totp_mode = ?, is_totp_enabled = ?, totp_changed_at = ? WHERE username = ?",
            (mode, enabled, now, username),
        )
        conn.commit()
        logging.getLogger("security").warning(
            "totp_mode_changed username=%s mode=%s enabled=%s db=%s",
            username,
            mode,
            bool(enabled),
            db_path,
        )
    finally:
        conn.close()
