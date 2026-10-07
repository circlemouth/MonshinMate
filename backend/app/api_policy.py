"""Default-deny API policy and bounded request bodies, independent of the UI."""
from __future__ import annotations

from typing import Any, Callable

from fastapi import Depends
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from .patient_security import require_patient_session, limit_session_creation

PUBLIC_GET = frozenset({
    "/", "/health", "/healthz", "/readyz",
    "/questionnaires", "/questionnaires/{questionnaire_id}/template",
    "/questionnaire-item-images/files/{filename}", "/system-logo/files/{filename}",
    "/postal-code/{postal_code}", "/system/bootstrap", "/system/timezone",
    "/system/display-name", "/system/completion-message", "/system/entry-message",
    "/system/theme-color", "/system/logo", "/system/default-questionnaire",
    "/system/llm-availability",
})
# These routes perform purpose-specific authentication in the handler. Keep this
# list exact: prefix exemptions would reintroduce unauthenticated admin routes.
AUTH_PROCEDURES = frozenset({
    ("GET", "/admin/auth/status"),
    ("POST", "/admin/login"), ("POST", "/admin/login/totp"),
    ("POST", "/admin/bootstrap"), ("POST", "/admin/recovery"),
    ("POST", "/admin/totp/setup"), ("POST", "/admin/totp/verify"),
    ("GET", "/admin/totp/setup"),
    ("POST", "/admin/totp/regenerate"), ("PUT", "/admin/totp/mode"),
    ("POST", "/admin/password"),
    ("POST", "/admin/password/reset/request"),
    ("POST", "/admin/password/reset/confirm"),
    ("POST", "/admin/password/reset/emergency"),
})
INTEGRATION_ROUTES = frozenset({"/patient-summary", "/patient-summaries", "/patient-summary/pdf"})
PATIENT_ROUTES = frozenset({
    "/sessions/{session_id}/answers", "/sessions/{session_id}/llm-answers",
    "/sessions/{session_id}/llm-answers/batch", "/sessions/{session_id}/llm-questions",
    "/sessions/{session_id}/finalize",
})


def route_policy(path: str, method: str) -> str:
    if method == "GET" and path in PUBLIC_GET:
        return "public"
    if (method, path) in AUTH_PROCEDURES:
        return "authentication"
    if method == "POST" and path in INTEGRATION_ROUTES:
        return "integration"
    if method == "POST" and path == "/sessions":
        return "patient-create"
    if method == "POST" and path in PATIENT_ROUTES:
        return "patient"
    return "admin"


def protected_route_class(require_admin: Callable[..., Any]) -> type[APIRoute]:
    class ProtectedRoute(APIRoute):
        def __init__(self, path: str, endpoint: Callable[..., Any], **kwargs: Any):
            methods = set(kwargs.get("methods") or {"GET"})
            policies = {route_policy(path, method) for method in methods}
            dependencies = list(kwargs.pop("dependencies", None) or [])
            # A mixed-policy route must use separate registrations, not weaken
            # authorization for its more privileged method.
            if "admin" in policies or len(policies) != 1:
                dependencies.insert(0, Depends(require_admin))
            elif "patient" in policies:
                dependencies.insert(0, Depends(require_patient_session))
            elif "patient-create" in policies:
                dependencies.insert(0, Depends(limit_session_creation))
            super().__init__(path, endpoint, dependencies=dependencies, **kwargs)
            self.security_policy = next(iter(policies)) if len(policies) == 1 else "admin"
    return ProtectedRoute


class RequestBoundaryMiddleware:
    """Read bounded data before parsing multipart/JSON, including chunked input."""
    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        async def secure_send(message: dict):
            if message["type"] == "http.response.start":
                replaced = {b"cache-control", b"x-content-type-options", b"referrer-policy", b"x-frame-options"}
                output = [(k, v) for k, v in message.get("headers", []) if k.lower() not in replaced]
                output.extend([(b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff"),
                               (b"referrer-policy", b"no-referrer"), (b"x-frame-options", b"DENY")])
                message = {**message, "headers": output}
            await send(message)

        path = scope.get("path", "")
        limit = 256 * 1024
        if path in {"/admin/sessions/import", "/admin/questionnaires/import"}:
            limit = 5 * 1024 * 1024 + 64 * 1024  # bounded multipart overhead
        elif path in {"/system-logo", "/questionnaire-item-images"}:
            limit = 512 * 1024 + 64 * 1024
        headers = dict(scope.get("headers", []))
        try:
            length = int(headers.get(b"content-length", b"0"))
            if length < 0:
                raise ValueError
        except ValueError:
            await JSONResponse({"detail": "invalid content length"}, 400)(scope, receive, secure_send)
            return
        if length > limit:
            await JSONResponse({"detail": "request too large"}, 413)(scope, receive, secure_send)
            return
        chunks = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            size += len(body)
            if size > limit:
                await JSONResponse({"detail": "request too large"}, 413)(scope, receive, secure_send)
                return
            chunks.append(body)
            if not message.get("more_body", False):
                break
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, secure_send)
