"""アプリケーション設定のローダー。

Cloud Run / Firebase 移行計画に基づき、永続化や外部サービスの
設定値を環境変数から読み出す。Secret Manager や Emulator の
利用有無もここで判定する。
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import os


def _get_env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    if value is None:
        return default
    stripped = value.strip()
    return stripped if stripped else default


def _get_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class FirestoreConfig:
    project_id: str | None
    namespace: str | None
    emulator_host: str | None
    credentials_file: str | None
    use_emulator: bool


@dataclass(frozen=True)
class StorageConfig:
    backend: str
    bucket_name: str | None
    emulator_host: str | None
    signed_url_ttl_seconds: int


@dataclass(frozen=True)
class SecretManagerConfig:
    project_id: str | None
    prefix: str | None
    enabled: bool


@dataclass(frozen=True)
class Settings:
    environment: str
    persistence_backend: str
    firestore: FirestoreConfig
    file_storage: StorageConfig
    secret_manager: SecretManagerConfig

    @property
    def is_firestore_enabled(self) -> bool:
        return self.persistence_backend.lower() == "firestore"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    environment = _get_env("MONSHINMATE_ENV", "local")
    persistence_backend = _get_env("PERSISTENCE_BACKEND", "sqlite").lower()

    firestore_project = _get_env("FIRESTORE_PROJECT_ID", _get_env("GOOGLE_CLOUD_PROJECT"))
    firestore_namespace = _get_env("FIRESTORE_NAMESPACE")
    firestore_emulator_host = _get_env("FIRESTORE_EMULATOR_HOST")
    credentials_file = _get_env("GOOGLE_APPLICATION_CREDENTIALS")
    use_emulator = _get_bool("FIRESTORE_USE_EMULATOR", firestore_emulator_host is not None)

    firestore_config = FirestoreConfig(
        project_id=firestore_project,
        namespace=firestore_namespace,
        emulator_host=firestore_emulator_host,
        credentials_file=credentials_file,
        use_emulator=use_emulator,
    )

    file_storage_backend = _get_env("FILE_STORAGE_BACKEND", "local").lower()
    bucket_name = _get_env("GCS_BUCKET")
    storage_emulator_host = _get_env("STORAGE_EMULATOR_HOST")
    signed_url_ttl = int(os.getenv("GCS_SIGNED_URL_TTL", "3600"))

    storage_config = StorageConfig(
        backend=file_storage_backend,
        bucket_name=bucket_name,
        emulator_host=storage_emulator_host,
        signed_url_ttl_seconds=signed_url_ttl,
    )

    secret_project = _get_env("SECRET_MANAGER_PROJECT", firestore_project)
    secret_prefix = _get_env("SECRET_MANAGER_PREFIX", "monshinmate")
    secret_enabled = _get_bool("SECRET_MANAGER_ENABLED", secret_project is not None)

    secret_config = SecretManagerConfig(
        project_id=secret_project,
        prefix=secret_prefix,
        enabled=secret_enabled,
    )

    return Settings(
        environment=environment,
        persistence_backend=persistence_backend,
        firestore=firestore_config,
        file_storage=storage_config,
        secret_manager=secret_config,
    )


__all__ = ["FirestoreConfig", "StorageConfig", "SecretManagerConfig", "Settings", "get_settings"]
