from __future__ import annotations

"""Google Cloud Vertex AI 向け LLM プロバイダアダプタ。"""

from typing import Any, TYPE_CHECKING
import json
import base64
import logging
import re

import httpx
try:  # pragma: no cover
    import google.auth as google_auth
    from google.auth.transport.requests import Request as GoogleAuthRequest
    from google.oauth2 import service_account
except ImportError:  # pragma: no cover
    google_auth = None  # type: ignore[assignment]
    GoogleAuthRequest = None  # type: ignore[assignment]
    service_account = None  # type: ignore[assignment]

if TYPE_CHECKING:  # pragma: no cover
    from google.auth.credentials import Credentials as GoogleCredentials
    from ..llm_gateway import LLMSettings
else:  # pragma: no cover
    GoogleCredentials = Any


_LOGGER = logging.getLogger("llm.gcp_vertex")
_GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_DEFAULT_MODEL = "publishers/google/models/gemini-1.5-pro-001"
_DEFAULT_LOCATION = "us-central1"
_DEFAULT_MAX_OUTPUT_TOKENS = 8192
_MAX_OUTPUT_TOKENS_LIMIT = 8192
_MIN_OUTPUT_TOKENS = 32


GCP_VERTEX_PROVIDER_META: dict[str, Any] = {
    "key": "gcp_vertex",
    "label": "Google Cloud Vertex AI",
    "description": "Google Cloud Vertex AI の Gemini モデルを利用します。",
    "helper": "サービスアカウントの JSON キーを入力するか、Google ADC が利用できる環境で実行してください。",
    "use_base_url": False,
    "use_api_key": False,
    "default_profile": {
        "model": _DEFAULT_MODEL,
        "temperature": 0.2,
        "system_prompt": "",
        "project_id": "",
        "location": _DEFAULT_LOCATION,
        "service_account_json": "",
        "max_output_tokens": _DEFAULT_MAX_OUTPUT_TOKENS,
    },
    "extra_fields": [
        {
            "key": "project_id",
            "label": "GCP プロジェクトID",
            "type": "text",
            "required": True,
            "helper": "Vertex AI を利用するプロジェクトの ID を入力してください。",
        },
        {
            "key": "location",
            "label": "ロケーション",
            "type": "text",
            "required": True,
            "helper": "例: us-central1 / asia-northeast1 など",
            "placeholder": _DEFAULT_LOCATION,
        },
        {
            "key": "service_account_json",
            "label": "サービスアカウントJSONファイル",
            "type": "file",
            "required": False,
            "helper": "サービスアカウントの JSON キーファイルをアップロードしてください。空欄の場合は GOOGLE_APPLICATION_CREDENTIALS など ADC を利用します。",
            "accept": "application/json,.json",
        },
        {
            "key": "max_output_tokens",
            "label": "最大出力トークン",
            "type": "number",
            "required": False,
            "helper": "レスポンスの最大トークン数 (32〜8192 程度)。",
            "min": 32,
            "max": 8192,
            "step": 32,
        },
    ],
}


