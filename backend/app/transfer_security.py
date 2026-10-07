"""Bounded, side-effect-free validation for assets and portable data.

Persistence imports require an explicitly atomic adapter hook. Legacy per-record
import functions are deliberately never used as an atomic fallback.
"""
from __future__ import annotations

import base64
import csv
import io
import math
import re
import unicodedata
import warnings
from datetime import date, datetime
from typing import Any

from fastapi import HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

MAX_ASSET_BYTES = 512 * 1024
MAX_IMAGE_PIXELS = 4_000_000
MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_RECORDS = 100
SAFE_HEADERS = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"}
APP_SETTING_FIELDS = frozenset({
    "display_name", "timezone", "entry_message", "completion_message", "theme_color",
    "logo_url", "logo_crop", "pdf_layout_mode", "default_questionnaire_id",
})
SESSION_FIELDS = frozenset({
    "id", "patient_name", "dob", "gender", "visit_type", "questionnaire_id", "answers",
    "summary", "remaining_items", "completion_status", "interrupted", "attempt_counts",
    "additional_questions_used", "max_additional_questions", "followup_prompt",
    "started_at", "finalized_at", "llm_question_texts", "question_texts",
})


def invalid(detail: str = "invalid_export_payload") -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


async def read_import(file: UploadFile) -> bytes:
    data = await file.read(MAX_IMPORT_BYTES + 1)
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="import_too_large")
    return data


def clean_raster(data: bytes) -> tuple[bytes, str, str]:
    """Decode and re-encode a single-frame raster, dropping metadata and trailers."""
    if len(data) > MAX_ASSET_BYTES:
        raise HTTPException(status_code=413, detail="image_too_large")
    if not data:
        raise invalid("invalid_image")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                fmt = image.format
                if fmt not in {"PNG", "JPEG", "WEBP"}:
                    raise invalid("unsupported_image_format")
                if image.width * image.height > MAX_IMAGE_PIXELS or image.width < 1 or image.height < 1:
                    raise invalid("image_pixel_limit")
                if getattr(image, "n_frames", 1) != 1:
                    raise invalid("animated_image_not_supported")
                image.load()
                # A fresh pixel-only image cannot retain EXIF, ICC, comments, etc.
                mode = "RGBA" if fmt != "JPEG" and "A" in image.getbands() else "RGB"
                if fmt != "JPEG" and "transparency" in image.info:
                    mode = "RGBA"
                pixels = image.convert(mode)
                clean = Image.frombytes(mode, pixels.size, pixels.tobytes())
                out = io.BytesIO()
                clean.save(out, format=fmt)
                encoded = out.getvalue()
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise invalid("invalid_image") from exc
    if len(encoded) > MAX_ASSET_BYTES:
        raise HTTPException(status_code=413, detail="image_too_large")
    return encoded, {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[fmt], {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}[fmt]


def validate_assets(payload: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(payload, dict) or len(payload) > MAX_IMPORT_RECORDS:
        raise invalid("invalid_image_payload")
    validated = {}
    for name, encoded in payload.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}", name):
            raise invalid("invalid_image_filename")
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_ASSET_BYTES + 2) // 3):
            raise invalid("invalid_image_payload")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise invalid("invalid_image_payload") from exc
        content, content_type, _ = clean_raster(raw)
        validated[name] = {"content": content, "content_type": content_type}
    return validated


