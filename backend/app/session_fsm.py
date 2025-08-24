"""セッションの状態遷移を扱う簡易状態機械。"""
from __future__ import annotations

from typing import Any
import logging

from .validator import Validator
from .structured_context import StructuredContextManager


class SessionFSM:
    """回答保存と追加質問の管理を行う。"""

    def __init__(self, session: Any, llm_gateway: Any) -> None:
        self.session = session
        self.llm_gateway = llm_gateway

    # ---- 回答処理 ----
    def step(self, item_id: str, answer: Any) -> None:
        """回答を検証・保存し状態を更新する。"""
        Validator.validate_partial(self.session.template_items, {item_id: answer})
        StructuredContextManager.update_structured_context(self.session, item_id, answer)
        self._finalize_item()

    def _finalize_item(self) -> None:
        remaining = Validator.missing_required(
            self.session.template_items, self.session.answers
        )
        self.session.remaining_items = remaining
        self.session.completion_status = (
            "complete" if not remaining else "in_progress"
        )

    # ---- 追加質問 ----
    def next_question(self) -> dict[str, Any] | None:
        """次に提示すべき追加質問を返す。"""
        if not getattr(self.llm_gateway.settings, "enabled", True):
            return None
        if self.session.additional_questions_used >= self.session.max_additional_questions:
            return None

        if not self.session.pending_llm_questions:
            try:
                texts = self.llm_gateway.generate_followups(
                    context=self.session.answers,
                    max_questions=self.session.max_additional_questions,
                    prompt=self.session.followup_prompt,
                )
                self.session.pending_llm_questions = [
                    {
                        "id": f"llm_{i + 1}",
                        "text": t,
                        "expected_input_type": "string",
                        "priority": 1,
                    }
                    for i, t in enumerate(texts)
                ]
            except Exception:
                logging.getLogger("llm").exception("generate_followups_failed")
                self.session.pending_llm_questions = []

        if not self.session.pending_llm_questions:
            return None

        question = self.session.pending_llm_questions.pop(0)
        self.session.additional_questions_used += 1
        return question

    def update_completion(self) -> None:
        """外部から明示的に完了状態を更新したい場合に使用。"""
        self._finalize_item()
