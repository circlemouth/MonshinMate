"""LLM ゲートウェイのスタブ実装。"""

from typing import Any
import time
import logging
import json

from pydantic import BaseModel
import httpx


DEFAULT_FOLLOWUP_PROMPT = (
    "上記の回答を踏まえ、追加で確認すべき質問を最大{max_questions}個、"
    "日本語でJSON配列のみで返してください。"
)


class LLMSettings(BaseModel):
    """LLM に関する設定値。"""

    provider: str
    model: str
    temperature: float
    system_prompt: str = ""
    enabled: bool = True
    # リモート接続用設定（任意）。空の場合はスタブ動作を維持する。
    base_url: str | None = None
    api_key: str | None = None


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
        # base_url が指定されていなければ常に OK（ローカル/スタブ運用）。
        s = self.settings
        if not s.enabled:
            # フロントエンドは有効な場合のみこの関数を呼ぶことを想定しているが、
            # 直接APIが呼ばれるケースも考慮し、無効時は疎通NGとする。
            return {"status": "ng", "detail": "llm is disabled"}
        if not s.base_url:
            return {"status": "ng", "detail": "base_url is not configured"}

        try:
            # プロバイダ毎に最小の疎通確認を行う
            timeout = httpx.Timeout(3.0)
            if s.provider == "ollama":
                # /api/tags は軽量で認証不要
                url = s.base_url.rstrip("/") + "/api/tags"
                r = httpx.get(url, timeout=timeout)
                r.raise_for_status()
                return {"status": "ok"}
            else:
                # LM Studio（OpenAI 互換）: /v1/models
                url = s.base_url.rstrip("/") + "/v1/models"
                headers = {}
                if s.api_key:
                    headers["Authorization"] = f"Bearer {s.api_key}"
                r = httpx.get(url, headers=headers, timeout=timeout)
                r.raise_for_status()
                return {"status": "ok"}
        except Exception as e:  # noqa: BLE001 - 疎通失敗は詳細を返す
            return {"status": "ng", "detail": str(e)}

    def list_models(self) -> list[str]:
        """利用可能なモデル名の一覧を返す。

        Returns:
            list[str]: モデル名のリスト。
        """
        s = self.settings
        if not s.enabled or not s.base_url:
            return []

        try:
            timeout = httpx.Timeout(5.0)
            if s.provider == "ollama":
                url = s.base_url.rstrip("/") + "/api/tags"
                r = httpx.get(url, timeout=timeout)
                r.raise_for_status()
                data = r.json()
                # "models" キーの中の "name" を抽出
                return sorted([m.get("name") for m in data.get("models", []) if m.get("name")])
            else:  # LM Studio or other OpenAI compatible
                url = s.base_url.rstrip("/") + "/v1/models"
                headers = {}
                if s.api_key:
                    headers["Authorization"] = f"Bearer {s.api_key}"
                r = httpx.get(url, headers=headers, timeout=timeout)
                r.raise_for_status()
                data = r.json()
                # "data" キーの中の "id" を抽出
                return sorted([m.get("id") for m in data.get("data", []) if m.get("id")])
        except Exception as e:
            logging.getLogger("llm").error(f"Failed to list models: {e}")
            return []

    def generate_question(
        self,
        missing_item_id: str,
        missing_item_label: str,
        context: dict[str, Any] | None = None,
    ) -> str:
        """不足項目に対する追質問文を生成する。

        リモート LLM が有効かつ接続設定がある場合は HTTP 経由で生成を試み、
        失敗した場合は例外を送出する。例外は呼び出し側で捕捉し、
        LLM を用いないフォールバック処理へ委ねる。

        Args:
            missing_item_id: 不足している項目ID。
            missing_item_label: 当該項目の表示ラベル。
            context: 既知の回答（任意）。

        Returns:
            str: 追質問の本文。
        """
        start = time.perf_counter()
        s = self.settings
        if s.enabled and s.base_url:
            try:
                timeout = httpx.Timeout(15.0)
                if s.provider == "ollama":
                    url = s.base_url.rstrip("/") + "/api/chat"
                    messages = []
                    if s.system_prompt:
                        messages.append({"role": "system", "content": s.system_prompt})
                    messages.append(
                        {
                            "role": "user",
                            "content": f"{missing_item_label}について詳しく教えてください。",
                        }
                    )
                    payload: dict[str, Any] = {
                        "model": s.model,
                        "messages": messages,
                        "stream": False,
                        "options": {"temperature": s.temperature},
                    }
                    r = httpx.post(url, json=payload, timeout=timeout)
                    r.raise_for_status()
                    data = r.json()
                    content = (
                        (data.get("message") or {}).get("content")
                        or data.get("response")
                        or ""
                    )
                    if content:
                        duration = (time.perf_counter() - start) * 1000
                        logging.getLogger("llm").info(
                            "generate_question(remote) item=%s took_ms=%.1f",
                            missing_item_id,
                            duration,
                        )
                        return content
                    raise RuntimeError("empty response from ollama")
                else:
                    url = s.base_url.rstrip("/") + "/v1/chat/completions"
                    headers = {"Content-Type": "application/json"}
                    if s.api_key:
                        headers["Authorization"] = f"Bearer {s.api_key}"
                    messages = []
                    if s.system_prompt:
                        messages.append({"role": "system", "content": s.system_prompt})
                    messages.append(
                        {
                            "role": "user",
                            "content": f"{missing_item_label}について詳しく教えてください。",
                        }
                    )
                    payload = {
                        "model": s.model,
                        "messages": messages,
                        "temperature": s.temperature,
                        "stream": False,
                    }
                    r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
                    r.raise_for_status()
                    data = r.json()
                    choices = data.get("choices") or []
                    if choices:
                        msg = choices[0].get("message") or {}
                        content = msg.get("content") or ""
                        if content:
                            duration = (time.perf_counter() - start) * 1000
                            logging.getLogger("llm").info(
                                "generate_question(remote) item=%s took_ms=%.1f",
                                missing_item_id,
                                duration,
                            )
                            return content
                    raise RuntimeError("empty response from lm studio")
            except Exception as e:  # noqa: BLE001 - 呼び出し側でフォールバック
                logging.getLogger("llm").exception(
                    "remote_generate_question_failed: %s", e
                )
                raise

        # ---- フォールバック（ローカルスタブ） ----
        suffix = ""
        if context:
            keys = ", ".join(list(context.keys())[:3])
            if keys:
                suffix = f"（参考: 入力済み項目={keys}）"
        result = f"追加質問: {missing_item_label} について詳しく教えてください。{suffix}".strip()
        duration = (time.perf_counter() - start) * 1000
        logging.getLogger("llm").info(
            "generate_question item=%s took_ms=%.1f", missing_item_id, duration
        )
        return result

    def generate_followups(
        self, context: dict[str, Any], max_questions: int, prompt: str | None = None
    ) -> list[str]:
        """ユーザー回答全体を基に追加質問を生成する。"""
        s = self.settings
        if not s.enabled:
            return []
        user_prompt = (prompt or DEFAULT_FOLLOWUP_PROMPT).replace(
            "{max_questions}", str(max_questions)
        )
        if s.base_url:
            try:
                timeout = httpx.Timeout(15.0)
                url = s.base_url.rstrip("/") + "/v1/chat/completions"
                headers = {"Content-Type": "application/json"}
                if s.api_key:
                    headers["Authorization"] = f"Bearer {s.api_key}"
                messages = []
                if s.system_prompt:
                    messages.append({"role": "system", "content": s.system_prompt})
                messages.append({"role": "user", "content": f"{context}\n{user_prompt}"})
                payload = {
                    "model": s.model,
                    "messages": messages,
                    "temperature": s.temperature,
                    "stream": False,
                }
                r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
                r.raise_for_status()
                data = r.json()
                choices = data.get("choices") or []
                if choices:
                    content = choices[0].get("message", {}).get("content", "")
                    arr = json.loads(content)
                    if isinstance(arr, list):
                        return [str(x) for x in arr][:max_questions]
                raise RuntimeError("invalid response")
            except Exception as e:  # noqa: BLE001
                logging.getLogger("llm").exception(
                    "generate_followups_failed: %s", e
                )
                raise
        # スタブ実装：固定的な質問を返す
        return [f"追加質問{idx + 1}" for idx in range(max_questions)]

    def chat(self, message: str) -> str:
        """チャット形式での応答を模擬的に返す。"""
        start = time.perf_counter()
        s = self.settings
        # リモート設定が有効な場合は HTTP 経由で実行し、失敗時はスタブへフォールバック
        if s.enabled and s.base_url:
            try:
                reply = self._chat_remote(message)
                duration = (time.perf_counter() - start) * 1000
                logging.getLogger("llm").info("chat(remote) took_ms=%.1f", duration)
                return reply
            except Exception:
                logging.getLogger("llm").exception("remote_chat_failed; falling back to stub")

        # フォールバック（スタブ）
        result = f"LLM応答[{s.provider}:{s.model},temp={s.temperature}] {message}"
        duration = (time.perf_counter() - start) * 1000
        logging.getLogger("llm").info("chat(stub) took_ms=%.1f", duration)
        return result

    def _chat_remote(self, message: str) -> str:
        """リモート LLM へチャットリクエストを送信する。

        provider に応じて Ollama または OpenAI 互換（LM Studio）を呼び分ける。
        エラー時は例外を送出する（呼び出し側でフォールバック）。
        """
        s = self.settings
        assert s.base_url, "base_url is required for remote chat"
        timeout = httpx.Timeout(15.0)
        if s.provider == "ollama":
            # Ollama Chat API
            url = s.base_url.rstrip("/") + "/api/chat"
            messages = []
            if s.system_prompt:
                messages.append({"role": "system", "content": s.system_prompt})
            messages.append({"role": "user", "content": message})
            payload: dict[str, Any] = {
                "model": s.model,
                "messages": messages,
                "stream": False,
                "options": {"temperature": s.temperature},
            }
            r = httpx.post(url, json=payload, timeout=timeout)
            r.raise_for_status()
            data = r.json()
            # Ollama の応答は data["message"]["content"] に入る
            content = (
                (data.get("message") or {}).get("content")
                or data.get("response")  # generate API 互換の可能性も考慮
                or ""
            )
            if not content:
                raise RuntimeError("empty response from ollama")
            return content
        else:
            # LM Studio (OpenAI 互換) Chat Completions API
            url = s.base_url.rstrip("/") + "/v1/chat/completions"
            headers = {"Content-Type": "application/json"}
            if s.api_key:
                headers["Authorization"] = f"Bearer {s.api_key}"
            messages = []
            if s.system_prompt:
                messages.append({"role": "system", "content": s.system_prompt})
            messages.append({"role": "user", "content": message})
            payload = {
                "model": s.model,
                "messages": messages,
                "temperature": s.temperature,
                "stream": False,
            }
            r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
            r.raise_for_status()
            data = r.json()
            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError("no choices in response")
            msg = choices[0].get("message") or {}
            content = msg.get("content") or ""
            if not content:
                raise RuntimeError("empty content in choice")
            return content

    def summarize(self, answers: dict[str, Any]) -> str:
        """回答内容を簡易に要約した文字列を返す。

        Args:
            answers: 質問項目IDをキーとした回答の辞書。

        Returns:
            str: 連結された回答を含む要約文字列。
        """
        start = time.perf_counter()
        # 重要項目を先頭に並べ、読める要約に整形する簡易版。
        order = ["chief_complaint", "onset"] + [k for k in answers.keys() if k not in {"chief_complaint", "onset"}]
        parts = []
        for k in order:
            if k in answers:
                parts.append(f"{k}:{answers[k]}")
        summary_items = ", ".join(parts)
        result = f"要約: {summary_items}"
        duration = (time.perf_counter() - start) * 1000
        logging.getLogger("llm").info("summarize took_ms=%.1f", duration)
        return result

    # --- カスタムプロンプトを用いたサマリー生成（可能ならリモート） ---
    def summarize_with_prompt(
        self,
        system_prompt: str,
        answers: dict[str, Any],
        labels: dict[str, str] | None = None,
    ) -> str:
        """カスタムのシステムプロンプトと問診回答を用いてサマリーを生成する。

        リモート設定が有効かつ base_url がある場合はリモート LLM に投げ、
        失敗時はスタブ的な要約にフォールバックする。
        """
        try:
            s = self.settings
            # 質問と回答のペアを整形
            lines: list[str] = []
            for k, v in answers.items():
                label = labels.get(k) if labels else k
                lines.append(f"- {label}: {v}")
            pairs_text = "\n".join(lines)

            # リモート可能なら OpenAI/Ollama 互換のチャットで生成
            if s.enabled and s.base_url:
                timeout = httpx.Timeout(20.0)
                if s.provider == "ollama":
                    url = s.base_url.rstrip("/") + "/api/chat"
                    messages = []
                    if system_prompt:
                        messages.append({"role": "system", "content": system_prompt})
                    messages.append({
                        "role": "user",
                        "content": f"以下の問診回答を要約してください。\n{pairs_text}",
                    })
                    payload: dict[str, Any] = {
                        "model": s.model,
                        "messages": messages,
                        "stream": False,
                        "options": {"temperature": s.temperature},
                    }
                    r = httpx.post(url, json=payload, timeout=timeout)
                    r.raise_for_status()
                    data = r.json()
                    content = (
                        (data.get("message") or {}).get("content")
                        or data.get("response")
                        or ""
                    )
                    if content:
                        return content
                else:
                    url = s.base_url.rstrip("/") + "/v1/chat/completions"
                    headers = {"Content-Type": "application/json"}
                    if s.api_key:
                        headers["Authorization"] = f"Bearer {s.api_key}"
                    messages = []
                    if system_prompt:
                        messages.append({"role": "system", "content": system_prompt})
                    messages.append({
                        "role": "user",
                        "content": f"以下の問診回答を要約してください。\n{pairs_text}",
                    })
                    payload = {
                        "model": s.model,
                        "messages": messages,
                        "temperature": s.temperature,
                        "stream": False,
                    }
                    r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
                    r.raise_for_status()
                    data = r.json()
                    choices = data.get("choices") or []
                    if choices:
                        msg = choices[0].get("message") or {}
                        content = msg.get("content") or ""
                        if content:
                            return content
        except Exception as e:  # noqa: BLE001 - フォールバックへ
            logging.getLogger("llm").exception("summarize_with_prompt failed: %s", e)

        # フォールバック（スタブ要約）
        return self.summarize(answers)
