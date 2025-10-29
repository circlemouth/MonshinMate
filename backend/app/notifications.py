from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any


class SessionEventBroker:
    """管理画面向けのセッション完了イベントを配信するシンプルなSSEブローカー。"""

    def __init__(self, heartbeat_interval: float = 25.0) -> None:
        self._subscribers: set[asyncio.Queue[bytes]] = set()
        self._lock = asyncio.Lock()
        self._heartbeat_interval = heartbeat_interval
        self._logger = logging.getLogger("session_events")

    async def stream(self) -> AsyncIterator[bytes]:
        """購読ストリームを生成する。クライアント切断時に自動で購読解除する。"""

        queue: asyncio.Queue[bytes] = asyncio.Queue()
        async with self._lock:
            self._subscribers.add(queue)
            self._logger.debug("session_events subscriber added; total=%d", len(self._subscribers))

        try:
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=self._heartbeat_interval)
                except asyncio.TimeoutError:
                    yield b": keep-alive\n\n"
                else:
                    yield message
        finally:
            async with self._lock:
                self._subscribers.discard(queue)
                self._logger.debug("session_events subscriber removed; total=%d", len(self._subscribers))

    async def publish(
        self, event: dict[str, Any], *, event_id: str | None = None, event_name: str = "session.finalized"
    ) -> None:
        """全購読者へイベントを配信する。購読者がいない場合は即座に戻る。"""

        message = self.serialize(event, event_id=event_id, event_name=event_name)
        async with self._lock:
            subscribers = list(self._subscribers)
        if not subscribers:
            self._logger.debug("session_events publish skipped; no subscribers")
            return
        for queue in subscribers:
            await queue.put(message)

    def serialize(
        self, event: dict[str, Any], *, event_id: str | None = None, event_name: str = "session.finalized"
    ) -> bytes:
        """SSE 形式にシリアライズしたイベントを返す。"""

        try:
            payload = json.dumps(event, ensure_ascii=False)
        except Exception:
            payload = "{}"
        lines: list[str] = []
        if event_id:
            lines.append(f"id: {event_id}")
        if event_name:
            lines.append(f"event: {event_name}")
        lines.append(f"data: {payload}")
        lines.append("")  # SSE メッセージの終端
        message = "\n".join(lines).encode("utf-8")
        return message
