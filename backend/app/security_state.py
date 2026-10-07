"""Persistent, namespaced security state. No process-memory fallback.

Transforms may be retried and must not have external side effects. Keep patient
content outside this store: use only opaque identifiers, hashes and counters.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

from fastapi import HTTPException

from . import db

Revision = str | int | None


def _validate_key(key: str) -> None:
    if not isinstance(key, str) or ":" not in key or len(key) > 240:
        raise ValueError("Security state requires a namespaced key of at most 240 characters")


def get_state(key: str) -> tuple[Revision, dict[str, Any] | None]:
    _validate_key(key)
    try:
        revision, value = db.security_get_state(key)
        if (revision is None) != (value is None) or (value is not None and not isinstance(value, dict)):
            raise ValueError("Invalid security state response")
        return revision, deepcopy(value)
    except Exception as exc:
        raise HTTPException(503, "Persistent security state unavailable") from exc


def compare_and_swap_state(key: str, revision: Revision, value: dict[str, Any]) -> bool:
    _validate_key(key)
    if not isinstance(value, dict):
        raise ValueError("Security state must be a dictionary")
    try:
        return db.security_compare_and_swap_state(key, revision, deepcopy(value))
    except Exception as exc:
        raise HTTPException(503, "Persistent security state unavailable") from exc


def update_state(key: str, transform: Callable[[dict[str, Any] | None], dict[str, Any]]) -> dict[str, Any]:
    for _ in range(12):
        revision, value = get_state(key)
        updated = transform(value)
        if compare_and_swap_state(key, revision, updated):
            return updated
    raise HTTPException(503, "Persistent security state contention; retry later")
