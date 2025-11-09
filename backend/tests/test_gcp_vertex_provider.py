import json
from pathlib import Path
import sys
from types import MethodType, SimpleNamespace
from typing import Any

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.llm_providers.gcp_vertex import GcpVertexProvider


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
