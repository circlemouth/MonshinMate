"""LLM ゲートウェイのスタブ実装。"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
import time
import logging
import json
import threading

from pydantic import BaseModel, Field
import httpx


DEFAULT_SYSTEM_PROMPT = (
    "あなたは日本語で応答する熟練した医療問診支援AIです。"
    "患者の入力を理解し、医学的に適切で簡潔な回答や質問を行ってください。"
    "不要な前置きや断り書きは避け、常に敬体で表現してください。"
)

DEFAULT_FOLLOWUP_PROMPT = (
    "上記の患者回答を踏まえ、診療に必要な追加確認事項を最大{max_questions}個生成してください。"
    "各質問は丁寧な日本語の文章で記述し、文字列のみを要素とするJSON配列として返してください。"
)


LlmStatusValue = Literal["ok", "ng", "disabled", "pending"]


class ProviderProfile(BaseModel):
    """プロバイダ単位の設定（LLM有効状態はトップレベルで管理）。"""

    model: str = ""
    temperature: float = 0.2
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    base_url: str | None = None
    api_key: str | None = None

    class Config:
        extra = "ignore"


class LLMSettings(BaseModel):
    """LLM に関する設定値。"""

    provider: str
    model: str
    temperature: float
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    enabled: bool = True
    # リモート接続用設定（任意）。空の場合はスタブ動作を維持する。
    base_url: str | None = None
    api_key: str | None = None
    provider_profiles: dict[str, ProviderProfile] = Field(default_factory=dict)

    def get_profile(self, provider: str | None = None) -> ProviderProfile:
        """指定されたプロバイダの設定を取得（存在しない場合は生成）."""

        key = provider or self.provider
        profiles = self.provider_profiles or {}
        profile = profiles.get(key)
        if profile is None:
            profile = ProviderProfile()
            # 現在のアクティブプロバイダの場合はトップレベル値を反映
            if key == self.provider:
                profile = ProviderProfile(
                    model=self.model,
                    temperature=self.temperature,
                    system_prompt=self.system_prompt,
                    base_url=self.base_url,
                    api_key=self.api_key,
                )
            profiles = dict(profiles)
            profiles[key] = profile
            self.provider_profiles = profiles
        return profile

    def sync_from_active_profile(self) -> None:
        """アクティブプロバイダの設定をトップレベルへ反映。"""

        profile = self.get_profile(self.provider)
        self.model = profile.model or ""
        # 温度は 0〜2 の範囲に丸める
        temp = profile.temperature if profile.temperature is not None else 0.2
        self.temperature = max(0.0, min(2.0, float(temp)))
        self.system_prompt = profile.system_prompt or ""
        self.base_url = profile.base_url
        self.api_key = profile.api_key

    def sync_to_active_profile(self) -> None:
        """トップレベルの値をアクティブプロバイダ設定へ書き戻す。"""

        profile = ProviderProfile(
            model=self.model or "",
            temperature=max(0.0, min(2.0, float(self.temperature if self.temperature is not None else 0.2))),
            system_prompt=self.system_prompt or "",
            base_url=self.base_url,
            api_key=self.api_key,
        )
        profiles = dict(self.provider_profiles or {})
        profiles[self.provider] = profile
        self.provider_profiles = profiles


class LLMGateway:
    """ローカル LLM への簡易インターフェース。

    現段階ではスタブ実装として、固定的/組み立て応答のみを返す。
    """

    def __init__(self, settings: LLMSettings) -> None:
        # 受け取った設定を正規化して保持
        settings.sync_from_active_profile()
        settings.sync_to_active_profile()
        self.settings = settings
        # セッション単位での直列化用ロック
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        self._status_lock = threading.Lock()
        self._last_status: dict[str, Any] = {
            "status": "disabled",
            "detail": "not_checked",
            "source": "init",
            "checked_at": None,
        }
        self._sync_status_for_settings(reason="init")

    def _get_lock(self, key: str | None) -> threading.RLock | None:
        if not key:
            return None
        # RLock を使い再入可能に（同一スレッド内の入れ子を許容）
        lock = self._locks.get(key)
        if lock is None:
            # 競合を避けるために辞書更新時はガード
            with self._locks_guard:
                lock = self._locks.get(key)
                if lock is None:
                    self._locks[key] = threading.RLock()
                    lock = self._locks[key]
        return lock

    def _set_status(
        self,
        status: LlmStatusValue,
        detail: str | None,
        source: str,
        *,
        mark_time: bool,
    ) -> None:
        with self._status_lock:
            previous = getattr(self, "_last_status", {}) or {}
            checked_at = (
                datetime.now(timezone.utc)
                if mark_time
                else previous.get("checked_at")
            )
            self._last_status = {
                "status": status,
                "detail": detail,
                "source": source,
                "checked_at": checked_at,
            }

    def _record_status(
        self, status: LlmStatusValue, source: str, detail: str | None = None
    ) -> None:
        self._set_status(status, detail, source, mark_time=True)

    def _sync_status_for_settings(self, *, reason: str) -> None:
        s = self.settings
        if not s.enabled:
            self._set_status("disabled", "llm disabled", reason, mark_time=False)
            return
        if not s.base_url or not s.model:
            self._set_status(
                "disabled",
                "connection settings incomplete",
                reason,
                mark_time=False,
            )
            return
        with self._status_lock:
            current = (self._last_status or {}).get("status")
        if current not in {"ok", "ng"}:
            self._set_status("pending", "awaiting_check", reason, mark_time=False)

    def sync_status(self, *, reason: str = "sync") -> None:
        """現在の設定に基づいてステータスを整合させる。"""

        self._sync_status_for_settings(reason=reason)

    def get_status_snapshot(self) -> dict[str, Any]:
        """直近の LLM 通信状態を取得する。"""

        with self._status_lock:
            return dict(self._last_status)

    def update_settings(self, settings: LLMSettings) -> None:
        """設定値を更新する。"""

        settings.sync_from_active_profile()
        settings.sync_to_active_profile()
        self.settings = settings
        self._sync_status_for_settings(reason="settings_update")

    def test_connection(self, *, source: str = "manual_test") -> dict[str, str]:
        """LLM 接続の疎通確認（スタブ）。

        Returns:
            dict[str, str]: ステータスを示す辞書。
        """
        s = self.settings
        if not s.enabled:
            # 無効時は疎通NGを返す
            self._set_status("disabled", "llm disabled", source, mark_time=True)
            return {"status": "ng", "detail": "llm is disabled"}
        if not s.base_url or not s.model:
            # ベースURLやモデル未指定での自動OKは行わない
            self._set_status(
                "disabled",
                "connection settings incomplete",
                source,
                mark_time=True,
            )
            return {"status": "ng", "detail": "base_url or model is missing"}

        # まずモデル一覧を取得し、選択モデルが含まれているかで判定する
        try:
            models = self.list_models()
            if not models:
                detail = "no models returned"
                self._record_status("ng", source, detail)
                return {"status": "ng", "detail": detail}
            if s.model in models:
                self._record_status("ok", source, "connection ok")
                return {"status": "ok"}
            detail = f"model '{s.model}' not found"
            self._record_status("ng", source, detail)
            return {"status": "ng", "detail": detail}
        except Exception as e:  # noqa: BLE001 - 疎通失敗は詳細を返す
            detail = str(e)
            self._record_status("ng", source, detail)
            return {"status": "ng", "detail": detail}

    def list_models(self, *, source: str | None = None) -> list[str]:
        """利用可能なモデル名の一覧を返す。

        Returns:
            list[str]: モデル名のリスト。
        """
        s = self.settings
        if not s.enabled or not s.base_url:
            if source:
                detail = "llm disabled" if not s.enabled else "base_url missing"
                self._set_status("disabled", detail, source, mark_time=True)
            return []

        try:
            timeout = httpx.Timeout(5.0)
            if s.provider == "ollama":
                url = s.base_url.rstrip("/") + "/api/tags"
                r = httpx.get(url, timeout=timeout)
                r.raise_for_status()
                data = r.json()
                # "models" キーの中の "name" を抽出
                models = sorted(
                    [m.get("name") for m in data.get("models", []) if m.get("name")]
                )
                if source:
                    self._record_status("ok", source, "model list fetched")
                return models
            else:  # LM Studio or other OpenAI compatible
                url = s.base_url.rstrip("/") + "/v1/models"
                headers = {}
                if s.api_key:
                    headers["Authorization"] = f"Bearer {s.api_key}"
                r = httpx.get(url, headers=headers, timeout=timeout)
                r.raise_for_status()
                data = r.json()
                # "data" キーの中の "id" を抽出
                models = sorted(
                    [m.get("id") for m in data.get("data", []) if m.get("id")]
                )
                if source:
                    self._record_status("ok", source, "model list fetched")
                return models
        except Exception as e:
            logging.getLogger("llm").error(f"Failed to list models: {e}")
            if source:
                self._record_status("ng", source, str(e))
            return []

    def generate_question(
        self,
        missing_item_id: str,
        missing_item_label: str,
        context: dict[str, Any] | None = None,
    ) -> str:
        """不足項目に対する追質問文を生成する。

        リモート LLM が有効かつ接続設定がある場合は HTTP 経由で生成を試み、
        失敗した場合はログとステータス記録のみ行い、スタブ質問へフォールバックする。

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
                        self._record_status(
                            "ok", "generate_question", "remote question generated"
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
                            self._record_status(
                                "ok",
                                "generate_question",
                                "remote question generated",
                            )
                            return content
                    raise RuntimeError("empty response from lm studio")
            except Exception as e:  # noqa: BLE001 - 呼び出し側でフォールバック
                self._record_status("ng", "generate_question", str(e))
                logging.getLogger("llm").exception(
                    "remote_generate_question_failed: %s", e
                )
                # 失敗時はスタブの追質問にフォールバックする

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
        self,
        context: dict[str, Any],
        max_questions: int,
        prompt: str | None = None,
        lock_key: str | None = None,
    ) -> list[str]:
        """ユーザー回答全体を基に追加質問を生成する。"""
        s = self.settings
        if not s.enabled:
            return []
        user_prompt = (prompt or DEFAULT_FOLLOWUP_PROMPT).replace(
            "{max_questions}", str(max_questions)
        )
        if s.base_url:
            # セッション単位の直列化
            lock = self._get_lock(lock_key)
            def _attempt() -> list[str]:
                timeout = httpx.Timeout(15.0)
                # プロバイダごとに構造化出力（JSON Schema）を強制する
                if s.provider == "ollama":
                    # Ollama: /api/chat に JSON Schema を format フィールドで指定
                    url = s.base_url.rstrip("/") + "/api/chat"
                    messages: list[dict[str, Any]] = []
                    if s.system_prompt:
                        messages.append({"role": "system", "content": s.system_prompt})
                    messages.append({
                        "role": "user",
                        "content": f"{context}\n{user_prompt}",
                    })
                    schema = {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 0,
                        "maxItems": max_questions,
                    }
                    payload: dict[str, Any] = {
                        "model": s.model,
                        "messages": messages,
                        "stream": False,
                        "options": {"temperature": s.temperature},
                        # JSON Schema に適合した配列を強制
                        "format": schema,
                    }
                    r = httpx.post(url, json=payload, timeout=timeout)
                    r.raise_for_status()
                    data = r.json()
                    content = (
                        (data.get("message") or {}).get("content")
                        or data.get("response")
                        or ""
                    )
                    arr = json.loads(content) if content else []
                    if isinstance(arr, list):
                        return [str(x) for x in arr][:max_questions]
                    raise RuntimeError("invalid structured response from ollama")
                else:
                    # LM Studio（OpenAI 互換）: response_format.json_schema で構造化出力を要求
                    url = s.base_url.rstrip("/") + "/v1/chat/completions"
                    headers = {"Content-Type": "application/json"}
                    if s.api_key:
                        headers["Authorization"] = f"Bearer {s.api_key}"
                    messages: list[dict[str, Any]] = []
                    if s.system_prompt:
                        messages.append({"role": "system", "content": s.system_prompt})
                    messages.append({"role": "user", "content": f"{context}\n{user_prompt}"})
                    schema = {
                        "name": "followup_questions",
                        "strict": "true",  # LM Studio の Structured Output 仕様に合わせる
                        "schema": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 0,
                            "maxItems": max_questions,
                        },
                    }
                    payload = {
                        "model": s.model,
                        "messages": messages,
                        "temperature": s.temperature,
                        "stream": False,
                        "response_format": {
                            "type": "json_schema",
                            "json_schema": schema,
                        },
                    }
                    r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
                    r.raise_for_status()
                    data = r.json()
                    choices = data.get("choices") or []
                    if choices:
                        content = choices[0].get("message", {}).get("content", "")
                        arr = json.loads(content) if content else []
                        if isinstance(arr, list):
                            return [str(x) for x in arr][:max_questions]
                    raise RuntimeError("invalid structured response from lm studio")
            # ロック内で実行し、失敗時はスタブへフォールバックする
            try:
                if lock:
                    with lock:
                        result = _attempt()
                else:
                    result = _attempt()
                self._record_status(
                    "ok", "generate_followups", "remote followups generated"
                )
                return result
            except Exception as e:  # noqa: BLE001
                self._record_status("ng", "generate_followups", str(e))
                logging.getLogger("llm").warning(
                    "generate_followups attempt failed: %s", e
                )
                # 失敗時はスタブ実装へフォールバックする
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
                self._record_status("ok", "chat", "remote chat succeeded")
                return reply
            except Exception as e:
                self._record_status("ng", "chat", str(e))
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
        lock_key: str | None = None,
        retry: int = 1,
    ) -> str:
        """カスタムのシステムプロンプトと問診回答を用いてサマリーを生成する。

        リモート設定が有効かつ base_url がある場合はリモート LLM に投げ、
        失敗時はスタブ的な要約にフォールバックする。
        """
        try:
            s = self.settings
            last_error: Exception | None = None
            # 質問と回答のペアを整形
            lines: list[str] = []
            for k, v in answers.items():
                label = labels.get(k) if labels else k
                lines.append(f"- {label}: {v}")
            pairs_text = "\n".join(lines)

            # リモート可能なら OpenAI/Ollama 互換のチャットで生成
            if s.enabled and s.base_url:
                lock = self._get_lock(lock_key)
                def _attempt() -> str:
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
                        raise RuntimeError("empty content from ollama summary")
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
                        raise RuntimeError("empty content from lm studio summary")
                try:
                    if lock:
                        with lock:
                            result = _attempt()
                    else:
                        result = _attempt()
                    self._record_status(
                        "ok", "summarize", "remote summary generated"
                    )
                    return result
                except Exception as e:
                    last_error = e
                    logging.getLogger("llm").warning(
                        "summarize_with_prompt attempt failed: %s", e
                    )
                    if retry > 0:
                        time.sleep(0.4)
                        try:
                            if lock:
                                with lock:
                                    result = _attempt()
                            else:
                                result = _attempt()
                            self._record_status(
                                "ok", "summarize", "remote summary generated"
                            )
                            return result
                        except Exception as e2:
                            last_error = e2
                            logging.getLogger("llm").exception(
                                "summarize_with_prompt retry failed: %s", e2
                            )
            if last_error:
                self._record_status("ng", "summarize", str(last_error))
        except Exception as e:  # noqa: BLE001 - フォールバックへ
            self._record_status("ng", "summarize", str(e))
            logging.getLogger("llm").exception("summarize_with_prompt failed: %s", e)

        # フォールバック（スタブ要約）
        return self.summarize(answers)
