"""永続化レイヤーのインターフェース定義。

Cloud Run + Firebase への移行では、SQLite/CouchDB ベースの
ローカル実装と Firestore 実装を並行して運用する必要がある。
ここでは、既存コードが期待する操作の最小集合を `Protocol`
として定義し、アダプタ切替時の型安全性を確保する。
"""
from __future__ import annotations

from typing import Any, Iterable, Protocol


class PersistenceAdapter(Protocol):
    """永続化アダプタが満たすべき操作インターフェース。"""

    name: str
    couch_db: Any | None
    couchdb_url: str | None
    default_db_path: str | None

    def init(self) -> None:
        """起動時初期化処理を実行する。"""

    def upsert_template(self, *args: Any, **kwargs: Any) -> None:
        ...

    def get_template(self, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        ...

    def list_templates(self, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        ...

    def delete_template(self, *args: Any, **kwargs: Any) -> None:
        ...

    def rename_template(self, *args: Any, **kwargs: Any) -> None:
        ...

    def save_session(self, *args: Any, **kwargs: Any) -> None:
        ...

    def list_sessions(self, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        ...

    def list_sessions_finalized_after(self, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        ...

    def get_session(self, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        ...

    def delete_session(self, *args: Any, **kwargs: Any) -> bool:
        ...

    def delete_sessions(self, ids: Iterable[str], *args: Any, **kwargs: Any) -> int:
        ...

    def upsert_summary_prompt(self, *args: Any, **kwargs: Any) -> None:
        ...

    def get_summary_prompt(self, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        ...

    def get_summary_config(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        ...

    def upsert_followup_prompt(self, *args: Any, **kwargs: Any) -> None:
        ...

    def get_followup_prompt(self, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        ...

    def get_followup_config(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        ...

    def save_llm_settings(self, *args: Any, **kwargs: Any) -> None:
        ...

    def load_llm_settings(self, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        ...

    def save_app_settings(self, *args: Any, **kwargs: Any) -> None:
        ...

    def load_app_settings(self, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        ...

    def export_questionnaire_settings(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        ...

    def import_questionnaire_settings(self, *args: Any, **kwargs: Any) -> None:
        ...

    def export_sessions_data(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        ...

    def import_sessions_data(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        ...

    def list_audit_logs(self, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        ...

    def get_user_by_username(self, *args: Any, **kwargs: Any) -> dict[str, Any] | None:
        ...

    def update_password(self, *args: Any, **kwargs: Any) -> None:
        ...

    def verify_password(self, *args: Any, **kwargs: Any) -> bool:
        ...

    def update_totp_secret(self, *args: Any, **kwargs: Any) -> None:
        ...

    def set_totp_status(self, *args: Any, **kwargs: Any) -> None:
        ...

    def get_totp_mode(self, *args: Any, **kwargs: Any) -> str:
        ...

    def set_totp_mode(self, *args: Any, **kwargs: Any) -> None:
        ...

    def shutdown(self) -> None:
        """終了処理を実行する（必要な場合のみ）。"""


__all__ = ["PersistenceAdapter"]
