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
                remaining_slots = max(0, int(self.session.max_additional_questions) - int(self.session.additional_questions_used))
                if remaining_slots <= 0:
                    return None
                texts = self.llm_gateway.generate_followups(
                    context=self.session.answers,
                    max_questions=remaining_slots,
                    prompt=self.session.followup_prompt,
                    lock_key=getattr(self.session, "id", None),
                )
                self.session.pending_llm_questions = []
                # LLM 追加質問の提示文も保存（永続化用）。
                # セッションに llm_question_texts 辞書がなければ初期化する。
                if not hasattr(self.session, "llm_question_texts") or self.session.llm_question_texts is None:
                    self.session.llm_question_texts = {}
                # すでに発行した llm_* の最大番号を求め、連番が重複しないようにする
                def _extract_num(key: str) -> int:
                    try:
                        return int(key.split("_")[1]) if key.startswith("llm_") else 0
                    except Exception:
                        return 0
                current_max = 0
                try:
                    for k in list(self.session.llm_question_texts.keys()) + list(self.session.answers.keys()):
                        if isinstance(k, str) and k.startswith("llm_"):
                            n = _extract_num(k)
                            if n > current_max:
                                current_max = n
                except Exception:
                    current_max = 0
                for i, t in enumerate(texts):
                    qid = f"llm_{current_max + i + 1}"
                    self.session.pending_llm_questions.append(
                        {
                            "id": qid,
                            "text": t,
                            "expected_input_type": "string",
                            "priority": 1,
                        }
                    )
                    # 表示した質問文をマッピングとして保持
                    self.session.llm_question_texts[qid] = t
            except Exception:
                logging.getLogger("llm").exception("generate_followups_failed")
                self.session.pending_llm_questions = []

        if not self.session.pending_llm_questions:
            return None

        question = self.session.pending_llm_questions.pop(0)
        self.session.additional_questions_used += 1
        return question

    def next_questions(self) -> list[dict[str, Any]]:
        """追加質問をまとめて取得する。

        `next_question` を繰り返し呼び出し、LLM への問い合わせは
        最初の1回で済ませつつ、生成された全ての質問を返す。

        Returns:
            list[dict[str, Any]]: 生成された追加質問のリスト。
        """
        questions: list[dict[str, Any]] = []
        while True:
            q = self.next_question()
            if not q:
                break
            questions.append(q)
        return questions

    def update_completion(self) -> None:
        """外部から明示的に完了状態を更新したい場合に使用。"""
        self._finalize_item()
