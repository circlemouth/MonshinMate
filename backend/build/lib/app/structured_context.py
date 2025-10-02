"""回答に基づいてセッションの構造化コンテキストを更新するユーティリティ。"""
from __future__ import annotations

from typing import Any


class StructuredContextManager:
    """最小実装としてセッションの回答辞書を更新する。"""

    @staticmethod
    def normalize_answer(answer: Any) -> Any:
        """空欄の回答を「該当なし」に正規化する。"""
        if answer is None:
            return "該当なし"
        if isinstance(answer, str) and not answer.strip():
            return "該当なし"
        if isinstance(answer, list) and not answer:
            return ["該当なし"]
        return answer

    @staticmethod
    def update_structured_context(session: Any, item_id: str, answer: Any) -> None:
        """セッション内の回答を更新する。"""
        session.answers[item_id] = StructuredContextManager.normalize_answer(answer)
