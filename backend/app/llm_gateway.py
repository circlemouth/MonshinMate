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
    """ローカル LLM への簡易インターフェース。"""

    def __init__(self, settings: LLMSettings) -> None:
        self.settings = settings

    def update_settings(self, settings: LLMSettings) -> None:
        """設定値を更新する。"""
        self.settings = settings

    def generate_question(self, context: dict[str, Any]) -> str:
        """スタブとして固定文言を返す。"""
        return "追加質問は現在未実装です"

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
        summary_items = ", ".join(f"{k}:{v}" for k, v in answers.items())
        return f"要約: {summary_items}"
