#!/usr/bin/env python3
"""Retired: direct users-table password resets cannot restore admin access."""

if __name__ == "__main__":
    raise SystemExit(
        "Direct password reset is retired. Use provision_admin.py recovery "
        "--db /explicit/database/path --output /private/new-file --confirm, "
        "redeem the one-time credential at /admin/recovery, then enroll MFA."
    )
