"""Security configuration validation without persistence or startup side effects."""
from __future__ import annotations

import base64
import os
import secrets

from cryptography.fernet import Fernet


def is_production() -> bool:
    return bool(os.getenv("K_SERVICE")) or os.getenv("MONSHINMATE_ENV", "local").lower() not in {
        "local", "test", "development", "dev",
    }


def admin_mfa_required() -> bool:
    """Only an explicit 0 opts production out; invalid configuration fails closed."""
    value = os.getenv("MONSHINMATE_ADMIN_REQUIRE_MFA")
    if value is None:
        return is_production()
    if value not in {"0", "1"}:
        raise RuntimeError("MONSHINMATE_ADMIN_REQUIRE_MFA must be exactly 0 or 1")
    return value == "1"


def validate_security_configuration() -> tuple[str, str]:
    admin_mfa_required()
    signing = os.getenv("SECRET_KEY", "")
    encryption = os.getenv("TOTP_ENC_KEY", "")
    if is_production():
        if (len(signing.encode()) < 32 or len(set(signing)) < 16
                or signing == "a_very_secret_key_that_should_be_changed"):
            raise RuntimeError("Production SECRET_KEY must be an independently generated random key (32+ bytes)")
        try:
            raw = base64.urlsafe_b64decode(encryption.encode())
            if len(raw) != 32 or len(set(raw)) < 16:
                raise ValueError("weak key")
            Fernet(encryption.encode())
        except Exception as exc:
            raise RuntimeError("Production TOTP_ENC_KEY must be a randomly generated Fernet key") from exc
        if signing == encryption:
            raise RuntimeError("SECRET_KEY and TOTP_ENC_KEY must be independent")
    # Local-only defaults never authorize production. Set both keys for restart stability.
    return signing or _LOCAL_SIGNING_KEY, encryption or _LOCAL_ENCRYPTION_KEY


_LOCAL_SIGNING_KEY = secrets.token_urlsafe(48)
_LOCAL_ENCRYPTION_KEY = Fernet.generate_key().decode()
SECRET_KEY, TOTP_ENC_KEY = validate_security_configuration()
