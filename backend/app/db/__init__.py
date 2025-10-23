"""永続化アダプタの切替ハブ。"""
from __future__ import annotations

from typing import Any, Callable

from ..config import get_settings
from .interfaces import PersistenceAdapter
from .sqlite_adapter import (
    SQLiteAdapter,
    DEFAULT_DB_PATH as SQLITE_DEFAULT_DB_PATH,
    fernet,
    pwd_context,
    COUCHDB_URL as SQLITE_COUCHDB_URL,
    couch_db as SQLITE_COUCH_DB,
    get_couch_db,
)
from .firestore_adapter import FirestoreAdapter


_settings = get_settings()


def _select_adapter() -> PersistenceAdapter:
    backend = (_settings.persistence_backend or "sqlite").lower()
    if backend == "firestore":
        return FirestoreAdapter(_settings.firestore)
    return SQLiteAdapter()


_adapter: PersistenceAdapter = _select_adapter()


def _delegate(name: str) -> Callable[..., Any]:
    def _proxy(*args: Any, **kwargs: Any) -> Any:
        method = getattr(_adapter, name)
        return method(*args, **kwargs)

    _proxy.__name__ = name
    _proxy.__doc__ = getattr(_adapter, name).__doc__ if hasattr(_adapter, name) else None
    return _proxy


def init_db(db_path: str | None = None) -> None:
    init_callable = getattr(_adapter, "init", None)
    if init_callable is None:
        raise RuntimeError("Selected persistence adapter does not support init_db")
    if db_path is not None:
        try:
            return init_callable(db_path)
        except TypeError:
            return init_callable()
    return init_callable()


_METHOD_NAMES = [
    "upsert_template",
    "get_template",
    "list_templates",
    "delete_template",
    "rename_template",
    "save_session",
    "list_sessions",
    "list_sessions_finalized_after",
    "get_session",
    "delete_session",
    "delete_sessions",
    "upsert_summary_prompt",
    "get_summary_prompt",
    "get_summary_config",
    "upsert_followup_prompt",
    "get_followup_prompt",
    "get_followup_config",
    "save_llm_settings",
    "load_llm_settings",
    "save_app_settings",
    "load_app_settings",
    "export_questionnaire_settings",
    "import_questionnaire_settings",
    "export_sessions_data",
    "import_sessions_data",
    "list_audit_logs",
    "get_user_by_username",
    "update_password",
    "verify_password",
    "update_totp_secret",
    "set_totp_status",
    "get_totp_mode",
    "set_totp_mode",
]

globals().update({name: _delegate(name) for name in _METHOD_NAMES})


DEFAULT_DB_PATH = getattr(_adapter, "default_db_path", None) or SQLITE_DEFAULT_DB_PATH
COUCHDB_URL = getattr(_adapter, "couchdb_url", None) or SQLITE_COUCHDB_URL
couch_db = getattr(_adapter, "couch_db", None) or SQLITE_COUCH_DB


__all__ = [
    "DEFAULT_DB_PATH",
    "COUCHDB_URL",
    "couch_db",
    "fernet",
    "pwd_context",
    "get_couch_db",
    "init_db",
] + _METHOD_NAMES
