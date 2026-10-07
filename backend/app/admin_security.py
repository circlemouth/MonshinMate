"""Admin authentication with a single CAS-committed credential aggregate.

The legacy users table is deliberately not an HTTP authentication source. Only
explicit offline provisioning/migration can import credentials. MFA, revocation,
challenge consumption and enrollment changes always commit in ONE CAS.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import logging
import os
import re
import secrets
import time
from typing import Any, Callable

import bcrypt
import pyotp
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from jose import JWTError, jwt

from .security_config import SECRET_KEY, TOTP_ENC_KEY, admin_mfa_required
from .security_state import compare_and_swap_state, get_state, update_state

ACCOUNT_KEY = "admin:account:v1"
AUDIENCE = "monshinmate-admin"
ISSUER = "monshinmate"
ACCESS_SECONDS = 900
CHALLENGE_SECONDS = 300
ENROLL_SECONDS = 600
REAUTH_SECONDS = 300
_cipher = Fernet(TOTP_ENC_KEY.encode())


def _now() -> int:
    return int(time.time())


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def validate_password(password: str) -> None:
    if len(password) < 12 or len(password.encode("utf-8")) > 72:
        raise HTTPException(400, "Password must have at least 12 characters and at most 72 UTF-8 bytes")


def _hash_password(password: str) -> str:
    validate_password(password)
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def _verify_password(password: str, stored: str | None) -> bool:
    if not isinstance(stored, str) or not stored or not password or len(password.encode()) > 72:
        return False
    try:
        return bcrypt.checkpw(password.encode(), stored.encode())
    except (ValueError, TypeError):
        return False


def account() -> dict[str, Any]:
    return get_state(ACCOUNT_KEY)[1] or {}


def _mutate(action: Callable[[dict[str, Any]], dict[str, Any]], event: str | None = None) -> dict[str, Any]:
    for _ in range(12):
        revision, state = get_state(ACCOUNT_KEY)
        state = state or {}
        result = action(state)
        if compare_and_swap_state(ACCOUNT_KEY, revision, state):
            # Failed attempts must be committed too, not rolled back by raising.
            if "_error" in result:
                raise HTTPException(result.get("_status", 401), result["_error"])
            if event:
                logging.getLogger("security").warning("admin_security_event event=%s version=%s", event, state.get("version"))
            return result
    raise HTTPException(503, "Authentication state busy; retry later")


def _limit(operation: str, maximum: int = 20) -> None:
    now = _now()
    def increment(state):
        state = state or {}
        if state.get("until", 0) <= now:
            state = {"until": now + 300, "count": 0}
        state["count"] += 1
        return state
    state = update_state("admin:rate:" + operation, increment)
    if state["count"] > maximum:
        raise HTTPException(429, "Too many authentication attempts; retry later")


def _issue(state: dict[str, Any], purpose: str, seconds: int, **extra: Any) -> str:
    now = _now()
    claims = {
        "sub": "admin", "iss": ISSUER, "aud": AUDIENCE, "purpose": purpose,
        "iat": now, "nbf": now, "exp": now + seconds, "jti": secrets.token_urlsafe(24),
        "ver": state["version"], **extra,
    }
    return jwt.encode(claims, SECRET_KEY, algorithm="HS256")


def _decode(token: str, purpose: str) -> dict[str, Any]:
    try:
        claims = jwt.decode(token, SECRET_KEY, algorithms=["HS256"], audience=AUDIENCE,
                            issuer=ISSUER, options={"require_exp": True, "require_iat": True,
                                                  "require_nbf": True, "require_sub": True,
                                                  "require_aud": True, "require_iss": True,
                                                  "require_jti": True})
        required = {"sub", "iss", "aud", "purpose", "iat", "nbf", "exp", "jti", "ver"}
        if (not required.issubset(claims) or claims["sub"] != "admin"
                or claims["purpose"] != purpose or claims["aud"] != AUDIENCE):
            raise ValueError("wrong token purpose")
        if any(type(claims[k]) is not int for k in ("iat", "nbf", "exp", "ver")):
            raise ValueError("invalid numeric claim")
        lifetime = {"access": ACCESS_SECONDS, "enrollment": ENROLL_SECONDS, "reauth": REAUTH_SECONDS}[purpose]
        if (claims["iat"] > _now() or claims["nbf"] != claims["iat"]
                or not 0 < claims["exp"] - claims["iat"] <= lifetime
                or not isinstance(claims["jti"], str) or not claims["jti"]):
            raise ValueError("invalid token claims")
        return claims
    except (JWTError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(401, "Invalid authentication token") from exc


def _validate_account(state: dict[str, Any]) -> None:
    if (any(type(state.get(key)) is not bool for key in ("mfa", "locked", "enrollment_required"))
            or type(state.get("version")) is not int or state["version"] < 1
            or (not state["mfa"] and state.get("totp_secret") is not None)
            or (not state["enrollment_required"] and state.get("enrollment_grant") is not None)):
        raise HTTPException(503, "Invalid authentication state; offline recovery required")
    pending = state.get("pending")
    if not state["mfa"] and not state["enrollment_required"] and pending is not None:
        # Only explicitly voluntary access+reauth setup may coexist with pwd access.
        if (not isinstance(pending, dict) or pending.get("kind") != "voluntary"
                or type(pending.get("exp")) is not int
                or type(pending.get("attempts")) is not int
                or any(not isinstance(pending.get(k), str) or not pending[k]
                       for k in ("id", "secret", "owner"))):
            raise HTTPException(403, "MFA enrollment pending")


def _check_version(state: dict[str, Any], claims: dict[str, Any]) -> None:
    if not state or state.get("locked") or state.get("offline") is not None or state.get("version") != claims["ver"]:
        raise HTTPException(401, "Authentication revoked; sign in again")


def _secret(state: dict[str, Any]) -> str:
    try:
        encrypted = state["totp_secret"]
        if not encrypted:
            raise ValueError("missing secret")
        secret = _cipher.decrypt(encrypted.encode()).decode()
        pyotp.TOTP(secret).now()  # Validate the decrypted base32 too.
        return secret
    except (KeyError, ValueError, TypeError, InvalidToken) as exc:
        raise HTTPException(503, "MFA unavailable; offline recovery required") from exc


def _totp_step(secret: str, code: str, last: int = -1) -> int | None:
    if not re.fullmatch(r"[0-9]{6}", code):
        return None
    step = _now() // 30
    totp = pyotp.TOTP(secret)
    for candidate in (step, step - 1, step + 1):
        if candidate > last and hmac.compare_digest(totp.at(candidate * 30), code):
            return candidate
    return None


def _access_result(state: dict[str, Any]) -> dict[str, Any]:
    _validate_account(state)
    if state.get("locked") or state.get("offline") is not None:
        raise HTTPException(401, "Authentication revoked; sign in again")
    if not state["mfa"] and state.get("pending") is not None:
        pending = state["pending"]
        # Cleanup happens inside the same CAS as login, never from read-only access.
        if pending.get("kind") == "voluntary" and pending["exp"] <= _now():
            state["pending"] = None
    if state.get("enrollment_required") or (admin_mfa_required() and not state.get("mfa")):
        raise HTTPException(403, "MFA enrollment required")
    if state.get("mfa"):
        _secret(state)
    return {"status": "ok", "access_token": _issue(state, "access", ACCESS_SECONDS,
            scope="admin push:manage", amr=["pwd", "otp"] if state.get("mfa") else ["pwd"]),
            "token_type": "bearer", "expires_in": ACCESS_SECONDS}


def decode_access(authorization: str | None) -> dict[str, Any]:
    claims = _decode(_bearer(authorization), "access")
    state = account()
    _check_access(state, claims)
    return claims


def _check_access(state, claims):
    _check_version(state, claims)
    _validate_account(state)
    if (claims.get("scope") != "admin push:manage"
            or claims.get("amr") not in (["pwd"], ["pwd", "otp"])):
        raise HTTPException(403, "Insufficient scope")
    if state.get("enrollment_required") or (admin_mfa_required() and not state.get("mfa")):
        raise HTTPException(403, "MFA enrollment required")
    if state.get("mfa"):
        _secret(state)
        if "otp" not in claims.get("amr", []):
            raise HTTPException(401, "MFA authentication required")


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Authentication required")
    return authorization.split(" ", 1)[1].strip()


def _enrollment_result(state):
    state["enrollment_required"] = True
    token = _issue(state, "enrollment", ENROLL_SECONDS, scope="admin:enroll")
    state["enrollment_grant"] = _decode(token, "enrollment")["jti"]
    return {"status": "enrollment_required", "enrollment_token": token, "expires_in": ENROLL_SECONDS}


def login(password: str) -> dict[str, Any]:
    _limit("login")
    def action(state):
        if state.get("locked") or state.get("offline") is not None or not _verify_password(password, state.get("password_hash")):
            raise HTTPException(401, "Invalid credentials")
        _validate_account(state)
        if state.get("mfa"):
            _secret(state)  # Never silently downgrade missing/decrypt-failed MFA.
            challenge = secrets.token_urlsafe(32)
            challenges = {k: v for k, v in state.get("challenges", {}).items() if v["exp"] > _now()}
            if len(challenges) >= 32:
                raise HTTPException(429, "Too many active login challenges")
            challenges[_digest(challenge)] = {"exp": _now() + CHALLENGE_SECONDS, "attempts": 0,
                                               "ver": state["version"]}
            state["challenges"] = challenges
            return {"status": "totp_required", "challenge_token": challenge, "expires_in": CHALLENGE_SECONDS}
        if state.get("enrollment_required") or admin_mfa_required():
            return _enrollment_result(state)
        return _access_result(state)
    return _mutate(action)


def login_totp(challenge_token: str, code: str) -> dict[str, Any]:
    _limit("totp")
    def action(state):
        key = _digest(challenge_token)
        challenge = state.get("challenges", {}).get(key)
        if (state.get("locked") or not state.get("mfa") or not challenge
                or challenge["exp"] <= _now() or challenge["ver"] != state.get("version")
                or challenge["attempts"] >= 5):
            raise HTTPException(401, "Invalid or expired login challenge")
        challenge["attempts"] += 1
        step = _totp_step(_secret(state), code, state.get("last_totp_step", -1))
        if step is None:
            return {"_error": "Invalid or replayed TOTP code"}
        del state["challenges"][key]
        state["last_totp_step"] = step
        return _access_result(state)
    return _mutate(action)


def issue_offline_credential(kind: str, ttl: int = 900) -> str:
    """Offline-only; never expose this function through an HTTP route."""
    if kind not in {"bootstrap", "recovery"} or not 60 <= ttl <= 3600:
        raise ValueError("Invalid offline credential parameters")
    credential = secrets.token_urlsafe(48)
    def action(state):
        if kind == "bootstrap" and state.get("password_hash"):
            raise HTTPException(409, "Account exists; use offline recovery")
        state["version"] = state.get("version", 0) + 1
        state.update(locked=True, challenges={}, pending=None, enrollment_grant=None)
        state["offline"] = {"kind": kind, "digest": _digest(credential), "exp": _now() + ttl, "attempts": 0}
        return {}
    _mutate(action, "offline_credential_issued")
    return credential


def consume_offline_credential(kind: str, credential: str, password: str) -> dict[str, Any]:
    _limit("offline", 10)
    hashed = _hash_password(password)
    def action(state):
        ticket = state.get("offline")
        if not ticket or ticket["exp"] <= _now() or ticket["attempts"] >= 5:
            raise HTTPException(401, "Invalid or expired offline credential")
        ticket["attempts"] += 1
        if ticket["kind"] != kind or not hmac.compare_digest(ticket["digest"], _digest(credential)):
            return {"_error": "Invalid or expired offline credential"}
        version = state.get("version", 0) + 1
        state.clear()
        # Preserve legacy enrollment-by-default; only explicit policy=0 skips it.
        enrollment = admin_mfa_required() or os.getenv("MONSHINMATE_ADMIN_REQUIRE_MFA") != "0"
        state.update(version=version, password_hash=hashed, mfa=False, totp_secret=None,
                     enrollment_required=enrollment, locked=False, challenges={}, last_totp_step=-1)
        return _enrollment_result(state) if enrollment else _access_result(state)
    return _mutate(action, "offline_credential_consumed")


def reauthenticate(authorization: str | None, password: str, code: str | None) -> dict[str, Any]:
    _limit("reauth")
    claims = _decode(_bearer(authorization), "access")
    def action(state):
        _check_access(state, claims)
        if not _verify_password(password, state.get("password_hash")):
            raise HTTPException(401, "Invalid credentials")
        if state.get("mfa"):
            step = _totp_step(_secret(state), code or "", state.get("last_totp_step", -1))
            if step is None:
                raise HTTPException(401, "Invalid or replayed TOTP code")
            state["last_totp_step"] = step
        return {"reauth_token": _issue(state, "reauth", REAUTH_SECONDS, access_jti=claims["jti"]),
                "expires_in": REAUTH_SECONDS}
    return _mutate(action)


def _mutation_claims(authorization: str | None, reauth_token: str | None):
    access = _decode(_bearer(authorization), "access")
    reauth = _decode(reauth_token or "", "reauth")
    if reauth.get("access_jti") != access["jti"] or reauth["ver"] != access["ver"]:
        raise HTTPException(401, "Recent reauthentication required")
    return access


def _enrollment_claims(authorization, reauth_token):
    token = _bearer(authorization)
    try:
        return _decode(token, "enrollment")
    except HTTPException:
        return _mutation_claims(authorization, reauth_token)


def _check_enrollment(state, claims):
    _check_version(state, claims)
    if claims["purpose"] == "enrollment":
        if (not state.get("enrollment_required") or state.get("enrollment_grant") != claims["jti"]
                or claims.get("scope") != "admin:enroll"):
            raise HTTPException(401, "Enrollment authorization revoked")
    else:
        _check_access(state, claims)


def setup_totp(authorization: str | None, reauth_token: str | None) -> dict[str, Any]:
    _limit("enroll")
    claims = _enrollment_claims(authorization, reauth_token)
    secret = pyotp.random_base32()
    enrollment_id = secrets.token_urlsafe(24)
    encrypted = _cipher.encrypt(secret.encode()).decode()
    def action(state):
        _check_enrollment(state, claims)
        kind = "voluntary" if claims["purpose"] == "access" and not state["mfa"] else "required"
        state["pending"] = {"id": enrollment_id, "secret": encrypted, "exp": _now() + ENROLL_SECONDS,
                            "owner": claims["jti"], "attempts": 0, "kind": kind}
        return {}
    _mutate(action, "totp_enrollment_started")
    # Generated value is returned once, never retrieved from storage by an API.
    uri = pyotp.TOTP(secret).provisioning_uri(name="admin@MonshinMate", issuer_name="MonshinMate")
    import qrcode
    output = io.BytesIO()
    qrcode.make(uri).save(output, "PNG")
    return {"enrollment_id": enrollment_id, "provisioning_uri": uri,
            "qr_code_data_url": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(),
            "expires_in": ENROLL_SECONDS}


def verify_enrollment(authorization, reauth_token, enrollment_id: str, code: str):
    _limit("verify_enroll")
    claims = _enrollment_claims(authorization, reauth_token)
    def action(state):
        _check_enrollment(state, claims)
        pending = state.get("pending")
        if (not pending or pending["id"] != enrollment_id or pending["owner"] != claims["jti"]
                or pending["exp"] <= _now() or pending["attempts"] >= 5):
            raise HTTPException(401, "Invalid or expired enrollment")
        pending["attempts"] += 1
        secret = _secret({"totp_secret": pending["secret"]})
        step = _totp_step(secret, code)
        if step is None:
            return {"_error": "Invalid TOTP code"}
        state.update(totp_secret=pending["secret"], mfa=True, enrollment_required=False,
                     pending=None, enrollment_grant=None, challenges={}, last_totp_step=step)
        state["version"] += 1
        return _access_result(state)
    return _mutate(action, "totp_enrollment_completed")


def change_password(authorization, reauth_token, current_password: str, new_password: str):
    claims = _mutation_claims(authorization, reauth_token)
    hashed = _hash_password(new_password)
    def action(state):
        _check_access(state, claims)
        if not _verify_password(current_password, state.get("password_hash")):
            raise HTTPException(401, "Invalid credentials")
        # MFA is preserved; revocation and password change share this CAS.
        state.update(password_hash=hashed, challenges={}, pending=None, enrollment_grant=None)
        state["version"] += 1
        return {"status": "ok", "reauthentication_required": True}
    return _mutate(action, "password_changed")


def disable_totp(authorization, reauth_token):
    claims = _mutation_claims(authorization, reauth_token)
    if admin_mfa_required():
        raise HTTPException(403, "MFA is mandatory under current policy")
    def action(state):
        _check_access(state, claims)
        state.update(mfa=False, totp_secret=None, pending=None, challenges={}, enrollment_grant=None)
        state["version"] += 1
        return {"status": "ok", "reauthentication_required": True}
    return _mutate(action, "totp_disabled")


def auth_status(authorization: str | None) -> dict[str, Any]:
    state = account()
    authenticated = False
    if authorization:
        try:
            decode_access(authorization)
            authenticated = True
        except HTTPException as exc:
            if exc.status_code == 503:
                raise
    return {"is_initial_password": not bool(state.get("password_hash")),
            "bootstrap_required": not bool(state.get("password_hash")),
            "is_totp_enabled": bool(state.get("mfa")),
            "totp_mode": "login_and_reset" if state.get("mfa") else "off",
            "emergency_reset_available": False, "is_authenticated": authenticated,
            "mfa_required": admin_mfa_required() or bool(state.get("enrollment_required"))}
