"""Secret Manager integration helpers."""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Dict

try:  # pragma: no cover - optional dependency
    from google.cloud import secretmanager  # type: ignore
except Exception:  # pragma: no cover
    secretmanager = None  # type: ignore

from .config import get_settings

logger = logging.getLogger(__name__)

_DEFAULT_SECRET_KEYS = [
    "ADMIN_PASSWORD",
    "SECRET_KEY",
    "TOTP_ENC_KEY",
    "LLM_API_KEY",
]


def _build_secret_id(prefix: str | None, key: str) -> str:
    env_override = os.getenv(f"SECRET_MANAGER_{key}_SECRET_ID")
    if env_override:
        return env_override
    normalized = key.lower().replace("_", "-")
    if prefix:
        return f"{prefix}-{normalized}"
    return normalized


@lru_cache(maxsize=1)
def _client():
    if secretmanager is None:
        raise RuntimeError("google-cloud-secret-manager is not installed")
    return secretmanager.SecretManagerServiceClient()


def load_secrets(extra_keys: list[str] | None = None) -> Dict[str, str]:
    """Load secrets from Google Secret Manager and populate environment variables.

    Returns a dict mapping key -> value for successfully loaded secrets.
    """

    settings = get_settings()
    if not settings.secret_manager.enabled:
        return {}
    project_id = settings.secret_manager.project_id
    if not project_id:
        logger.warning("Secret Manager enabled but SECRET_MANAGER_PROJECT is unset")
        return {}
    if secretmanager is None:
        logger.warning("google-cloud-secret-manager not available; skipping secret load")
        return {}

    keys = list(_DEFAULT_SECRET_KEYS)
    if extra_keys:
        for key in extra_keys:
            if key not in keys:
                keys.append(key)

    loaded: Dict[str, str] = {}
    client = _client()
    for key in keys:
        secret_id = _build_secret_id(settings.secret_manager.prefix, key)
        if not secret_id:
            continue
        resource_name = f"projects/{project_id}/secrets/{secret_id}/versions/latest"
        try:
            response = client.access_secret_version(name=resource_name)
            value = response.payload.data.decode("utf-8")
        except Exception as exc:  # pragma: no cover - runtime dependent
            logger.warning("failed to access secret %s: %s", resource_name, exc)
            continue
        if not os.getenv(key):
            os.environ[key] = value
        loaded[key] = value
    return loaded


__all__ = ["load_secrets"]
