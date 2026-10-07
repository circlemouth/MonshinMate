#!/usr/bin/env python3
"""Offline operator tool: issue a short-lived, one-use bootstrap/recovery credential.

Run only against an explicitly selected backend, with server configuration keys
supplied by the operator. Never loads .env. The credential is written once to an
exclusive mode-0600 file, not stdout, argv, audit logs, or a permanent password.
Recovery immediately revokes access and locks login until redeemed/reissued.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


def legacy_eligibility(legacy: object) -> str:
    """Pure eligibility validator shared by preflight and migration; returns enums only."""
    import re
    import bcrypt

    if legacy is None:
        return "legacy_absent"
    if not isinstance(legacy, dict) or legacy.get("username") != "admin":
        return "legacy_invalid"

    def explicit_false(value: object) -> bool:
        return type(value) in (bool, int) and value == 0

    if not explicit_false(legacy.get("is_initial_password")):
        return "initial_or_unclassified"
    if (not explicit_false(legacy.get("is_totp_enabled")) or legacy.get("totp_mode") != "off"
            or legacy.get("totp_secret") not in (None, "")
            or any(legacy.get(key) for key in ("mfa", "enrollment_required", "pending", "locked", "offline"))):
        return "legacy_mfa_or_protected"
    hashed = legacy.get("hashed_password")
    if (not isinstance(hashed, str)
            or not re.fullmatch(r"\$2[aby]\$(0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}", hashed)):
        return "hash_invalid"
    try:
        if bcrypt.checkpw(b"admin", hashed.encode("ascii")):
            return "known_default"
    except (ValueError, TypeError):
        return "hash_invalid"
    return "eligible"


def migrate_legacy_admin(*, confirmed: bool, acknowledge_password_only: bool) -> None:
    """Explicit offline-only migration; never call from startup or an HTTP route.

    Only bcrypt (cost 4..16) and explicitly non-initial, MFA-off legacy records
    are compatible. Older records lacking these flags require operator review;
    do not clear flags merely to make a migration pass. Stop legacy writers
    during migration: CAS protects the new aggregate, not the old users table.
    """
    from fastapi import HTTPException
    from app import db
    from app.admin_security import ACCOUNT_KEY
    from app.security_config import admin_mfa_required
    from app.security_state import compare_and_swap_state, get_state

    if (not confirmed or not acknowledge_password_only or admin_mfa_required()
            or os.getenv("MONSHINMATE_ADMIN_REQUIRE_MFA") != "0"):
        raise ValueError("Migration requires confirmation, password-only acknowledgement and explicit MFA policy 0")
    revision, current = get_state(ACCOUNT_KEY)
    if revision is not None or current is not None:
        raise HTTPException(409, "New account state already exists; migration made no changes")
    legacy = db.get_user_by_username("admin")
    reason = legacy_eligibility(legacy)
    if reason != "eligible":
        raise ValueError(reason)
    hashed = legacy["hashed_password"]
    state = {"version": 1, "password_hash": hashed, "mfa": False, "totp_secret": None,
             "enrollment_required": False, "locked": False, "challenges": {}, "last_totp_step": -1}
    # Never retry against an intervening record, even an empty or locked one.
    if not compare_and_swap_state(ACCOUNT_KEY, None, state):
        raise HTTPException(409, "Account state changed concurrently; migration made no changes")


def _read_sqlite_legacy(path: Path) -> tuple[bool, object]:
    """SELECT-only path; never import app.db or initialize/upgrade a schema."""
    import sqlite3

    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "security_state" in tables:
            exists = connection.execute("SELECT 1 FROM security_state WHERE key=?", ("admin:account:v1",)).fetchone()
            if exists is not None:
                return True, None
        if "users" not in tables:
            return False, None
        columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
        wanted = ("username", "hashed_password", "is_initial_password", "is_totp_enabled", "totp_mode",
                  "totp_secret", "mfa", "enrollment_required", "pending", "locked", "offline")
        selected = [name for name in wanted if name in columns]
        if "username" not in selected:
            return False, {}
        # Identifiers are a fixed allowlist, not operator input.
        rows = connection.execute("SELECT " + ",".join(selected) + " FROM users WHERE username=? LIMIT 2", ("admin",)).fetchall()
        if len(rows) > 1:
            return False, {}  # Ambiguous administrator identity must not be imported.
        return False, dict(rows[0]) if rows else None
    finally:
        connection.close()


def _read_configured_legacy() -> tuple[bool, object]:
    """Use only the configured adapter's read-only preflight hook, never init_db."""
    # Legacy CouchDB module import can auto-create databases. Refuse it before
    # importing the facade; no fallback to SQLite or a mutating getter is safe.
    if os.getenv("COUCHDB_URL"):
        raise RuntimeError("Read-only preflight unsupported")
    from app import db

    reader = getattr(db.get_active_adapter(), "read_legacy_admin_preflight", None)
    if not callable(reader):
        raise RuntimeError("Read-only preflight unsupported")
    result = reader()
    if (not isinstance(result, tuple) or len(result) != 2 or type(result[0]) is not bool):
        raise RuntimeError("Invalid read-only preflight response")
    return result


