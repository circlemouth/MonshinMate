"""Test-only real-flow credentials; never import this from application code."""
from __future__ import annotations

import time
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pyotp


def bootstrap_admin_headers(client) -> dict[str, str]:
    from app import admin_security as auth
    kind = "recovery" if auth.account().get("password_hash") else "bootstrap"
    # Past step avoids consuming the current authenticator step in callers.
    with patch.object(auth, "_now", return_value=int(time.time()) - 90):
        credential = auth.issue_offline_credential(kind)
        response = client.post("/admin/" + kind, json={
            "credential": credential, "new_password": "SyntheticTestPassword123!",
        })
        assert response.status_code == 200, response.text
        headers = {"Authorization": "Bearer " + response.json()["enrollment_token"]}
        setup = client.post("/admin/totp/setup", headers=headers)
        assert setup.status_code == 200, setup.text
        data = setup.json()
        secret = parse_qs(urlparse(data["provisioning_uri"]).query)["secret"][0]
        verify = client.post("/admin/totp/verify", headers=headers, json={
            "enrollment_id": data["enrollment_id"], "totp_code": pyotp.TOTP(secret).at(auth._now()),
        })
        assert verify.status_code == 200, verify.text
    return {"Authorization": "Bearer " + verify.json()["access_token"]}
