"""LLM 設定から秘密情報を除外する境界処理。"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable


_LEGACY_SERVICE_ACCOUNT_FIELDS = {
    "service_account_json",
    "serviceaccountjson",
}

_FORBIDDEN_STORAGE_KEY_MARKERS = (
    "private_key",
    "secret_key",
    "client_secret",
    "access_token",
    "refresh_token",
    "auth_token",
    "bearer_token",
    "id_token",
    "oauth_token",
    "credential_json",
)

_RESPONSE_TOP_LEVEL_FIELDS = {
    "provider",
    "model",
    "temperature",
    "system_prompt",
    "enabled",
    "base_url",
    "followup_timeout_seconds",
}

_RESPONSE_PROFILE_FIELDS = {
    "model",
    "temperature",
    "system_prompt",
    "base_url",
    "followup_timeout_seconds",
}


def _normalized_key(key: Any) -> str:
    return str(key).strip().lower().replace("-", "_")


def _is_forbidden_storage_key(key: Any) -> bool:
    normalized = _normalized_key(key)
    return normalized in _LEGACY_SERVICE_ACCOUNT_FIELDS or any(
        marker in normalized for marker in _FORBIDDEN_STORAGE_KEY_MARKERS
    )


def sanitize_llm_settings_for_storage(value: Any) -> Any:
    """旧サービスアカウント field を再帰的に除去してコピーする。

    API key は他プロバイダの実行に必要な場合があるため、この保存境界では
    除去しない。API 応答とエクスポートでは別の allowlist を適用する。
    """

    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            if _is_forbidden_storage_key(key):
                continue
            sanitized[str(key)] = sanitize_llm_settings_for_storage(item)
        return sanitized
    if isinstance(value, list):
        return [sanitize_llm_settings_for_storage(item) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_llm_settings_for_storage(item) for item in value)
    return deepcopy(value)


def sanitize_llm_settings_for_read(
    value: dict[str, Any],
    *,
    safe_extra_fields: dict[str, Iterable[str]] | None = None,
) -> dict[str, Any]:
    """管理者向け応答に使える非機密 field だけを返す。

    プロバイダ固有 field は、レジストリが明示的に非機密と宣言したものだけを
    allowlist に追加する。将来追加された field は既定で応答に含まれない。
    """

    source = sanitize_llm_settings_for_storage(value)
    result = {
        key: deepcopy(source.get(key))
        for key in _RESPONSE_TOP_LEVEL_FIELDS
        if key in source
    }
    result["api_key_configured"] = bool(source.get("api_key"))

    extras = {
        provider: {str(field) for field in fields}
        for provider, fields in (safe_extra_fields or {}).items()
    }
    profiles: dict[str, dict[str, Any]] = {}
    raw_profiles = source.get("provider_profiles")
    if isinstance(raw_profiles, dict):
        for provider, raw_profile in raw_profiles.items():
            if not isinstance(raw_profile, dict):
                continue
            allowed = _RESPONSE_PROFILE_FIELDS | extras.get(str(provider), set())
            safe_profile = {
                key: deepcopy(raw_profile.get(key))
                for key in allowed
                if key in raw_profile
            }
            safe_profile["api_key_configured"] = bool(raw_profile.get("api_key"))
            profiles[str(provider)] = safe_profile
    result["provider_profiles"] = profiles
    return result