def preflight_legacy_admin(*, db_path: Path | None = None) -> dict[str, str]:
    """Return only fixed enums; never initialize, write or reserve account state."""
    import contextlib
    import logging

    if os.getenv("MONSHINMATE_ADMIN_REQUIRE_MFA") != "0":
        return {"eligibility": "ineligible", "reason": "policy_not_optional"}
    previous_logging = logging.root.manager.disable
    try:
        # Suppress adapter/library diagnostics, which can contain record values.
        with open(os.devnull, "w", encoding="utf-8") as sink:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                logging.disable(sys.maxsize)
                existing, legacy = _read_sqlite_legacy(db_path) if db_path is not None else _read_configured_legacy()
                reason = "shared_state_exists" if existing else legacy_eligibility(legacy)
        return {"eligibility": "eligible" if reason == "eligible" else "ineligible", "reason": reason}
    except Exception:
        return {"eligibility": "unavailable", "reason": "backend_unavailable"}
    finally:
        logging.disable(previous_logging)


class _ProvisionParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        if sys.argv[1:2] == ["preflight-legacy"]:
            # Even rejected arguments must not echo paths or accidental secrets.
            print('{"eligibility":"ineligible","reason":"invalid_arguments"}')
            raise SystemExit(2)
        super().error(message)


def main() -> None:
    parser = _ProvisionParser(description="Offline admin provisioning or reviewed legacy password-only migration")
    parser.add_argument("kind", choices=("bootstrap", "recovery", "migrate-legacy", "preflight-legacy"))
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--db", type=Path, help="Explicit SQLite database path")
    target.add_argument("--configured-backend", action="store_true", help="Use configured CouchDB/private adapter")
    parser.add_argument("--output", type=Path, help="Bootstrap/recovery credential file (0600; must not exist)")
    parser.add_argument("--acknowledge-password-only", action="store_true",
                        help="Acknowledge reviewed nondefault legacy password reuse without MFA")
    parser.add_argument("--ttl", type=int, default=900, help="Lifetime in seconds (60..3600)")
    parser.add_argument("--confirm", action="store_true", help="Acknowledge immediate revocation/lockout")
    args = parser.parse_args()
    if not args.confirm:
        parser.error("--confirm is required; recovery revokes existing access immediately")
    if args.kind == "migrate-legacy":
        if not args.acknowledge_password_only or os.getenv("MONSHINMATE_ADMIN_REQUIRE_MFA") != "0":
            parser.error("migrate-legacy requires --acknowledge-password-only and MONSHINMATE_ADMIN_REQUIRE_MFA=0")
        if args.output:
            parser.error("migrate-legacy does not generate a credential file; omit --output")
    elif args.kind == "preflight-legacy":
        if args.output:
            parser.error("preflight-legacy never writes a credential file; omit --output")
    elif not args.output:
        parser.error("bootstrap/recovery requires --output")
    if not 60 <= args.ttl <= 3600:
        parser.error("--ttl must be between 60 and 3600")
    if args.db:
        if os.getenv("COUCHDB_URL") or os.getenv("PERSISTENCE_BACKEND", "sqlite") != "sqlite":
            parser.error("--db cannot be combined with a configured remote backend")
        os.environ["MONSHINMATE_DB"] = str(args.db.resolve())
        os.environ["PERSISTENCE_BACKEND"] = "sqlite"
    elif not os.getenv("COUCHDB_URL") and os.getenv("PERSISTENCE_BACKEND", "sqlite") == "sqlite":
        parser.error("For SQLite, explicitly specify --db")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    if args.kind == "preflight-legacy":
        import json
        result = preflight_legacy_admin(db_path=args.db)
        print(json.dumps(result, separators=(",", ":")))
        if result["eligibility"] != "eligible":
            raise SystemExit(1)
        return
    if args.kind == "migrate-legacy":
        try:
            from app.db import init_db
            init_db()
            migrate_legacy_admin(confirmed=args.confirm,
                                 acknowledge_password_only=args.acknowledge_password_only)
        except Exception:
            # Adapter exceptions can contain record values; never print them.
            parser.exit(1, "Migration refused or unavailable; no legacy credentials were printed. "
                        "Existing new/locked/pending accounts cannot be overwritten. "
                        "Review compatibility: explicit non-initial/MFA-off flags, no TOTP secret, "
                        "valid nondefault bcrypt (cost 4..16). Do not clear safety flags.\n")
        print("Legacy administrator migrated; existing password unchanged. No credential file generated.")
        return

    from app.db import init_db
    from app.admin_security import issue_offline_credential

    # Reserve a private new output before making any credential change.
    fd = os.open(str(args.output.resolve()), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        init_db()
        credential = issue_offline_credential(args.kind, args.ttl)
        output.write(credential + "\n")
        output.flush()
        os.fsync(output.fileno())
    print(f"One-time {args.kind} credential written to {args.output}; expires in {args.ttl}s.")
    print("Redeem using /admin/bootstrap or /admin/recovery; MFA enrollment follows unless explicit policy is 0.")


if __name__ == "__main__":
    main()
