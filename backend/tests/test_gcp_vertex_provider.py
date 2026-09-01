import json
from pathlib import Path
import sys
import logging
from types import MethodType, SimpleNamespace
from typing import Any

import httpx
import pytest

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.llm_providers.gcp_vertex import GcpVertexProvider
from app.llm_providers import gcp_vertex


def _response_from_parts(parts, *, as_content_list=False):
    content: dict | list
    if as_content_list:
        content = [
            {
                "role": "model",
                "parts": parts,
            }
        ]
    else:
        content = {
            "parts": parts,
        }
    return {
        "candidates": [
            {
                "content": content,
            }
        ]
    }


def test_new_gcp_profile_defaults_to_lowest_cost_confirmed_successor():
    default_profile = GcpVertexProvider().meta["default_profile"]

    assert default_profile["model"] == "gemini-3.1-flash-lite"
    assert default_profile["location"] == "global"


def test_extract_text_returns_plain_text():
    provider = GcpVertexProvider()
    response = _response_from_parts([
        {"text": "こんにちは"},
    ])

    text = provider._extract_text(response)

    assert text == "こんにちは"


def test_extract_text_handles_function_call_args():
    provider = GcpVertexProvider()
    response = _response_from_parts([
        {
            "text": "",
            "functionCall": {
                "name": "response",
                "args": {
                    "questions": [
                        "追加で痛みの強さを教えてください。",
                        "症状が悪化するタイミングはありますか？",
                    ],
                },
            },
        }
    ])

    text = provider._extract_text(response)
    parsed = json.loads(text)

    assert parsed["questions"][0].startswith("追加で")


def test_extract_text_handles_content_list_structure():
    provider = GcpVertexProvider()
    response = _response_from_parts(
        [
            {
                "functionCall": {
                    "name": "response",
                    "args": {
                        "items": [
                            "食事前後で症状に変化はありますか？",
                        ]
                    },
                }
            }
        ],
        as_content_list=True,
    )

    text = provider._extract_text(response)
    parsed = json.loads(text)

    assert parsed["items"][0].startswith("食事")


def test_extract_text_joins_multiple_text_parts():
    provider = GcpVertexProvider()
    response = _response_from_parts(
        [
            {"text": "[\n  \"痛みはいつ頃から始まりましたか？\","},
            {"text": "\n  \"痛みの程度はどの程度ですか？\",\n"},
            {"text": "  \"発熱や吐き気は伴いますか？\"\n]"},
        ]
    )

    text = provider._extract_text(response)
    parsed = json.loads(text)

    assert len(parsed) == 3


def test_extract_strings_from_text_repairs_malformed_array():
    provider = GcpVertexProvider()
    raw = (
        '[\n'
        '  "お腹の痛みはいつからですか？",\n'
        '  "痛みの種類を教えてください。",\n'
        '  "吐き気はありますか？"\n'
    )

    repaired = provider._extract_strings_from_text(raw)

    assert repaired == [
        "お腹の痛みはいつからですか？",
        "痛みの種類を教えてください。",
        "吐き気はありますか？",
    ]


def test_build_generation_payload_uses_profile_max_tokens():
    provider = GcpVertexProvider()
    settings = SimpleNamespace(temperature=0.2, system_prompt="")
    profile = provider.normalize_profile({
        "max_output_tokens": 4096,
    })

    payload = provider._build_generation_payload(  # type: ignore[arg-type]
        settings,
        profile,
        user_parts=[{"text": "ping"}],
    )

    assert payload["generationConfig"]["maxOutputTokens"] == 4096


def test_adc_credentials_are_used_even_if_legacy_json_field_exists(monkeypatch):
    provider = GcpVertexProvider()
    credentials = SimpleNamespace(valid=True, token="mock-access-token")
    calls: list[list[str]] = []

    def fake_default(*, scopes):
        calls.append(scopes)
        return credentials, "synthetic-project"

    monkeypatch.setattr(gcp_vertex, "google_auth", SimpleNamespace(default=fake_default))
    monkeypatch.setattr(gcp_vertex, "GoogleAuthRequest", lambda: object())

    loaded = provider._load_credentials(
        {"service_account_json": "SYNTHETIC_LEGACY_PRIVATE_KEY"}
    )

    assert loaded is credentials
    assert calls == [["https://www.googleapis.com/auth/cloud-platform"]]


def test_vertex_error_message_does_not_include_response_body():
    provider = GcpVertexProvider()
    secret = "SYNTHETIC_PRIVATE_KEY"
    response = httpx.Response(
        400,
        text=f'{{"error": {{"message": "invalid {secret}"}}}}',
    )

    message = provider._extract_error_message(response)

    assert message == "Vertex AI request failed (HTTP 400)"
    assert secret not in message


@pytest.mark.parametrize(
    "model",
    [
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash",
    ],
)
def test_confirmed_successor_model_ids_build_expected_global_path(model):
    provider = GcpVertexProvider()
    profile = {
        "project_id": "synthetic-project",
        "location": "global",
        "model": model,
    }

    assert provider._build_base_url(profile) == "https://aiplatform.googleapis.com"
    assert provider._build_model_path(profile) == (
        "projects/synthetic-project/locations/global/"
        f"publishers/google/models/{model}"
    )


def test_gemini_3_payload_is_single_turn_and_omits_sampling_temperature():
    provider = GcpVertexProvider()
    settings = SimpleNamespace(
        temperature=0.2,
        system_prompt="system",
        followup_timeout_seconds=30,
    )
    profile = provider.normalize_profile(
        {"model": "gemini-3.5-flash-lite", "temperature": 0.2}
    )

    payload = provider._build_generation_payload(  # type: ignore[arg-type]
        settings,
        profile,
        user_parts=[{"text": "ping"}],
        response_mime_type="application/json",
        response_schema={"type": "ARRAY", "items": {"type": "STRING"}},
    )

    assert payload["contents"] == [
        {"role": "user", "parts": [{"text": "ping"}]}
    ]
    assert "temperature" not in payload["generationConfig"]
    assert payload["generationConfig"]["responseMimeType"] == "application/json"
    assert "thoughtSignature" not in json.dumps(payload)


def test_response_metadata_log_does_not_include_thought_signature(caplog):
    provider = GcpVertexProvider()
    signature = "SYNTHETIC_THOUGHT_SIGNATURE"
    caplog.set_level(logging.INFO, logger="llm.gcp_vertex")

    provider._log_response_metadata(
        _response_from_parts([{"text": "ok", "thoughtSignature": signature}])
    )

    assert signature not in caplog.text
    assert "thoughtSignature" not in caplog.text


def test_generate_followups_does_not_force_constant_max_tokens():
    provider = GcpVertexProvider()
    settings = SimpleNamespace(temperature=0.2, system_prompt="")
    captured: dict[str, Any] = {}

    def fake_generate_text(self, settings, profile, *, user_parts, max_tokens=None, response_mime_type=None, response_schema=None):
        captured["max_tokens"] = max_tokens
        return "[]"

    provider._generate_text = MethodType(fake_generate_text, provider)
    profile = {
        "project_id": "dummy",
        "location": "asia-northeast1",
        "model": "gemini-2.5-flash",
        "max_output_tokens": 2048,
    }

    result = provider.generate_followups(settings, profile, context={}, max_questions=3)

    assert result == []
    assert captured["max_tokens"] is None
