"""Patient capabilities and persistent, fail-closed operation serialization.

Capability state is deliberately separate from exported clinical records. An
abandoned lease is not stolen: an operator must reconcile the record before
clearing it, otherwise a slow original worker could overwrite newer data.
"""
from __future__ import annotations

from datetime import UTC, datetime
import hashlib
import secrets
import time
from typing import Any

from fastapi import HTTPException, Request

from .security_state import get_state, compare_and_swap_state

SESSION_TTL_SECONDS = 24 * 60 * 60


def _key(session_id: str) -> str:
    return f"patient:capability:{session_id}"


def issue_capability(session_id: str) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    expires = time.time() + SESSION_TTL_SECONDS
    state = {"token_hash": hashlib.sha256(token.encode()).hexdigest(),
             "expires_at": expires, "status": "open", "operation": None}
    if not compare_and_swap_state(_key(session_id), None, state):
        raise HTTPException(503, "session credential unavailable")
    return token, datetime.fromtimestamp(expires, UTC).isoformat()


def rate_limit(key: str, limit: int, window: int = 60) -> None:
    now = time.time()
    bucket = int(now // window)
    # Stable document ID; buckets replace their predecessor, not unbounded keys.
    storage_key = "rate:" + hashlib.sha256(key.encode()).hexdigest()
    for _ in range(10):
        revision, current = get_state(storage_key)
        current = current or {}
        count = int(current.get("count", 0)) if current.get("bucket") == bucket else 0
        if count >= limit:
            raise HTTPException(429, "request limit exceeded", headers={"Retry-After": str(window)})
        if compare_and_swap_state(storage_key, revision, {
            "bucket": bucket, "count": count + 1, "expires_at": (bucket + 2) * window,
        }):
            return
    raise HTTPException(503, "rate limiter unavailable")


def limit_session_creation(request: Request) -> None:
    # Never trust a client-supplied X-Forwarded-For header here. The ASGI server's
    # trusted proxy configuration is responsible for resolving request.client.
    address = request.client.host if request.client else "unknown"
    rate_limit("session:create:ip:" + address, 60)
    rate_limit("session:create:global", 300)


async def require_patient_session(request: Request):
    session_id = request.path_params["session_id"]
    if not session_id or len(session_id) > 128:
        raise HTTPException(401, "invalid patient credential")
    raw = request.headers.get("authorization", "")
    scheme, _, token = raw.partition(" ")
    if scheme.lower() != "bearer" or not token or len(token) > 128:
        raise HTTPException(401, "patient authentication required")
    digest = hashlib.sha256(token.encode()).hexdigest()
    operation = secrets.token_urlsafe(24)
    key = _key(session_id)
    for _ in range(10):
        revision, state = get_state(key)
        if (not state or state.get("status") == "deleted"
                or float(state.get("expires_at", 0)) <= time.time()
                or not secrets.compare_digest(str(state.get("token_hash", "")), digest)):
            raise HTTPException(401, "invalid patient credential")
        if state.get("status") == "finalized":
            if not request.url.path.endswith("/finalize"):
                raise HTTPException(409, "session finalized")
            request.state.patient_receipt = state["receipt"]
            yield
            return
        if state.get("operation"):
            raise HTTPException(409, "session operation in progress", headers={"Retry-After": "2"})
        locked = {**state, "operation": operation, "operation_started_at": time.time()}
        if compare_and_swap_state(key, revision, locked):
            break
    else:
        raise HTTPException(503, "session busy")
    request.state.patient_operation = operation
    try:
        yield
    finally:
        for _ in range(10):
            revision, state = get_state(key)
            if not state or state.get("operation") != operation:
                break
            if compare_and_swap_state(key, revision, {**state, "operation": None}):
                break


def finalize_receipt(session_id: str, finalized_at: str, operation: str) -> dict[str, str]:
    receipt = {"id": session_id, "status": "finalized", "finalized_at": finalized_at}
    key = _key(session_id)
    revision, state = get_state(key)
    if not state or state.get("operation") != operation:
        raise HTTPException(409, "session operation changed")
    if not compare_and_swap_state(key, revision, {**state, "status": "finalized", "receipt": receipt}):
        raise HTTPException(409, "session operation changed")
    return receipt


def revoke_capability(session_id: str) -> None:
    key = _key(session_id)
    for _ in range(10):
        revision, state = get_state(key)
        if state and state.get("operation"):
            raise HTTPException(409, "session operation in progress")
        if compare_and_swap_state(key, revision, {"status": "deleted", "expires_at": time.time()}):
            return
    raise HTTPException(503, "session busy")
