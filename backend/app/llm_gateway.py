"""LLM ゲートウェイのスタブ実装。"""

from typing import Any

from pydantic import BaseModel


class LLMSettings(BaseModel):
    """LLM に関する設定値。"""

    provider: str
    model: str
    temperature: float
    system_prompt: str = ""


class LLMGateway:
    """ローカル LLM への簡易インターフェース。

    現段階ではスタブ実装として、固定的/組み立て応答のみを返す。
    """

    def __init__(self, settings: LLMSettings) -> None:
        self.settings = settings

    def update_settings(self, settings: LLMSettings) -> None:
        """設定値を更新する。"""
        self.settings = settings

    def test_connection(self) -> dict[str, str]:
        """LLM 接続の疎通確認（スタブ）。

        Returns:
            dict[str, str]: ステータスを示す辞書。
        """
        # 本来は HTTP 経由でモデルへ疎通確認を行う。ここでは常に成功を返す。
        return {"status": "ok"}

    def generate_question(
        self,
        missing_item_id: str,
        missing_item_label: str,
        context: dict[str, Any] | None = None,
    ) -> str:
        """不足項目に対する追質問文を生成する（スタブ）。

        Args:
            missing_item_id: 不足している項目ID。
            missing_item_label: 当該項目の表示ラベル。
            context: 既知の回答（任意）。

        Returns:
            str: 追質問の本文。
        """
        suffix = ""
        if context:
            # 簡易に既知情報の要約を1行付与（トークンスピル抑制のため最小限）。
            keys = ", ".join(list(context.keys())[:3])
            if keys:
                suffix = f"（参考: 入力済み項目={keys}）"
        return f"追加質問: {missing_item_label} について詳しく教えてください。{suffix}".strip()

    def chat(self, message: str) -> str:
        """チャット形式での応答を模擬的に返す。"""
        s = self.settings
        return f"LLM応答[{s.provider}:{s.model},temp={s.temperature}] {message}"

    def summarize(self, answers: dict[str, Any]) -> str:
        """回答内容を簡易に要約した文字列を返す。

        Args:
            answers: 質問項目IDをキーとした回答の辞書。

        Returns:
            str: 連結された回答を含む要約文字列。
        """
        # 重要項目を先頭に並べ、読める要約に整形する簡易版。
        order = ["chief_complaint", "onset"] + [k for k in answers.keys() if k not in {"chief_complaint", "onset"}]
        parts = []
        for k in order:
            if k in answers:
                parts.append(f"{k}:{answers[k]}")
        summary_items = ", ".join(parts)
        return f"要約: {summary_items}"
