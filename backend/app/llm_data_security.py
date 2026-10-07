"""Destination policy and defense-in-depth minimization for LLM traffic."""
from __future__ import annotations

import ipaddress
import os
import re
import socket
from typing import Any
from urllib.parse import urlsplit

# Deployment-controlled exact origins; this cannot be changed through LLM settings.
DEFAULT_ORIGINS = frozenset({"https://api.openai.com"})
IDENTITY_KEYS = frozenset({
    "personalinfo", "patientbasicinfo", "contactupdate", "patientname", "name", "fullname",
    "firstname", "lastname", "namekana", "kana", "dob", "dateofbirth", "birthday",
    "address", "postalcode", "zipcode", "phone", "phonenumber", "telephone", "email",
    "gender", "sex", "patientid", "sessionid", "id", "token", "capability", "authorization",
})


def minimize_answers(value: dict[str, Any]) -> dict[str, Any]:
    """Callers MUST first allowlist template/issued question IDs.

    This scrubber does not infer which arbitrary custom IDs are clinical and
    cannot remove identifying text embedded in otherwise clinical free text.
    """
    def clean(node: Any) -> Any:
        if isinstance(node, dict):
            return {k: clean(v) for k, v in node.items()
                    if isinstance(k, str) and re.sub(r"[^a-z0-9]", "", k.lower()) not in IDENTITY_KEYS}
        if isinstance(node, list):
            return [clean(v) for v in node]
        return node
    return clean(value)


def validate_destination(url: str, *, resolve: bool = True) -> None:
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("llm_destination_not_allowed") from exc
    if (not host or parsed.username is not None or parsed.password is not None or
            parsed.query or parsed.fragment or "\\" in url or any(ord(c) < 33 for c in url)):
        raise ValueError("llm_destination_not_allowed")
    local = (os.getenv("MONSHINMATE_ENV", "").lower() == "local" and
             os.getenv("MONSHINMATE_ALLOW_LOCAL_LLM", "") == "1")
    if local and parsed.scheme in {"http", "https"} and host in {"localhost", "127.0.0.1", "::1"}:
        return
    origin = f"{parsed.scheme}://{host}" + (f":{port}" if port is not None and port != 443 else "")
    allowed = DEFAULT_ORIGINS | frozenset(x.strip().rstrip("/") for x in os.getenv("MONSHINMATE_LLM_ALLOWED_ORIGINS", "").split(",") if x.strip())
    if parsed.scheme != "https" or origin not in allowed or host in {"metadata.google.internal", "metadata"}:
        raise ValueError("llm_destination_not_allowed")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None and not literal.is_global:
        raise ValueError("llm_destination_not_allowed")
    if resolve:
        try:
            addresses = socket.getaddrinfo(host, port or 443, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise ValueError("llm_destination_unavailable") from exc
        if not addresses or any(not ipaddress.ip_address(entry[4][0]).is_global for entry in addresses):
            raise ValueError("llm_destination_not_allowed")


def validate_profile_destination(provider: str, profile: dict[str, Any], *, resolve: bool = False) -> None:
    if provider == "gcp_vertex":
        # Vertex's built-in adapter constructs the host and URL path from these.
        location = profile.get("location") or "global"
        project = profile.get("project_id") or ""
        model = profile.get("model") or ""
        if not isinstance(location, str) or not re.fullmatch(r"(?:global|us|eu|[a-z]+-[a-z]+[0-9])", location):
            raise ValueError("llm_destination_not_allowed")
        if not isinstance(project, str) or not re.fullmatch(r"[a-z][a-z0-9-]{3,62}", project):
            raise ValueError("llm_destination_not_allowed")
        if not isinstance(model, str) or not re.fullmatch(r"(?:publishers/google/models/)?[A-Za-z0-9_.-]+", model):
            raise ValueError("llm_destination_not_allowed")
        return
    if provider not in {"ollama", "lm_studio", "openai"}:
        raise ValueError("llm_provider_not_allowed")
    url = profile.get("base_url")
    if not isinstance(url, str) or not url:
        raise ValueError("llm_destination_not_allowed")
    validate_destination(url, resolve=resolve)
