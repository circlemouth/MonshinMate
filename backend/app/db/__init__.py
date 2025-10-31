"""永続化アダプタの切替ハブ。"""
from __future__ import annotations

import os
from importlib import import_module
import sys
from pathlib import Path
import logging
from typing import Any, Callable, Optional, Tuple, Type

def _resolve_project_root() -> Path:
    """Detect the repository root both locally and inside the Cloud Run image."""

    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "private" / "cloud-run-adapter"
        if candidate.exists():
            return parent
    # Fallback to the previous heuristic (kept for backwards compatibility).
    return Path(__file__).resolve().parents[3]


_PROJECT_ROOT = _resolve_project_root()
_PRIVATE_DIR = _PROJECT_ROOT / "private"
_ADAPTER_DIR = _PRIVATE_DIR / "cloud-run-adapter"
for candidate in (_ADAPTER_DIR, _PRIVATE_DIR):
    if candidate.exists():
        path_str = str(candidate)
        if path_str not in sys.path:
            sys.path.insert(0, path_str)

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


def _parse_adapter_spec(spec: str) -> Tuple[str, str]:
    stripped = spec.strip()
    if not stripped:
        return ("", "FirestoreAdapter")
    if ":" in stripped:
        module_name, attr = stripped.split(":", 1)
        return (module_name.strip(), (attr or "FirestoreAdapter").strip() or "FirestoreAdapter")
    if "." in stripped:
        module_name, attr = stripped.rsplit(".", 1)
        return (module_name.strip(), (attr or "FirestoreAdapter").strip() or "FirestoreAdapter")
    return (stripped, "FirestoreAdapter")


def _load_firestore_adapter_class() -> Optional[Type[PersistenceAdapter]]:
    env_spec = os.getenv("MONSHINMATE_FIRESTORE_ADAPTER", "")
    candidates: list[str] = []
    if env_spec:
        candidates.extend(part for part in env_spec.split(",") if part.strip())
    candidates.extend(
        [
            "monshinmate_cloud.firestore_adapter:FirestoreAdapter",
            "monshinmate_cloud_run.firestore_adapter:FirestoreAdapter",
            "app.db.firestore_adapter:FirestoreAdapter",
        ]
    )
    seen: set[Tuple[str, str]] = set()
    for spec in candidates:
        module_name, attr_name = _parse_adapter_spec(spec)
        if not module_name:
            continue
        key = (module_name, attr_name)
        if key in seen:
            continue
        seen.add(key)
        try:
            module = import_module(module_name)
        except ModuleNotFoundError:
            continue
        adapter_class = getattr(module, attr_name, None)
        if adapter_class is None:
            continue
        if not callable(adapter_class):
            continue
        return adapter_class
    return None


logger = logging.getLogger(__name__)

_settings = get_settings()
_firestore_adapter_class = _load_firestore_adapter_class()


def _select_adapter() -> PersistenceAdapter:
    backend = (_settings.persistence_backend or "sqlite").lower()
    if backend == "firestore":
        if _firestore_adapter_class is None:
            raise RuntimeError(
                "Firestore バックエンドが選択されていますが、利用可能な実装が見つかりません。"
                " MONSHINMATE_FIRESTORE_ADAPTER 環境変数でプライベートモジュールを指定し、"
                "Cloud Run 用サブモジュールを追加してください。"
            )
        return _firestore_adapter_class(_settings.firestore)  # type: ignore[call-arg]
    return SQLiteAdapter()


_adapter: PersistenceAdapter = _select_adapter()

def get_current_persistence_backend() -> str:
    """現在選択されている永続化バックエンド名を返す。"""
    name = getattr(_adapter, "name", None)
    if isinstance(name, str) and name:
        return name.lower()
    return (_settings.persistence_backend or "sqlite").lower()


def check_firestore_health() -> bool:
    """Firestore 接続のヘルスチェックを行う。"""
    if get_current_persistence_backend() != "firestore":
        return False
    adapter = _adapter
    try:
        health_check = getattr(adapter, "health_check", None)
        if callable(health_check):
            health_check()
        else:
            adapter.list_templates()  # type: ignore[attr-defined]
        return True
    except Exception as exc:  # pragma: no cover - 例外時のみ
        logger.warning("firestore_health_check_failed: %s", exc)
        return False

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
    "save_binary_asset",
    "load_binary_asset",
    "delete_binary_asset",
    "list_binary_assets",
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
    "check_firestore_health",
    "get_current_persistence_backend",
    "fernet",
    "pwd_context",
    "get_couch_db",
    "init_db",
] + _METHOD_NAMES

