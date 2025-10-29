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
import unicodedata

from passlib.context import CryptContext
from cryptography.fernet import Fernet, InvalidToken
import logging


logger = logging.getLogger(__name__)


_MODULE_DIR = Path(__file__).resolve().parent
_APP_DIR = _MODULE_DIR.parent

DEFAULT_DB_PATH = os.environ.get(
    "MONSHINMATE_DB", str(_APP_DIR / "app.sqlite3")
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


def _connect_couch_db() -> Any:
    if not COUCHDB_URL:
        return None
    try:
        server = couchdb.Server(COUCHDB_URL)
        if COUCHDB_USER and COUCHDB_PASSWORD:
            server.resource.credentials = (COUCHDB_USER, COUCHDB_PASSWORD)
        # `_users` データベースが存在しないと認証キャッシュでエラーが出るため、
        # 初回起動時に自動作成しておく。
        try:  # pragma: no cover - 既存環境では作成済みの場合があるため
            server["_users"]
        except couchdb.http.ResourceNotFound:  # pragma: no cover - 実行時のみ
            server.create("_users")
        except Exception:
            pass
        try:
            database = server[COUCHDB_DB_NAME]
        except couchdb.http.ResourceNotFound:
            database = server.create(COUCHDB_DB_NAME)
        return database
    except Exception as exc:
        logger.warning("CouchDB 接続に失敗しました: %s", exc)
        return None


def get_couch_db(force_refresh: bool = False) -> Any:
    global couch_db
    if force_refresh:
        couch_db = None
    if couch_db is None:
        couch_db = _connect_couch_db()
    return couch_db


if COUCHDB_URL:
    couch_db = get_couch_db()


SPACE_CHARS = {" ", "\u3000"}


def _dict_factory(cursor: sqlite3.Cursor, row: tuple[Any, ...]) -> dict[str, Any]:
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def _extract_question_texts_from_items(items: Iterable[Any] | None) -> dict[str, str]:
    """セッションが保持するテンプレ項目から質問文マップを生成する。"""

    mapping: dict[str, str] = {}
    if not items:
        return mapping

    stack: list[Any] = list(items)
    while stack:
        item = stack.pop()
        if item is None:
            continue
        item_id = None
        label = None
        try:
            item_id = getattr(item, "id", None)
        except Exception:
            item_id = None
        if item_id is None and isinstance(item, dict):
            item_id = item.get("id")
        try:
            label = getattr(item, "label", None)
        except Exception:
            label = None
        if label is None and isinstance(item, dict):
            label = item.get("label")
        if item_id and isinstance(label, str):
            mapping[item_id] = label

        followups = None
        try:
            followups = getattr(item, "followups", None)
        except Exception:
            followups = None
        if followups is None and isinstance(item, dict):
            followups = item.get("followups")
        if isinstance(followups, dict):
            for children in followups.values():
                if not children:
                    continue
                if isinstance(children, (list, tuple, set)):
                    stack.extend(list(children))
                else:
                    stack.append(children)
    return mapping


def get_conn(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = _dict_factory
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def _normalize_patient_name_for_search(value: str) -> str:
    """検索時に患者名を比較しやすい形に正規化する。"""

    normalized = unicodedata.normalize("NFKC", value)
    return ''.join(ch for ch in normalized if ch not in SPACE_CHARS)

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
                started_at TEXT,
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

        try:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN started_at TEXT"
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


def rename_template(
    template_id: str, new_id: str, db_path: str = DEFAULT_DB_PATH
) -> None:
    """テンプレートIDを変更する。

    - 既存IDが存在しない場合は LookupError を送出
    - 新IDが既に使用されている場合は ValueError を送出
    - 質問テンプレート、サマリープロンプト、追加質問プロンプト、セッション参照を一括更新
    - 既定テンプレート設定や CouchDB セッションの ID も可能な限り更新
    """

    if template_id == new_id:
        return

    conn = get_conn(db_path)
    try:
        conn.execute("BEGIN")
        current = conn.execute(
            "SELECT 1 FROM questionnaire_templates WHERE id=? LIMIT 1",
            (template_id,),
        ).fetchone()
        if not current:
            raise LookupError(f"template {template_id} not found")

        conflict = conn.execute(
            "SELECT 1 FROM questionnaire_templates WHERE id=? LIMIT 1",
            (new_id,),
        ).fetchone()
        if conflict:
            raise ValueError(f"template id {new_id} already exists")

        conn.execute(
            "UPDATE questionnaire_templates SET id=? WHERE id=?",
            (new_id, template_id),
        )
        conn.execute(
            "UPDATE summary_prompts SET id=? WHERE id=?",
            (new_id, template_id),
        )
        conn.execute(
            "UPDATE followup_prompts SET id=? WHERE id=?",
            (new_id, template_id),
        )
        conn.execute(
            "UPDATE sessions SET questionnaire_id=? WHERE questionnaire_id=?",
            (new_id, template_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    try:
        settings = load_app_settings(db_path) or {}
    except Exception:
        settings = {}
    if settings.get("default_questionnaire_id") == template_id:
        settings["default_questionnaire_id"] = new_id
        try:
            save_app_settings(settings, db_path=db_path)
        except Exception as exc:  # pragma: no cover - 設定保存失敗時は警告のみ
            logger.warning("rename_template_default_update_failed: %s", exc)

    db = get_couch_db()
    if db:
        try:  # pragma: no cover - CouchDB 環境が無い場合は実行不可
            if hasattr(db, "find"):
                result = db.find({"selector": {"questionnaire_id": template_id}})
                for doc in result:
                    doc["questionnaire_id"] = new_id
                    db.save(doc)
            else:
                for row in db.view("_all_docs", include_docs=True):
                    doc = getattr(row, "doc", None)
                    if not doc:
                        continue
                    if doc.get("questionnaire_id") != template_id:
                        continue
                    doc["questionnaire_id"] = new_id
                    db.save(doc)
        except Exception as exc:
            logger.warning("rename_template_couchdb_failed: %s", exc)


def save_session(session: Any, db_path: str = DEFAULT_DB_PATH) -> None:
    """セッション情報と回答を保存する。"""
    raw_llm_qtexts = getattr(session, "llm_question_texts", {}) or {}
    llm_qtexts: dict[str, str] = {}
    for key, text in raw_llm_qtexts.items():
        if isinstance(text, str):
            llm_qtexts[str(key)] = text
    try:
        session.llm_question_texts = llm_qtexts  # type: ignore[attr-defined]
    except Exception:
        pass

    question_texts: dict[str, str] = {}
    existing_qtexts = getattr(session, "question_texts", {}) or {}
    if isinstance(existing_qtexts, dict):
        for key, text in existing_qtexts.items():
            if isinstance(text, str):
                question_texts[str(key)] = text
    template_items = getattr(session, "template_items", None)
    template_qtexts = _extract_question_texts_from_items(template_items)
    for key, text in template_qtexts.items():
        if isinstance(text, str):
            question_texts.setdefault(str(key), text)
    started_dt = getattr(session, "started_at", None)
    if isinstance(started_dt, str):
        try:
            started_dt = datetime.fromisoformat(started_dt)
        except Exception:
            started_dt = None
    finalized_dt = getattr(session, "finalized_at", None)
    if isinstance(finalized_dt, str):
        try:
            finalized_dt = datetime.fromisoformat(finalized_dt)
        except Exception:
            finalized_dt = None
    if started_dt is None and finalized_dt is not None:
        try:
            session.started_at = finalized_dt  # type: ignore[attr-defined]
        except Exception:
            pass
        started_dt = finalized_dt
    completion_status = getattr(session, "completion_status", "")
    interrupted_flag = completion_status != "finalized"
    try:
        session.interrupted = bool(interrupted_flag)  # type: ignore[attr-defined]
    except Exception:
        pass
    for key, text in llm_qtexts.items():
        question_texts[key] = text
    try:
        session.question_texts = question_texts  # type: ignore[attr-defined]
    except Exception:
        pass

    db = get_couch_db()
    if db:
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
            "interrupted": bool(interrupted_flag),
            "attempt_counts": session.attempt_counts,
            "additional_questions_used": session.additional_questions_used,
            "max_additional_questions": session.max_additional_questions,
            "followup_prompt": session.followup_prompt,
            "started_at": started_dt.isoformat() if started_dt else None,
            "finalized_at": finalized_dt.isoformat() if finalized_dt else None,
            "llm_question_texts": llm_qtexts,
            "question_texts": question_texts,
        }
        if session.id in db:
            existing = db.get(session.id)
            if existing:
                doc["_rev"] = existing.rev
        for _ in range(3):
            try:
                db.save(doc)
                break
            except couchdb.http.ResourceConflict:  # pragma: no cover - 時間的競合時のみ
                existing = db.get(session.id)
                if not existing:
                    raise
                doc["_rev"] = existing.rev
        else:  # pragma: no cover - 異常時の保険
            raise
        return
    elif COUCHDB_URL:
        # CouchDB が設定されている場合、保存失敗時は例外を送出しフォールバックしない
        raise RuntimeError("CouchDB への保存に失敗しました")
    conn = get_conn(db_path)
    try:
        conn.execute(
            """
            INSERT INTO sessions (
                id, patient_name, dob, gender, visit_type, questionnaire_id, answers_json,
                summary, remaining_items_json, completion_status, attempt_counts_json,
                additional_questions_used, max_additional_questions, followup_prompt, started_at, finalized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                started_at=excluded.started_at,
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
                started_dt.isoformat() if started_dt else None,
                finalized_dt.isoformat() if finalized_dt else None,
            ),
        )

        conn.execute("DELETE FROM session_responses WHERE session_id=?", (session.id,))
        ts_dt = finalized_dt or started_dt
        ts = ts_dt.isoformat() if ts_dt else ""
        for item_id, ans in session.answers.items():
            stored_id = str(item_id)
            qtext = question_texts.get(stored_id)
            if qtext is None and stored_id != item_id:
                qtext = question_texts.get(item_id)
            if qtext is None and stored_id.startswith("llm_"):
                qtext = llm_qtexts.get(stored_id)
            conn.execute(
                """
                INSERT INTO session_responses (session_id, item_id, answer_json, question_text, ts)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session.id,
                    stored_id,
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
    patient_name_query = (patient_name or "").strip()
    normalized_patient_name_query = (
        _normalize_patient_name_for_search(patient_name_query) if patient_name_query else ""
    )
    db = get_couch_db()
    if db:
        docs = [r.doc for r in db.view("_all_docs", include_docs=True)]
        result: list[dict[str, Any]] = []
        use_direct = bool(patient_name_query)
        use_normalized = bool(normalized_patient_name_query)
        for d in docs:
            if use_direct or use_normalized:
                raw_name = d.get("patient_name") or ""
                direct_match = patient_name_query in raw_name if use_direct else True
                normalized_match = True
                if use_normalized:
                    normalized_target = _normalize_patient_name_for_search(raw_name)
                    normalized_match = normalized_patient_name_query in normalized_target
                if not direct_match and not normalized_match:
                    continue
            if dob and dob != d.get("dob"):
                continue
            started_at = d.get("started_at") or d.get("finalized_at")
            if start_date and started_at and started_at < f"{start_date}T00:00:00":
                continue
            if end_date and started_at and started_at > f"{end_date}T23:59:59":
                continue
            completion_status = d.get("completion_status") or ""
            interrupted = completion_status != "finalized"
            result.append(
                {
                    "id": d.get("_id"),
                    "patient_name": d.get("patient_name"),
                    "dob": d.get("dob"),
                    "visit_type": d.get("visit_type"),
                    "started_at": started_at,
                    "finalized_at": d.get("finalized_at"),
                    "interrupted": bool(interrupted),
                }
            )
        result.sort(key=lambda x: (x.get("started_at") or "", x.get("finalized_at") or ""), reverse=True)
        return result
    conn = get_conn(db_path)
    try:
        query = "SELECT id, patient_name, dob, visit_type, started_at, finalized_at, completion_status FROM sessions"
        conditions: list[str] = []
        params: list[Any] = []
        if patient_name_query:
            if normalized_patient_name_query:
                conditions.append(
                    "(patient_name LIKE ? OR REPLACE(REPLACE(patient_name, ' ', ''), '　', '') LIKE ?)"
                )
                params.extend([f"%{patient_name_query}%", f"%{normalized_patient_name_query}%"])
            else:
                conditions.append("patient_name LIKE ?")
                params.append(f"%{patient_name_query}%")
        if dob:
            conditions.append("dob = ?")
            params.append(dob)
        if start_date and end_date:
            conditions.append("DATE(COALESCE(started_at, finalized_at)) BETWEEN ? AND ?")
            params.extend([start_date, end_date])
        elif start_date:
            conditions.append("DATE(COALESCE(started_at, finalized_at)) >= ?")
            params.append(start_date)
        elif end_date:
            conditions.append("DATE(COALESCE(started_at, finalized_at)) <= ?")
            params.append(end_date)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY COALESCE(started_at, finalized_at, '') DESC"
        rows = conn.execute(query, params).fetchall()
        for row in rows:
            if not row.get("started_at"):
                row["started_at"] = row.get("finalized_at")
            completion = row.get("completion_status") or ""
            row["interrupted"] = completion != "finalized"
            row.pop("completion_status", None)

        return list(rows)
    finally:
        conn.close()


def list_sessions_finalized_after(
    since: datetime | None,
    *,
    limit: int = 50,
    db_path: str = DEFAULT_DB_PATH,
) -> tuple[list[dict[str, Any]], datetime | None]:
    """指定時刻より後に確定したセッションを取得する。

    戻り値は (該当セッション一覧, DB に存在する最新 finalized_at) のタプル。
    """

    limit = max(1, int(limit))

    collect_events = since is not None

    db = get_couch_db()
    if db:
        docs = [r.doc for r in db.view("_all_docs", include_docs=True)]
        latest_dt: datetime | None = None
        events: list[dict[str, Any]] = []
        for doc in docs:
            finalized_raw = doc.get("finalized_at")
            if not finalized_raw:
                continue
            try:
                finalized_dt = datetime.fromisoformat(finalized_raw)
            except Exception:
                continue
            if latest_dt is None or finalized_dt > latest_dt:
                latest_dt = finalized_dt
            if collect_events and since and finalized_dt <= since:
                continue
            session_id = doc.get("_id")
            if not session_id:
                continue
            if collect_events:
                events.append(
                    {
                        "id": session_id,
                        "patient_name": doc.get("patient_name"),
                        "dob": doc.get("dob"),
                        "visit_type": doc.get("visit_type"),
                        "started_at": doc.get("started_at"),
                        "finalized_at": finalized_dt.isoformat(),
                    }
                )
        events.sort(key=lambda x: x.get("finalized_at") or "")
        if len(events) > limit:
            events = events[-limit:]
        return events, latest_dt

    conn = get_conn(db_path)
    try:
        latest_row = conn.execute(
            "SELECT finalized_at FROM sessions WHERE finalized_at IS NOT NULL ORDER BY finalized_at DESC LIMIT 1"
        ).fetchone()
        latest_dt = None
        if latest_row and latest_row.get("finalized_at"):
            try:
                latest_dt = datetime.fromisoformat(latest_row["finalized_at"])
            except Exception:
                latest_dt = None
        if not collect_events:
            return [], latest_dt
        params: list[Any] = []
        query = """
            SELECT id, patient_name, dob, visit_type, started_at, finalized_at
            FROM sessions
            WHERE finalized_at IS NOT NULL AND finalized_at > ?
            ORDER BY finalized_at ASC
        """
        params.append(since.isoformat())
        rows = conn.execute(query, params).fetchall()
        events = [dict(row) for row in rows]
        if len(events) > limit:
            events = events[-limit:]
        return events, latest_dt
    finally:
        conn.close()


def get_session(session_id: str, db_path: str = DEFAULT_DB_PATH) -> dict[str, Any] | None:
    """DB からセッションを取得する。"""
    db = get_couch_db()
    if db:
        doc = db.get(session_id)
        if not doc:
            return None
        doc["id"] = doc.pop("_id")
        if not doc.get("started_at"):
            doc["started_at"] = doc.get("finalized_at")
        doc["interrupted"] = (doc.get("completion_status") or "") != "finalized"
        qtexts = doc.get("question_texts") or {}
        if isinstance(qtexts, dict):
            doc["question_texts"] = {str(k): v for k, v in qtexts.items() if isinstance(v, str)}
        llm_qtexts = doc.get("llm_question_texts") or {}
        if isinstance(llm_qtexts, dict):
            doc["llm_question_texts"] = {str(k): v for k, v in llm_qtexts.items() if isinstance(v, str)}
        return doc
    conn = get_conn(db_path)
    try:
        srow = conn.execute(
            "SELECT * FROM sessions WHERE id=?",
            (session_id,),
        ).fetchone()
        if not srow:
            return None
        if not srow.get("started_at"):
            srow["started_at"] = srow.get("finalized_at")
        srow["interrupted"] = (srow.get("completion_status") or "") != "finalized"
        rrows = conn.execute(
            "SELECT item_id, answer_json, question_text FROM session_responses WHERE session_id=?",
            (session_id,),
        ).fetchall()
        answers = {r["item_id"]: json.loads(r["answer_json"]) for r in rrows}
        # LLM 追加質問の質問文マッピングも返却に含める（API レイヤでは必要に応じて利用）
        llm_qtexts: dict[str, str] = {}
        question_texts: dict[str, str] = {}
        for r in rrows:
            iid = r.get("item_id")
            qtext = r.get("question_text")
            if iid and qtext:
                question_texts[str(iid)] = qtext
                if isinstance(iid, str) and iid.startswith("llm_"):
                    llm_qtexts[str(iid)] = qtext
        srow["answers"] = answers
        if question_texts:
            srow["question_texts"] = question_texts
        if llm_qtexts:
            srow["llm_question_texts"] = llm_qtexts
        srow["remaining_items"] = json.loads(srow.get("remaining_items_json") or "[]")
        srow["attempt_counts"] = json.loads(srow.get("attempt_counts_json") or "{}")
        return srow
    finally:
        conn.close()

# --- 設定/データのエクスポート・インポート支援関数 ---


def export_questionnaire_settings(db_path: str = DEFAULT_DB_PATH) -> dict[str, Any]:
    """問診テンプレートと関連設定をまとめて取得する。"""

    conn = get_conn(db_path)
    try:
        tpl_rows = conn.execute(
            """
            SELECT id, visit_type, items_json, llm_followup_enabled, llm_followup_max_questions
            FROM questionnaire_templates
            ORDER BY id, visit_type
            """
        ).fetchall()
        templates: list[dict[str, Any]] = []
        for row in tpl_rows:
            try:
                items = json.loads(row.get("items_json") or "[]")
            except Exception:
                items = []
            templates.append(
                {
                    "id": row["id"],
                    "visit_type": row["visit_type"],
                    "items": items,
                    "llm_followup_enabled": bool(row.get("llm_followup_enabled", 1)),
                    "llm_followup_max_questions": int(row.get("llm_followup_max_questions", 5)),
                }
            )

        summary_rows = conn.execute(
            """
            SELECT id, visit_type, prompt_text, enabled
            FROM summary_prompts
            ORDER BY id, visit_type
            """
        ).fetchall()
        summary_prompts = [
            {
                "id": row["id"],
                "visit_type": row["visit_type"],
                "prompt": row.get("prompt_text", ""),
                "enabled": bool(row.get("enabled", 0)),
            }
            for row in summary_rows
        ]

        followup_rows = conn.execute(
            """
            SELECT id, visit_type, prompt_text, enabled
            FROM followup_prompts
            ORDER BY id, visit_type
            """
        ).fetchall()
        followup_prompts = [
            {
                "id": row["id"],
                "visit_type": row["visit_type"],
                "prompt": row.get("prompt_text", ""),
                "enabled": bool(row.get("enabled", 0)),
            }
            for row in followup_rows
        ]
    finally:
        conn.close()

    settings = load_app_settings(db_path) or {}
    default_qid = settings.get("default_questionnaire_id")
    llm_settings = load_llm_settings(db_path) or {}

    return {
        "templates": templates,
        "summary_prompts": summary_prompts,
        "followup_prompts": followup_prompts,
        "default_questionnaire_id": default_qid,
        "app_settings": settings,
        "llm_settings": llm_settings,
    }


def delete_session(session_id: str, db_path: str = DEFAULT_DB_PATH) -> bool:
    """指定セッションを削除する。

    戻り値は削除が実行されデータが存在したかどうか。
    付随する回答は外部キー制約 ON DELETE CASCADE により削除される。
    CouchDB が有効な場合は CouchDB から削除する。
    """
    db = get_couch_db()
    if db:
        try:
            doc = db.get(session_id)
            if not doc:
                return False
            db.delete(doc)
            return True
        except Exception:
            return False
    conn = get_conn(db_path)
    try:
        cur = conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_sessions(ids: Iterable[str], db_path: str = DEFAULT_DB_PATH) -> int:
    """複数セッションを一括削除する。削除件数を返す。"""
    id_list = [i for i in ids if i]
    if not id_list:
        return 0
    db = get_couch_db()
    if db:
        deleted = 0
        for sid in id_list:
            try:
                doc = db.get(sid)
                if not doc:
                    continue
                db.delete(doc)
                deleted += 1
            except Exception:
                pass
        return deleted
    placeholders = ",".join(["?"] * len(id_list))
    conn = get_conn(db_path)
    try:
        cur = conn.execute(f"DELETE FROM sessions WHERE id IN ({placeholders})", id_list)
        conn.commit()
        return cur.rowcount or 0
    finally:
        conn.close()

    settings = load_app_settings(db_path) or {}
    default_qid = settings.get("default_questionnaire_id")

    return {
        "templates": templates,
        "summary_prompts": summary_prompts,
        "followup_prompts": followup_prompts,
        "default_questionnaire_id": default_qid,
    }


def import_questionnaire_settings(
    data: dict[str, Any],
    mode: str = "merge",
    db_path: str = DEFAULT_DB_PATH,
) -> dict[str, int]:
    """問診テンプレートと関連設定を一括で保存する。"""

    if mode not in {"merge", "replace"}:
        raise ValueError("invalid mode")

    templates = data.get("templates") or []
    summary_prompts = data.get("summary_prompts") or []
    followup_prompts = data.get("followup_prompts") or []
    default_qid = data.get("default_questionnaire_id")
    app_settings_payload = data.get("app_settings")
    llm_settings_payload = data.get("llm_settings")

    def _normalize_item(item: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(item)
        if normalized.get("type") == "single":
            normalized["type"] = "multi"
        followups = normalized.get("followups")
        if isinstance(followups, dict):
            normalized_followups: dict[str, list[dict[str, Any]]] = {}
            for key, fitems in followups.items():
                if isinstance(fitems, list):
                    normalized_followups[key] = [_normalize_item(fi) for fi in fitems]
            normalized["followups"] = normalized_followups
        return normalized

    conn = get_conn(db_path)
    try:
        if mode == "replace":
            conn.execute("DELETE FROM questionnaire_templates")
            conn.execute("DELETE FROM summary_prompts")
            conn.execute("DELETE FROM followup_prompts")

        for tpl in templates:
            tpl_id = tpl.get("id")
            visit_type = tpl.get("visit_type")
            if not tpl_id or not visit_type:
                continue
            items = tpl.get("items") or []
            normalized_items = [_normalize_item(item) for item in items if isinstance(item, dict)]
            items_json = json.dumps(normalized_items, ensure_ascii=False)
            llm_enabled = 1 if tpl.get("llm_followup_enabled", True) else 0
            llm_max = int(tpl.get("llm_followup_max_questions", 5) or 0)
            conn.execute(
                """
                INSERT INTO questionnaire_templates (id, visit_type, items_json, llm_followup_enabled, llm_followup_max_questions)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id, visit_type) DO UPDATE SET
                    items_json=excluded.items_json,
                    llm_followup_enabled=excluded.llm_followup_enabled,
                    llm_followup_max_questions=excluded.llm_followup_max_questions
                """,
                (tpl_id, visit_type, items_json, llm_enabled, llm_max),
            )

        for sp in summary_prompts:
            tpl_id = sp.get("id")
            visit_type = sp.get("visit_type")
            if not tpl_id or not visit_type:
                continue
            prompt_text = sp.get("prompt", "")
            enabled = 1 if sp.get("enabled") else 0
            conn.execute(
                """
                INSERT INTO summary_prompts (id, visit_type, prompt_text, enabled)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id, visit_type) DO UPDATE SET
                    prompt_text=excluded.prompt_text,
                    enabled=excluded.enabled
                """,
                (tpl_id, visit_type, prompt_text, enabled),
            )

        for fp in followup_prompts:
            tpl_id = fp.get("id")
            visit_type = fp.get("visit_type")
            if not tpl_id or not visit_type:
                continue
            prompt_text = fp.get("prompt", "")
            enabled = 1 if fp.get("enabled") else 0
            conn.execute(
                """
                INSERT INTO followup_prompts (id, visit_type, prompt_text, enabled)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id, visit_type) DO UPDATE SET
                    prompt_text=excluded.prompt_text,
                    enabled=excluded.enabled
                """,
                (tpl_id, visit_type, prompt_text, enabled),
            )

        conn.commit()
    finally:
        conn.close()

    app_settings_saved = False
    default_applied = False
    if isinstance(app_settings_payload, dict):
        base_settings = {} if mode == "replace" else (load_app_settings(db_path) or {})
        merged_settings = dict(base_settings)
        merged_settings.update(app_settings_payload)
        if default_qid is not None:
            merged_settings["default_questionnaire_id"] = default_qid
            default_applied = True
        elif "default_questionnaire_id" in app_settings_payload:
            default_applied = True
        save_app_settings(merged_settings, db_path)
        app_settings_saved = True

    if default_qid is not None and not default_applied:
        current_settings = load_app_settings(db_path) or {}
        current_settings["default_questionnaire_id"] = default_qid
        save_app_settings(current_settings, db_path)
        app_settings_saved = True
        default_applied = True

    llm_settings_saved = False
    if isinstance(llm_settings_payload, dict):
        if mode == "merge":
            current_llm = load_llm_settings(db_path) or {}
            merged_llm = dict(current_llm)
            merged_llm.update(llm_settings_payload)
        else:
            merged_llm = dict(llm_settings_payload)
        save_llm_settings(merged_llm, db_path)
        llm_settings_saved = True

    return {
        "templates": len(templates),
        "summary_prompts": len(summary_prompts),
        "followup_prompts": len(followup_prompts),
        "app_settings": 1 if app_settings_saved else 0,
        "llm_settings": 1 if llm_settings_saved else 0,
    }


def export_sessions_data(
    session_ids: list[str] | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    db_path: str = DEFAULT_DB_PATH,
) -> list[dict[str, Any]]:
    """セッション情報をまとめて取得する。"""

    ids_set = set(session_ids or [])

    db = get_couch_db()
    if db:
        docs = [row.doc for row in db.view("_all_docs", include_docs=True)]
        result: list[dict[str, Any]] = []
        for doc in docs:
            sid = doc.get("_id")
            if not sid:
                continue
            if ids_set and sid not in ids_set:
                continue
            started_at = doc.get("started_at") or doc.get("finalized_at")
            if start_date and started_at and started_at < f"{start_date}T00:00:00":
                continue
            if end_date and started_at and started_at > f"{end_date}T23:59:59":
                continue
            payload = {
                "id": sid,
                "patient_name": doc.get("patient_name"),
                "dob": doc.get("dob"),
                "gender": doc.get("gender"),
                "visit_type": doc.get("visit_type"),
                "questionnaire_id": doc.get("questionnaire_id"),
                "answers": doc.get("answers", {}),
                "summary": doc.get("summary"),
                "remaining_items": doc.get("remaining_items", []),
                "completion_status": doc.get("completion_status"),
                "interrupted": (doc.get("completion_status") or "") != "finalized",
                "attempt_counts": doc.get("attempt_counts", {}),
                "additional_questions_used": doc.get("additional_questions_used", 0),
                "max_additional_questions": doc.get("max_additional_questions", 0),
                "followup_prompt": doc.get("followup_prompt"),
                "started_at": started_at,
                "finalized_at": doc.get("finalized_at"),
                "llm_question_texts": doc.get("llm_question_texts") or {},
            }
            result.append(payload)
        return result

    conn = get_conn(db_path)
    try:
        query = "SELECT * FROM sessions"
        conditions: list[str] = []
        params: list[Any] = []
        if ids_set:
            placeholders = ",".join(["?"] * len(ids_set))
            conditions.append(f"id IN ({placeholders})")
            params.extend(ids_set)
        if start_date:
            conditions.append("DATE(COALESCE(started_at, finalized_at)) >= ?")
            params.append(start_date)
        if end_date:
            conditions.append("DATE(COALESCE(started_at, finalized_at)) <= ?")
            params.append(end_date)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        rows = conn.execute(query, params).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            sid = row["id"]
            try:
                answers = json.loads(row.get("answers_json") or "{}")
            except Exception:
                answers = {}
            try:
                remaining = json.loads(row.get("remaining_items_json") or "[]")
            except Exception:
                remaining = []
            try:
                attempts = json.loads(row.get("attempt_counts_json") or "{}")
            except Exception:
                attempts = {}
            rrows = conn.execute(
                "SELECT item_id, question_text FROM session_responses WHERE session_id=?",
                (sid,),
            ).fetchall()
            llm_question_texts: dict[str, str] = {}
            for r in rrows:
                item_id = r.get("item_id")
                qtext = r.get("question_text")
                if (
                    isinstance(item_id, str)
                    and item_id.startswith("llm_")
                    and qtext
                ):
                    llm_question_texts[item_id] = qtext
            result.append(
                {
                    "id": sid,
                    "patient_name": row.get("patient_name"),
                    "dob": row.get("dob"),
                    "gender": row.get("gender"),
                    "visit_type": row.get("visit_type"),
                    "questionnaire_id": row.get("questionnaire_id"),
                    "answers": answers,
                    "summary": row.get("summary"),
                    "remaining_items": remaining,
                    "completion_status": row.get("completion_status"),
                    "interrupted": (row.get("completion_status") or "") != "finalized",
                    "attempt_counts": attempts,
                    "additional_questions_used": row.get("additional_questions_used", 0),
                    "max_additional_questions": row.get("max_additional_questions", 0),
                    "followup_prompt": row.get("followup_prompt"),
                    "started_at": row.get("started_at") or row.get("finalized_at"),
                    "finalized_at": row.get("finalized_at"),
                    "llm_question_texts": llm_question_texts,
                }
            )
        return result
    finally:
        conn.close()


def import_sessions_data(
    sessions: list[dict[str, Any]],
    mode: str = "merge",
    db_path: str = DEFAULT_DB_PATH,
) -> dict[str, int]:
    """セッション情報を一括で保存する。"""

    if mode not in {"merge", "replace"}:
        raise ValueError("invalid mode")

    db = get_couch_db()
    if db:
        if mode == "replace":
            for row in db.view("_all_docs"):
                doc = db.get(row.id)
                if doc:
                    db.delete(doc)
        for sess in sessions:
            sid = sess.get("id")
            if not sid:
                continue
            doc = {
                "_id": sid,
                "patient_name": sess.get("patient_name"),
                "dob": sess.get("dob"),
                "gender": sess.get("gender"),
                "visit_type": sess.get("visit_type"),
                "questionnaire_id": sess.get("questionnaire_id"),
                "answers": sess.get("answers", {}),
                "summary": sess.get("summary"),
                "remaining_items": sess.get("remaining_items", []),
                "completion_status": sess.get("completion_status"),
                "attempt_counts": sess.get("attempt_counts", {}),
                "additional_questions_used": sess.get("additional_questions_used", 0),
                "max_additional_questions": sess.get("max_additional_questions", 0),
                "followup_prompt": sess.get("followup_prompt"),
                "started_at": sess.get("started_at") or sess.get("finalized_at"),
                "finalized_at": sess.get("finalized_at"),
                "llm_question_texts": sess.get("llm_question_texts") or {},
            }
            existing = db.get(sid)
            if existing:
                doc["_rev"] = existing.rev
            db.save(doc)
        return {"sessions": len(sessions)}

    conn = get_conn(db_path)
    try:
        if mode == "replace":
            conn.execute("DELETE FROM session_responses")
            conn.execute("DELETE FROM sessions")

        for sess in sessions:
            sid = sess.get("id")
            if not sid:
                continue
            answers = sess.get("answers") or {}
            remaining = sess.get("remaining_items") or []
            attempts = sess.get("attempt_counts") or {}
            conn.execute(
                """
                INSERT INTO sessions (
                    id, patient_name, dob, gender, visit_type, questionnaire_id,
                    answers_json, summary, remaining_items_json, completion_status,
                    attempt_counts_json, additional_questions_used, max_additional_questions,
                    followup_prompt, started_at, finalized_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    sid,
                    sess.get("patient_name"),
                    sess.get("dob"),
                    sess.get("gender"),
                    sess.get("visit_type"),
                    sess.get("questionnaire_id"),
                    json.dumps(answers, ensure_ascii=False),
                    sess.get("summary"),
                    json.dumps(remaining, ensure_ascii=False),
                    sess.get("completion_status"),
                    json.dumps(attempts, ensure_ascii=False),
                    int(sess.get("additional_questions_used", 0) or 0),
                    int(sess.get("max_additional_questions", 0) or 0),
                    sess.get("followup_prompt"),
                    sess.get("started_at") or sess.get("finalized_at"),
                    sess.get("finalized_at"),
                ),
            )
            conn.execute("DELETE FROM session_responses WHERE session_id=?", (sid,))
            ts = sess.get("finalized_at") or sess.get("started_at") or ""
            llm_qtexts = sess.get("llm_question_texts") or {}
            for item_id, ans in answers.items():
                qtext = None
                if isinstance(item_id, str) and item_id.startswith("llm_"):
                    qtext = llm_qtexts.get(item_id)
                conn.execute(
                    """
                    INSERT INTO session_responses (session_id, item_id, answer_json, question_text, ts)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        sid,
                        item_id,
                        json.dumps(ans, ensure_ascii=False),
                        qtext,
                        ts,
                    ),
                )
        conn.commit()
    finally:
        conn.close()

    return {"sessions": len(sessions)}


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


class SQLiteAdapter:
    """既存 SQLite/CouchDB 実装をラップする永続化アダプタ。"""

    name = "sqlite"

    def __init__(self, db_path: str | None = None) -> None:
        self.default_db_path = db_path or DEFAULT_DB_PATH

    @property
    def couch_db(self) -> Any | None:
        return couch_db

    @property
    def couchdb_url(self) -> str | None:
        return COUCHDB_URL

    def init(self, db_path: str | None = None) -> None:
        if db_path:
            self.default_db_path = db_path
        init_db(self.default_db_path)

    def _call_with_db_path(self, func, *args, **kwargs):
        if "db_path" not in kwargs:
            kwargs["db_path"] = self.default_db_path
        return func(*args, **kwargs)

    def upsert_template(self, *args, **kwargs):
        return self._call_with_db_path(upsert_template, *args, **kwargs)

    def get_template(self, *args, **kwargs):
        return self._call_with_db_path(get_template, *args, **kwargs)

    def list_templates(self, *args, **kwargs):
        return self._call_with_db_path(list_templates, *args, **kwargs)

    def delete_template(self, *args, **kwargs):
        return self._call_with_db_path(delete_template, *args, **kwargs)

    def rename_template(self, *args, **kwargs):
        return self._call_with_db_path(rename_template, *args, **kwargs)

    def save_session(self, *args, **kwargs):
        return self._call_with_db_path(save_session, *args, **kwargs)

    def list_sessions(self, *args, **kwargs):
        return self._call_with_db_path(list_sessions, *args, **kwargs)

    def list_sessions_finalized_after(self, *args, **kwargs):
        return self._call_with_db_path(list_sessions_finalized_after, *args, **kwargs)

    def get_session(self, *args, **kwargs):
        return self._call_with_db_path(get_session, *args, **kwargs)

    def delete_session(self, *args, **kwargs):
        return self._call_with_db_path(delete_session, *args, **kwargs)

    def delete_sessions(self, ids: Iterable[str], *args, **kwargs):
        return self._call_with_db_path(delete_sessions, ids, *args, **kwargs)

    def upsert_summary_prompt(self, *args, **kwargs):
        return self._call_with_db_path(upsert_summary_prompt, *args, **kwargs)

    def get_summary_prompt(self, *args, **kwargs):
        return self._call_with_db_path(get_summary_prompt, *args, **kwargs)

    def get_summary_config(self, *args, **kwargs):
        return self._call_with_db_path(get_summary_config, *args, **kwargs)

    def upsert_followup_prompt(self, *args, **kwargs):
        return self._call_with_db_path(upsert_followup_prompt, *args, **kwargs)

    def get_followup_prompt(self, *args, **kwargs):
        return self._call_with_db_path(get_followup_prompt, *args, **kwargs)

    def get_followup_config(self, *args, **kwargs):
        return self._call_with_db_path(get_followup_config, *args, **kwargs)

    def save_llm_settings(self, *args, **kwargs):
        return self._call_with_db_path(save_llm_settings, *args, **kwargs)

    def load_llm_settings(self, *args, **kwargs):
        return self._call_with_db_path(load_llm_settings, *args, **kwargs)

    def save_app_settings(self, *args, **kwargs):
        return self._call_with_db_path(save_app_settings, *args, **kwargs)

    def load_app_settings(self, *args, **kwargs):
        return self._call_with_db_path(load_app_settings, *args, **kwargs)

    def export_questionnaire_settings(self, *args, **kwargs):
        return self._call_with_db_path(export_questionnaire_settings, *args, **kwargs)

    def import_questionnaire_settings(self, *args, **kwargs):
        return self._call_with_db_path(import_questionnaire_settings, *args, **kwargs)

    def export_sessions_data(self, *args, **kwargs):
        return self._call_with_db_path(export_sessions_data, *args, **kwargs)

    def import_sessions_data(self, *args, **kwargs):
        return self._call_with_db_path(import_sessions_data, *args, **kwargs)

    def list_audit_logs(self, *args, **kwargs):
        return self._call_with_db_path(list_audit_logs, *args, **kwargs)

    def get_user_by_username(self, *args, **kwargs):
        return self._call_with_db_path(get_user_by_username, *args, **kwargs)

    def update_password(self, *args, **kwargs):
        return self._call_with_db_path(update_password, *args, **kwargs)

    def verify_password(self, plain_password: str, hashed_password: str) -> bool:
        return verify_password(plain_password, hashed_password)

    def update_totp_secret(self, *args, **kwargs):
        return self._call_with_db_path(update_totp_secret, *args, **kwargs)

    def set_totp_status(self, *args, **kwargs):
        return self._call_with_db_path(set_totp_status, *args, **kwargs)

    def get_totp_mode(self, *args, **kwargs):
        return self._call_with_db_path(get_totp_mode, *args, **kwargs)

    def set_totp_mode(self, *args, **kwargs):
        return self._call_with_db_path(set_totp_mode, *args, **kwargs)

    def shutdown(self) -> None:
        """SQLite 実装では特別な終了処理は不要。"""
        return None
