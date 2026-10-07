"""Dependency-free maintenance ASGI entry point; never import the application.

Run with uvicorn app.maintenance:app. Only GET/HEAD /healthz is healthy;
all other HTTP requests are rejected without reading their bodies or state.
"""
from __future__ import annotations


async def app(scope, receive, send) -> None:
    kind = scope["type"]
    if kind == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    elif kind == "websocket":
        await send({"type": "websocket.close", "code": 1013})
    elif kind == "http":
        healthy = scope.get("path") == "/healthz" and scope.get("method") in {"GET", "HEAD"}
        body = b'{"status":"maintenance"}' if healthy else b'{"detail":"Service temporarily unavailable for maintenance"}'
        headers = [(b"content-type", b"application/json"), (b"cache-control", b"no-store"),
                   (b"content-length", str(len(body)).encode("ascii")),
                   (b"x-content-type-options", b"nosniff")]
        if not healthy:
            headers.append((b"retry-after", b"300"))
        await send({"type": "http.response.start", "status": 200 if healthy else 503, "headers": headers})
        await send({"type": "http.response.body", "body": b"" if scope.get("method") == "HEAD" else body})
