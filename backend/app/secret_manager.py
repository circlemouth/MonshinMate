"""Secret Manager フックのローダー。

Google Cloud Secret Manager へのアクセス実装はプライベートサブモジュール側で提供し、
ここでは利用可能であればそれを呼び出す役割のみを担う。
"""
from __future__ import annotations

import logging
import os
import sys
from importlib import import_module
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

def _resolve_project_root() -> Path:
    """Detect the repository root both locally and inside the Cloud Run image."""

    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "private" / "cloud-run-adapter"
        if candidate.exists():
            return parent
    return Path(__file__).resolve().parents[2]


_PROJECT_ROOT = _resolve_project_root()
_PRIVATE_DIR = _PROJECT_ROOT / "private"
_ADAPTER_DIR = _PRIVATE_DIR / "cloud-run-adapter"
for candidate in (_ADAPTER_DIR, _PRIVATE_DIR):
    if candidate.exists():
        path_str = str(candidate)
        if path_str not in sys.path:
            sys.path.insert(0, path_str)

from .config import get_settings

logger = logging.getLogger(__name__)

_DEFAULT_SECRET_KEYS = [
    "ADMIN_PASSWORD",
    "SECRET_KEY",
    "TOTP_ENC_KEY",
    "LLM_API_KEY",
]


def _parse_spec(spec: str) -> Tuple[str, str]:
    stripped = spec.strip()
    if not stripped:
        return ("", "load_secrets")
    if ":" in stripped:
        module_name, attr = stripped.split(":", 1)
        return (module_name.strip(), (attr or "load_secrets").strip() or "load_secrets")
    if "." in stripped:
        module_name, attr = stripped.rsplit(".", 1)
        return (module_name.strip(), (attr or "load_secrets").strip() or "load_secrets")
    return (stripped, "load_secrets")


def _load_secret_loader() -> Optional[Callable[[List[str], list[str] | None], Dict[str, str]]]:
    env_spec = os.getenv("MONSHINMATE_SECRET_MANAGER_ADAPTER", "")
    candidates: list[str] = []
    if env_spec:
        candidates.extend(part for part in env_spec.split(",") if part.strip())
    candidates.extend(
        [
            "monshinmate_cloud.secret_manager:load_secrets",
            "monshinmate_cloud_run.secret_manager:load_secrets",
            "app.secret_manager_cloud:load_secrets",
        ]
    )
    seen: set[Tuple[str, str]] = set()
    for spec in candidates:
        module_name, attr_name = _parse_spec(spec)
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
        loader = getattr(module, attr_name, None)
        if not callable(loader):
            continue
        return loader
    return None


_secret_loader = _load_secret_loader()


def load_secrets(extra_keys: list[str] | None = None) -> Dict[str, str]:
    """Secret Manager からシークレットを読み込む（利用可能な場合）。"""

    settings = get_settings()
    if not settings.secret_manager.enabled:
        return {}
    if _secret_loader is None:
        logger.info(
            "Secret Manager が有効化されていますが、実装プラグインがロードできませんでした。"
            " Cloud Run 用サブモジュールを追加し、MONSHINMATE_SECRET_MANAGER_ADAPTER を設定してください。"
        )
        return {}
    return _secret_loader(_DEFAULT_SECRET_KEYS, extra_keys)


__all__ = ["_DEFAULT_SECRET_KEYS", "load_secrets"]