def portable_app_settings(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise invalid()
    result = {key: value[key] for key in APP_SETTING_FIELDS if key in value}
    for key, item in result.items():
        if key == "logo_crop" and item is not None:
            if not isinstance(item, dict) or any(type(item.get(field)) not in {int, float} or not math.isfinite(item[field]) for field in ("x", "y", "w", "h")):
                raise invalid()
            result[key] = {field: item[field] for field in ("x", "y", "w", "h")}
        elif key != "logo_crop" and item is not None and not isinstance(item, str):
            raise invalid()
    return result


def portable_session(value: dict[str, Any]) -> dict[str, Any]:
    # Security state/capabilities are not data portability fields.
    return {key: value[key] for key in SESSION_FIELDS if key in value}


def validate_json_tree(value: Any, depth: int = 0) -> None:
    if depth > 16:
        raise invalid()
    if isinstance(value, dict):
        if len(value) > 1000 or any(not isinstance(k, str) or len(k) > 200 for k in value):
            raise invalid()
        for child in value.values():
            validate_json_tree(child, depth + 1)
    elif isinstance(value, list):
        if len(value) > 1000:
            raise invalid()
        for child in value:
            validate_json_tree(child, depth + 1)
    elif isinstance(value, str):
        if len(value) > 100_000:
            raise invalid()
    elif isinstance(value, float) and not math.isfinite(value):
        raise invalid()
    elif value is not None and not isinstance(value, (str, bool, int, float)):
        raise invalid()


def _records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > MAX_IMPORT_RECORDS or any(not isinstance(x, dict) for x in value):
        raise invalid()
    return value


def _identifier(value: Any) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > 200 or any(unicodedata.category(c).startswith("C") for c in value):
        raise invalid()


def validate_questionnaires(payload: dict[str, Any]) -> dict[str, Any]:
    # Validate assets separately: their base64 strings have a larger size ceiling.
    data = {key: payload[key] for key in ("templates", "summary_prompts", "followup_prompts", "default_questionnaire_id", "app_settings", "llm_settings") if key in payload}
    validate_json_tree(data)
    total = 0
    def check_items(items: Any) -> None:
        for item in _records(items):
            _identifier(item.get("id"))
            if not isinstance(item.get("label"), str) or not isinstance(item.get("type"), str):
                raise invalid()
            if item.get("followups") is not None:
                if not isinstance(item["followups"], dict):
                    raise invalid()
                for children in item["followups"].values():
                    check_items(children)
    for key in ("templates", "summary_prompts", "followup_prompts"):
        records = _records(data.get(key, []))
        total += len(records)
        seen = set()
        for record in records:
            _identifier(record.get("id"))
            if record.get("visit_type") not in {"initial", "followup"}:
                raise invalid()
            identity = (record["id"], record["visit_type"])
            if identity in seen:
                raise invalid()
            seen.add(identity)
            if key == "templates":
                check_items(record.get("items", []))
                maximum = record.get("llm_followup_max_questions", 5)
                if type(maximum) is not int or not 0 <= maximum <= 20:
                    raise invalid()
                if "llm_followup_enabled" in record and type(record["llm_followup_enabled"]) is not bool:
                    raise invalid()
            elif not isinstance(record.get("prompt", ""), str) or type(record.get("enabled", False)) is not bool:
                raise invalid()
    if total > MAX_IMPORT_RECORDS:
        raise invalid("too_many_records")
    if data.get("default_questionnaire_id") is not None:
        _identifier(data["default_questionnaire_id"])
    if "app_settings" in data:
        if not isinstance(data["app_settings"], dict):
            raise invalid()
        data["app_settings"] = portable_app_settings(data["app_settings"])
    if "llm_settings" in data:
        if data["llm_settings"] is None or data["llm_settings"] == {}:
            data.pop("llm_settings")
        elif not isinstance(data["llm_settings"], dict):
            raise invalid()
    return data


def validate_sessions(value: Any) -> list[dict[str, Any]]:
    records = _records(value)
    validate_json_tree(records)
    result = []
    seen = set()
    for source in records:
        record = portable_session(source)
        _identifier(record.get("id"))
        if record["id"] in seen:
            raise invalid()
        seen.add(record["id"])
        for key in ("patient_name", "dob", "gender", "questionnaire_id"):
            _identifier(record.get(key))
        if record.get("visit_type") not in {"initial", "followup"}:
            raise invalid()
        if record.get("completion_status") not in {"in_progress", "complete", "finalized", "interrupted"}:
            raise invalid()
        for key in ("answers", "attempt_counts", "llm_question_texts", "question_texts"):
            if key in record and not isinstance(record[key], dict):
                raise invalid()
        if not isinstance(record.get("remaining_items", []), list):
            raise invalid()
        for key in ("additional_questions_used", "max_additional_questions"):
            number = record.get(key, 0)
            if type(number) is not int or not 0 <= number <= 100:
                raise invalid()
        for key in ("summary", "followup_prompt", "started_at", "finalized_at"):
            if record.get(key) is not None and not isinstance(record[key], str):
                raise invalid()
        for key in ("llm_question_texts", "question_texts"):
            if any(not isinstance(v, str) for v in record.get(key, {}).values()):
                raise invalid()
        if any(type(v) is not int or not 0 <= v <= 100 for v in record.get("attempt_counts", {}).values()):
            raise invalid()
        if any(not isinstance(v, str) or len(v) > 200 for v in record.get("remaining_items", [])):
            raise invalid()
        if "interrupted" in record and type(record["interrupted"]) is not bool:
            raise invalid()
        try:
            date.fromisoformat(record["dob"])
            for key in ("started_at", "finalized_at"):
                if record.get(key) is not None:
                    datetime.fromisoformat(record[key])
        except ValueError:
            raise invalid() from None
        result.append(record)
    return result


def atomic_import(kind: str, data: Any, *, mode: str, images: dict | None = None, logos: dict | None = None) -> dict:
    """Adapter contract: one durable all-or-nothing commit, including binary assets.

    Hooks preserve administrator security state and never resurrect imported
    patient capabilities. Built-in SQLite implements this; unsupported adapters
    (including CouchDB's cross-document stores) must fail before any mutation.
    """
    if mode not in {"merge", "replace"}:
        raise invalid("invalid_mode")
    from . import db
    hook = getattr(db.get_active_adapter(), f"atomic_import_{kind}", None)
    if not callable(hook):
        raise HTTPException(status_code=501, detail="atomic_import_not_supported")
    if kind == "questionnaire_settings":
        return hook(data, mode=mode, images=images or {}, logos=logos or {})
    return hook(data, mode=mode)


def csv_cell(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    significant = value.lstrip()
    significant = "".join(c for c in significant if not unicodedata.category(c).startswith("C")).lstrip()
    if significant.startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


class SafeCSVWriter:
    def __init__(self, target: Any) -> None:
        self.writer = csv.writer(target)

    def writerow(self, cells: Any) -> Any:
        return self.writer.writerow([csv_cell(cell) for cell in cells])
