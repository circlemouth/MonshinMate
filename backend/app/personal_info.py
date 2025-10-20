"""Utility helpers for bundled personal info questionnaire items."""
from __future__ import annotations

from typing import Any, Iterable, Mapping

FIELD_DEFS: list[tuple[str, str]] = [
    ("name", "患者名"),
    ("kana", "よみがな"),
    ("postal_code", "郵便番号"),
    ("address", "住所"),
    ("phone", "電話番号"),
]
FIELD_KEYS = [key for key, _ in FIELD_DEFS]
FIELD_LABEL_MAP = {key: label for key, label in FIELD_DEFS}
EMPTY_PLACEHOLDER = "未回答"
NORMALIZED_EMPTY = "該当なし"


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "items") and callable(getattr(value, "items")):
        try:
            return dict(value.items())  # type: ignore[arg-type]
        except Exception:  # pragma: no cover - defensive
            return None
    return None


def coerce_to_strings(value: Any) -> dict[str, str] | None:
    """Return a dict with all expected keys coerced to strings."""

    mapping = _as_mapping(value)
    if mapping is None:
        return None
    result: dict[str, str] = {}
    for key in FIELD_KEYS:
        raw = mapping.get(key, "")
        if raw is None:
            raw = ""
        result[key] = str(raw)
    return result


def sanitize_input(value: Any) -> dict[str, str] | None:
    """Trim whitespace around inputs while keeping raw strings."""

    data = coerce_to_strings(value)
    if data is None:
        return None
    return {key: data[key].strip() for key in FIELD_KEYS}


def normalize_for_storage(value: Any) -> dict[str, str] | None:
    """Normalize values for persistence, replacing blanks with a placeholder."""

    data = coerce_to_strings(value)
    if data is None:
        return None
    normalized: dict[str, str] = {}
    for key in FIELD_KEYS:
        text = data[key].strip()
        normalized[key] = text or NORMALIZED_EMPTY
    return normalized


def has_any_value(value: Any) -> bool:
    data = coerce_to_strings(value)
    if data is None:
        return False
    return any(
        (text := data[key].strip()) and text != NORMALIZED_EMPTY for key in FIELD_KEYS
    )


def is_complete(value: Any) -> bool:
    data = coerce_to_strings(value)
    if data is None:
        return False
    return all(
        (text := data[key].strip()) and text != NORMALIZED_EMPTY for key in FIELD_KEYS
    )


def format_compact(value: Any, separator: str = " / ") -> str:
    data = coerce_to_strings(value)
    if data is None:
        return str(value)
    parts = []
    for key, label in FIELD_DEFS:
        text = data[key].strip()
        display = text if text and text != NORMALIZED_EMPTY else EMPTY_PLACEHOLDER
        parts.append(f"{label}: {display}")
    return separator.join(parts)


def format_multiline(value: Any, line_separator: str = "\n") -> str:
    data = coerce_to_strings(value)
    if data is None:
        return str(value)
    lines = []
    for key, label in FIELD_DEFS:
        text = data[key].strip()
        display = text if text and text != NORMALIZED_EMPTY else EMPTY_PLACEHOLDER
        lines.append(f"{label}: {display}")
    return line_separator.join(lines)


def format_lines(
    value: Any,
    *,
    skip_keys: Iterable[str] | None = None,
    hide_empty: bool = False,
) -> list[str]:
    """Return a list of "label: value" strings for patient information."""

    data = coerce_to_strings(value) or {key: "" for key in FIELD_KEYS}
    skip = set(skip_keys or [])
    lines: list[str] = []
    for key, label in FIELD_DEFS:
        if key in skip:
            continue
        text = data.get(key, "").strip()
        has_value = bool(text and text != NORMALIZED_EMPTY)
        display = text if has_value else EMPTY_PLACEHOLDER
        if hide_empty and not has_value:
            continue
        lines.append(f"{label}: {display}")
    return lines
