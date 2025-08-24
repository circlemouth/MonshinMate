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

        next_item_id: str | None = None
        next_item_label: str | None = None
        if "onset" not in self.session.answers:
            next_item_id = "onset"
            next_item_label = "発症時期"
        elif "chief_complaint" not in self.session.answers:
            next_item_id = "chief_complaint"
            next_item_label = "主訴"

        if next_item_id is not None:
            count = self.session.attempt_counts.get(next_item_id, 0)
            if count >= 3:
                next_item_id = None

        if next_item_id is None:
            self.session.additional_questions_used += 1
            return {
                "id": "followup",
                "text": "追加質問: 他に伝えておきたいことはありますか？",
                "expected_input_type": "string",
                "priority": 1,
            }

        self.session.attempt_counts[next_item_id] = (
            self.session.attempt_counts.get(next_item_id, 0) + 1
        )
        try:
            text = self.llm_gateway.generate_question(
                missing_item_id=next_item_id,
                missing_item_label=next_item_label,
                context=self.session.answers,
            )
        except Exception:
            # 通信エラー等で生成に失敗した場合は追質問をスキップする
            logging.getLogger("llm").exception("generate_question_failed")
            return None

        self.session.additional_questions_used += 1
        return {
            "id": next_item_id,
            "text": text,
            "expected_input_type": "string",
            "priority": 1,
        }

    def update_completion(self) -> None:
        """外部から明示的に完了状態を更新したい場合に使用。"""
        self._finalize_item()