class GcpVertexProvider:
    """Vertex AI Generative Language API を呼び出すアダプタ。"""

    def __init__(self) -> None:
        self.meta: dict[str, Any] = dict(GCP_VERTEX_PROVIDER_META)

    # --- メタ情報関連ユーティリティ ---
    def normalize_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(profile)
        model = str(normalized.get("model") or "").strip() or _DEFAULT_MODEL
        normalized["model"] = model
        location = str(normalized.get("location") or "").strip() or _DEFAULT_LOCATION
        normalized["location"] = location
        project = str(normalized.get("project_id") or "").strip()
        normalized["project_id"] = project
        try:
            max_tokens = int(normalized.get("max_output_tokens") or _DEFAULT_MAX_OUTPUT_TOKENS)
        except (TypeError, ValueError):
            max_tokens = _DEFAULT_MAX_OUTPUT_TOKENS
        normalized["max_output_tokens"] = max(
            _MIN_OUTPUT_TOKENS,
            min(_MAX_OUTPUT_TOKENS_LIMIT, max_tokens),
        )
        return normalized

    # --- 認証処理 ---
    def _load_credentials(self, profile: dict[str, Any]) -> GoogleCredentials:
        if GoogleAuthRequest is None or google_auth is None or service_account is None:
            raise RuntimeError(
                "google-auth ライブラリがインストールされていません。`pip install google-auth` を実行してください。"
            )
        scopes = [_GCP_SCOPE]
        raw_json = profile.get("service_account_json")
        credentials: GoogleCredentials
        if raw_json:
            info = self._parse_service_account_json(raw_json)
            credentials = service_account.Credentials.from_service_account_info(info, scopes=scopes)
        else:
            credentials, _ = google_auth.default(scopes=scopes)
        if not credentials.valid:
            credentials.refresh(GoogleAuthRequest())
        return credentials

    def _parse_service_account_json(self, raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            return raw
        text = str(raw or "").strip()
        if not text:
            raise ValueError("サービスアカウントJSONが空です")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            try:
                decoded = base64.b64decode(text)
            except Exception as exc:  # noqa: BLE001
                raise ValueError("サービスアカウントJSONの形式が不正です") from exc
            try:
                return json.loads(decoded)
            except Exception as exc:  # noqa: BLE001
                raise ValueError("サービスアカウントJSONを解析できませんでした") from exc

    def _get_auth_headers(self, profile: dict[str, Any]) -> dict[str, str]:
        if GoogleAuthRequest is None:
            raise RuntimeError(
                "google-auth ライブラリがインストールされていません。`pip install google-auth` を実行してください。"
            )
        credentials = self._load_credentials(profile)
        token = credentials.token
        if not token:
            credentials.refresh(GoogleAuthRequest())
            token = credentials.token
        if not token:
            raise RuntimeError("GCP のアクセストークンを取得できませんでした")
        return {"Authorization": f"Bearer {token}"}

    # --- API 呼び出し ---
    def _build_base_url(self, profile: dict[str, Any]) -> str:
        location = profile.get("location") or _DEFAULT_LOCATION
        return f"https://{location}-aiplatform.googleapis.com"

    def _build_model_path(self, profile: dict[str, Any], *, model: str | None = None) -> str:
        project_id = profile.get("project_id")
        if not project_id:
            raise ValueError("GCP プロジェクトIDを設定してください")
        location = profile.get("location") or _DEFAULT_LOCATION
        model_name = model or profile.get("model") or _DEFAULT_MODEL
        model_name = str(model_name)
        if not model_name.startswith("publishers/"):
            if "/" not in model_name:
                model_name = f"publishers/google/models/{model_name}"
            else:
                model_name = f"publishers/google/models/{model_name.split('/')[-1]}"
        return f"projects/{project_id}/locations/{location}/{model_name}"

    def _perform_request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        json_payload: dict[str, Any] | None = None,
        timeout_seconds: float = 30.0,
    ) -> httpx.Response:
        with httpx.Client(timeout=timeout_seconds) as client:
            response = client.request(method, url, headers=headers, json=json_payload)
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                detail = self._extract_error_message(response)
                raise RuntimeError(detail) from exc
            return response

    def _extract_error_message(self, response: httpx.Response) -> str:
        try:
            data = response.json()
        except Exception:  # noqa: BLE001
            return f"HTTP {response.status_code}: {response.text}"
        message = data.get("error", {}).get("message") if isinstance(data, dict) else None
        return message or f"HTTP {response.status_code}"

    def list_models(self, settings: LLMSettings, profile: dict[str, Any], *, source: str | None = None) -> list[str]:
        profile = self.normalize_profile(profile)
        headers = self._get_auth_headers(profile)
        base_url = self._build_base_url(profile)
        project_id = profile.get("project_id")
        location = profile.get("location") or _DEFAULT_LOCATION
        url = f"{base_url}/v1/projects/{project_id}/locations/{location}/publishers/google/models"
        response = self._perform_request("GET", url, headers)
        data = response.json()
        models: list[str] = []
        for item in (data or {}).get("models", []):
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if isinstance(name, str) and name:
                models.append(name.split("/models/")[-1])
        if not models:
            _LOGGER.warning(
                "vertex_list_models_empty_fallback: project=%s location=%s",
                project_id,
                location,
            )
            models = [
                "gemini-1.5-flash-001",
                "gemini-1.5-pro-001",
                "text-bison@001",
            ]
        return sorted(set(models))

    def test_connection(self, settings: LLMSettings, profile: dict[str, Any], *, source: str | None = None) -> dict[str, str]:
        profile = self.normalize_profile(profile)
        model_path = self._build_model_path(profile)
        base_url = self._build_base_url(profile)
        headers = self._get_auth_headers(profile)
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": "ping"}],
                }
            ],
            "generationConfig": {
                "maxOutputTokens": 1,
                "temperature": 0.0,
            },
        }
        url = f"{base_url}/v1/{model_path}:generateContent"
        self._perform_request("POST", url, headers, payload, timeout_seconds=15.0)
        return {"status": "ok", "detail": "vertex connection ok"}

    def _extract_text(self, data: dict[str, Any]) -> str:
        candidates = data.get("candidates") if isinstance(data, dict) else None
        if not candidates:
            return ""
        first = candidates[0]
        if not isinstance(first, dict):
            return ""
        content = first.get("content")
        parts: list[dict[str, Any]] | None
        if isinstance(content, dict):
            raw_parts = content.get("parts")
            parts = raw_parts if isinstance(raw_parts, list) else None
        elif isinstance(content, list):
            flattened: list[dict[str, Any]] = []
            for entry in content:
                if not isinstance(entry, dict):
                    continue
                entry_parts = entry.get("parts")
                if isinstance(entry_parts, list):
                    flattened.extend([p for p in entry_parts if isinstance(p, dict)])
                else:
                    flattened.append(entry)
            parts = flattened or None
        else:
            parts = None
        if not parts:
            return ""
        fallback_text: str | None = None
        text_chunks: list[str] = []
        structured_chunks: list[str] = []
        for part in parts:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str):
                if text.strip():
                    text_chunks.append(text)
                elif fallback_text is None:
                    fallback_text = text
            structured_text = self._extract_structured_part(part)
            if structured_text:
                structured_chunks.append(structured_text)
        if text_chunks:
            return "".join(text_chunks)
        if structured_chunks:
            return structured_chunks[0]
        return fallback_text or ""

    def _extract_structured_part(self, part: dict[str, Any]) -> str | None:
        """Gemini の functionCall / json レスポンスを文字列化する。"""

        def _dumps(value: Any) -> str | None:
            if value is None:
                return None
            if isinstance(value, (dict, list)):
                return json.dumps(value, ensure_ascii=False)
            return str(value)

        function_call = part.get("functionCall")
        if isinstance(function_call, dict):
            serialized = _dumps(function_call.get("args"))
            if serialized:
                return serialized

        function_response = part.get("functionResponse")
        if isinstance(function_response, dict):
            for key in ("response", "result", "outputs"):
                serialized = _dumps(function_response.get(key))
                if serialized:
                    return serialized

        json_payload = part.get("json")
        serialized = _dumps(json_payload)
        if serialized:
            return serialized

        return None

    def _build_generation_payload(
        self,
        settings: LLMSettings,
        profile: dict[str, Any],
        *,
        user_parts: list[dict[str, str]],
        max_tokens: int | None = None,
        response_mime_type: str | None = None,
        response_schema: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if max_tokens is not None:
            try:
                resolved_max_tokens = int(max_tokens)
            except (TypeError, ValueError):
                resolved_max_tokens = _DEFAULT_MAX_OUTPUT_TOKENS
        else:
            try:
                resolved_max_tokens = int(profile.get("max_output_tokens") or _DEFAULT_MAX_OUTPUT_TOKENS)
            except (TypeError, ValueError):
                resolved_max_tokens = _DEFAULT_MAX_OUTPUT_TOKENS
            resolved_max_tokens = max(
                _MIN_OUTPUT_TOKENS,
                min(_MAX_OUTPUT_TOKENS_LIMIT, resolved_max_tokens),
            )
        payload: dict[str, Any] = {
            "contents": [
                {
                    "role": "user",
                    "parts": user_parts,
                }
            ],
            "generationConfig": {
                "temperature": float(profile.get("temperature") or settings.temperature or 0.2),
                "maxOutputTokens": resolved_max_tokens,
            },
        }
        system_prompt = profile.get("system_prompt") or settings.system_prompt
        if system_prompt:
            payload["systemInstruction"] = {
                "parts": [{"text": str(system_prompt)}],
            }
        configuration: dict[str, Any] = {}
        if response_mime_type:
            configuration["responseMimeType"] = response_mime_type
        if response_schema:
            configuration["responseSchema"] = response_schema
        if configuration:
            payload["generationConfig"].update(configuration)
        return payload

    def _generate_text(
        self,
        settings: LLMSettings,
        profile: dict[str, Any],
        *,
        user_parts: list[dict[str, str]],
        max_tokens: int | None = None,
        response_mime_type: str | None = None,
        response_schema: dict[str, Any] | None = None,
    ) -> str:
        profile = self.normalize_profile(profile)
        base_url = self._build_base_url(profile)
        model_path = self._build_model_path(profile)
        headers = self._get_auth_headers(profile)
        payload = self._build_generation_payload(
            settings,
            profile,
            user_parts=user_parts,
            max_tokens=max_tokens,
            response_mime_type=response_mime_type,
            response_schema=response_schema,
        )
        url = f"{base_url}/v1/{model_path}:generateContent"
        response = self._perform_request("POST", url, headers, payload)
        data = response.json()
        self._log_response_metadata(data)
        text = self._extract_text(data)
        return text.strip()

    def generate_question(
        self,
        settings: LLMSettings,
        profile: dict[str, Any],
        missing_item_id: str,
        missing_item_label: str,
        context: dict[str, Any] | None,
    ) -> str:
        prompt = (
            "以下の問診項目に関して患者から十分な情報が得られていません。"
            "医療従事者として追加で確認すべき質問を1つだけ、日本語の敬体で作成してください。"
        )
        details = [
            f"項目ID: {missing_item_id}",
            f"項目ラベル: {missing_item_label}",
        ]
        if context:
            details.append(f"補足情報: {json.dumps(context, ensure_ascii=False)}")
        text = prompt + "\n" + "\n".join(details)
        return self._generate_text(
            settings,
            profile,
            user_parts=[{"text": text}],
            max_tokens=256,
        )

    def generate_followups(
        self,
        settings: LLMSettings,
        profile: dict[str, Any],
        context: dict[str, Any],
        max_questions: int,
        prompt: str | None = None,
    ) -> list[str]:
        base_prompt = prompt or (
            "以下の患者情報を参照し、診療に必要な追質問を日本語の敬体で最大{max_questions}個生成してください。"
            "質問のみを JSON 配列で返してください。"
        )
        text = base_prompt.format(max_questions=max_questions)
        details = json.dumps(context or {}, ensure_ascii=False)
        _LOGGER.info(
            "vertex_followups_request prompt=%s context_chars=%d",
            text,
            len(details),
        )
        response_text = self._generate_text(
            settings,
            profile,
            user_parts=[{"text": f"{text}\n患者情報: {details}"}],
            response_mime_type="application/json",
            response_schema={
                "type": "ARRAY",
                "items": {"type": "STRING"},
            },
        )
        truncated = response_text if len(response_text) <= 2000 else f"{response_text[:2000]}…"
        _LOGGER.info(
            "vertex_followups_response_raw length=%d preview=%s",
            len(response_text),
            truncated,
        )
        try:
            data = json.loads(response_text)
            if isinstance(data, list):
                _LOGGER.info(
                    "vertex_followups_response count=%d",
                    len(data),
                )
                return [str(item) for item in data if isinstance(item, (str, int, float))]
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("vertex_followups_json_parse_failed: %s", exc)
        _LOGGER.warning("vertex_followups_response_raw: %s", response_text)
        repaired = self._extract_strings_from_text(response_text)
        if repaired:
            _LOGGER.info("vertex_followups_repaired count=%d", len(repaired))
            return repaired[:max_questions]
        return [line.strip() for line in response_text.splitlines() if line.strip()][:max_questions]

    def _extract_strings_from_text(self, raw: str) -> list[str]:
        pattern = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', raw)
        results: list[str] = []
        for fragment in pattern:
            try:
                # 再度 JSON 文字列としてデコードし、エスケープを正規化する
                results.append(json.loads(f'"{fragment}"'))
            except json.JSONDecodeError:
                cleaned = (
                    fragment.replace('\\"', '"')
                    .replace('\\n', '\n')
                    .replace('\\r', '\r')
                    .replace('\\t', '\t')
                )
                results.append(cleaned)
        return [item.strip() for item in results if item.strip()]

    def _log_response_metadata(self, data: dict[str, Any]) -> None:
        try:
            candidates = data.get("candidates") or []
            finish = []
            safety: list[str] = []
            for idx, candidate in enumerate(candidates):
                if not isinstance(candidate, dict):
                    continue
                finish_reason = candidate.get("finishReason")
                if finish_reason:
                    finish.append(f"{idx}:{finish_reason}")
                ratings = candidate.get("safetyRatings")
                if isinstance(ratings, list):
                    for rating in ratings:
                        if not isinstance(rating, dict):
                            continue
                        category = rating.get("category")
                        probability = rating.get("probability")
                        if category and probability:
                            safety.append(f"{category}:{probability}")
            usage = data.get("usageMetadata")
            prompt_feedback = data.get("promptFeedback")
            preview = json.dumps(data, ensure_ascii=False)[:1000]
            _LOGGER.info(
                "vertex_response_meta finish=%s prompt_feedback=%s usage=%s safety=%s json_preview=%s",
                finish or None,
                prompt_feedback,
                usage,
                safety or None,
                preview,
            )
        except Exception as exc:  # noqa: BLE001
            _LOGGER.debug("vertex_response_meta_error: %s", exc)

    def chat(
        self,
        settings: LLMSettings,
        profile: dict[str, Any],
        message: str,
    ) -> str:
        return self._generate_text(
            settings,
            profile,
            user_parts=[{"text": str(message)}],
        )

    def summarize_with_prompt(
        self,
        settings: LLMSettings,
        profile: dict[str, Any],
        system_prompt: str,
        answers: dict[str, Any],
        labels: dict[str, str] | None = None,
    ) -> str:
        summary_prompt = system_prompt or (
            "以下の問診結果をもとに、患者の状況を簡潔な日本語のサマリーにまとめてください。"
        )
        payload = json.dumps({
            "answers": answers,
            "labels": labels or {},
        }, ensure_ascii=False)
        return self._generate_text(
            settings,
            profile,
            user_parts=[{"text": f"{summary_prompt}\n\nデータ: {payload}"}],
        )
