"""回答に基づいてセッションの構造化コンテキストを更新するユーティリティ。"""
from __future__ import annotations

from typing import Any


class StructuredContextManager:
    """最小実装としてセッションの回答辞書を更新する。"""

    @staticmethod
    def update_structured_context(session: Any, item_id: str, answer: Any) -> None:
        """セッション内の回答を更新する。"""
        session.answers[item_id] = answer
