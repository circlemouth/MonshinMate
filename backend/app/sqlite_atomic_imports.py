"""SQLite-only, single-connection import transactions (never snapshot/restore DBs).

The caller owns BEGIN IMMEDIATE/commit/rollback. No function here opens a second
connection or calls legacy persistence helpers which commit independently.
"""
from __future__ import annotations

import json
import re
import time
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException

from .llm_data_security import validate_profile_destination
from .llm_settings_security import sanitize_llm_settings_for_read, sanitize_llm_settings_for_storage
from .transfer_security import (
    APP_SETTING_FIELDS, MAX_IMPORT_BYTES, MAX_IMPORT_RECORDS, clean_raster,
    portable_app_settings, validate_questionnaires, validate_sessions,
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _load_settings(conn, table: str) -> dict[str, Any]:
    # table comes only from the two internal literal callers below.
    row = conn.execute(f"SELECT json FROM {table} WHERE id='global'").fetchone()
    return json.loads(row["json"]) if row else {}


def _save_settings(conn, table: str, value: dict[str, Any]) -> None:
    conn.execute(f"INSERT INTO {table}(id,json) VALUES('global',?) "
                 "ON CONFLICT(id) DO UPDATE SET json=excluded.json", (_json(value),))


def _portable_llm(value: dict[str, Any]) -> dict[str, Any]:
    result = sanitize_llm_settings_for_read(value, safe_extra_fields={"gcp_vertex": {"project_id", "location"}})
    result.pop("api_key_configured", None)
    for profile in result.get("provider_profiles", {}).values():
        profile.pop("api_key_configured", None)
    return result


def _merge_llm(current: dict[str, Any], incoming: dict[str, Any], mode: str) -> dict[str, Any]:
    safe = _portable_llm(incoming)
    old_safe = _portable_llm(current)
    profiles = dict(current.get("provider_profiles") or {})
    if mode == "replace":
        current = {key: value for key, value in current.items() if key not in old_safe}
        for provider, old_profile in old_safe.get("provider_profiles", {}).items():
            profiles[provider] = {key: value for key, value in profiles.get(provider, {}).items() if key not in old_profile}
    for provider, profile in safe.pop("provider_profiles", {}).items():
        profiles[provider] = {**profiles.get(provider, {}), **profile}
    current.update(safe)
    current["provider_profiles"] = profiles
    if current.get("enabled", True):
        provider = current.get("provider") or "openai"
        profile = {**current, **profiles.get(provider, {})}
        try:
            validate_profile_destination(provider, profile)
        except ValueError:
            raise HTTPException(400, "invalid_llm_settings") from None
    return current


def stage_assets(images: dict | None, logos: dict | None) -> list[tuple[str, str, bytes, str]]:
    staged = []
    names = set()
    total_bytes = 0
    for category, assets in (("questionnaire_item_image", images), ("system_logo_image", logos)):
        if assets is not None and not isinstance(assets, dict):
            raise HTTPException(400, "invalid_assets")
        for filename, asset in (assets or {}).items():
            if (not isinstance(filename, str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}", filename)
                    or filename in names or not isinstance(asset, dict) or not isinstance(asset.get("content"), bytes)):
                raise HTTPException(400, "invalid_assets")
            total_bytes += len(asset["content"])
            if total_bytes > MAX_IMPORT_BYTES or len(staged) >= MAX_IMPORT_RECORDS:
                raise HTTPException(413, "import_too_large")
            content, mime, _ = clean_raster(asset["content"])
            staged.append((category, filename, content, mime))
            names.add(filename)
    return staged


def questionnaire_settings(conn, data: dict, *, mode: str, staged_assets: list) -> dict[str, int]:
    data = validate_questionnaires(data)
    record_count = sum(len(data.get(key, [])) for key in ("templates", "summary_prompts", "followup_prompts"))
    if record_count + len(staged_assets) > MAX_IMPORT_RECORDS:
        raise HTTPException(400, "too_many_records")
    if mode == "replace":
        for table in ("questionnaire_templates", "summary_prompts", "followup_prompts"):
            conn.execute(f"DELETE FROM {table}")
    for template in data.get("templates", []):
        conn.execute("INSERT INTO questionnaire_templates(id,visit_type,items_json,llm_followup_enabled,llm_followup_max_questions) "
                     "VALUES(?,?,?,?,?) ON CONFLICT(id,visit_type) DO UPDATE SET items_json=excluded.items_json, "
                     "llm_followup_enabled=excluded.llm_followup_enabled,llm_followup_max_questions=excluded.llm_followup_max_questions",
                     (template["id"], template["visit_type"], _json(template.get("items", [])),
                      int(template.get("llm_followup_enabled", True)), template.get("llm_followup_max_questions", 5)))
    for table in ("summary_prompts", "followup_prompts"):
        for prompt in data.get(table, []):
            conn.execute(f"INSERT INTO {table}(id,visit_type,prompt_text,enabled) VALUES(?,?,?,?) "
                         "ON CONFLICT(id,visit_type) DO UPDATE SET prompt_text=excluded.prompt_text,enabled=excluded.enabled",
                         (prompt["id"], prompt["visit_type"], prompt.get("prompt", ""), int(prompt.get("enabled", False))))
    current = _load_settings(conn, "app_settings")
    if mode == "replace":
        # Preserve API-key hashes, auth/security state and unknown future secret fields.
        current = {key: value for key, value in current.items() if key not in APP_SETTING_FIELDS}
    current.update(portable_app_settings(data.get("app_settings", {})))
    if "default_questionnaire_id" in data:
        current["default_questionnaire_id"] = data["default_questionnaire_id"]
    if "app_settings" in data or "default_questionnaire_id" in data or mode == "replace":
        _save_settings(conn, "app_settings", current)
    if "llm_settings" in data:
        merged = _merge_llm(_load_settings(conn, "llm_settings"), data["llm_settings"], mode)
        _save_settings(conn, "llm_settings", sanitize_llm_settings_for_storage(merged))
    now = datetime.now(UTC).isoformat()
    for category, filename, content, mime in staged_assets:
        existing = conn.execute("SELECT category FROM binary_assets WHERE id=?", (filename,)).fetchone()
        if existing and existing["category"] != category:
            raise HTTPException(409, "asset_category_conflict")
        conn.execute("INSERT INTO binary_assets(id,category,filename,content_type,data,created_at,updated_at) "
                     "VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, "
                     "content_type=excluded.content_type,data=excluded.data,updated_at=excluded.updated_at",
                     (filename, category, filename, mime, content, now, now))
    return {"templates": len(data.get("templates", [])), "summary_prompts": len(data.get("summary_prompts", [])),
            "followup_prompts": len(data.get("followup_prompts", [])), "app_settings": int("app_settings" in data),
            "llm_settings": int("llm_settings" in data)}


def sessions_data(conn, data: list, *, mode: str) -> dict[str, int]:
    records = validate_sessions(data)
    affected = {record["id"] for record in records}
    if len(affected) != len(records):
        raise HTTPException(400, "duplicate_session_id")
    if mode == "replace":
        affected.update(row["id"] for row in conn.execute("SELECT id FROM sessions"))
        affected.update(row["key"][len("patient:capability:"):] for row in conn.execute(
            "SELECT key FROM security_state WHERE key LIKE 'patient:capability:%'"))
    # BEGIN IMMEDIATE excludes concurrent security-state CAS. An existing patient
    # lease/open capability is rejected, never stolen, even if its TTL expired.
    states = {}
    for session_id in affected:
        row = conn.execute("SELECT revision,value FROM security_state WHERE key=?", ("patient:capability:" + session_id,)).fetchone()
        if row:
            state = json.loads(row["value"])
            if state.get("status") == "open" or state.get("operation"):
                raise HTTPException(409, "session_in_use")
        states[session_id] = row
    if mode == "replace":
        conn.execute("DELETE FROM sessions")
    for session_id, row in states.items():
        # Imported records have no live credentials; old finalization receipts
        # and hashes cannot accidentally become authorization for replaced data.
        conn.execute("INSERT INTO security_state(key,revision,value) VALUES(?,?,?) "
                     "ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value",
                     ("patient:capability:" + session_id, row["revision"] + 1 if row else 1,
                      _json({"status": "deleted", "expires_at": time.time()})))
    for record in records:
        conn.execute("DELETE FROM sessions WHERE id=?", (record["id"],))
        question_texts = {**record.get("question_texts", {}), **record.get("llm_question_texts", {})}
        conn.execute("INSERT INTO sessions(id,patient_name,dob,gender,visit_type,questionnaire_id,answers_json,summary,"
                     "remaining_items_json,completion_status,attempt_counts_json,additional_questions_used,max_additional_questions,"
                     "followup_prompt,started_at,finalized_at,llm_question_texts_json,question_texts_json) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (record["id"], record["patient_name"], record["dob"], record["gender"], record["visit_type"], record["questionnaire_id"],
                      _json(record.get("answers", {})), record.get("summary"), _json(record.get("remaining_items", [])),
                      record.get("completion_status", "finalized"), _json(record.get("attempt_counts", {})),
                      record.get("additional_questions_used", 0), record.get("max_additional_questions", 0),
                      record.get("followup_prompt"), record.get("started_at"), record.get("finalized_at"),
                      _json(record.get("llm_question_texts", {})), _json(question_texts)))
        for item_id, answer in record.get("answers", {}).items():
            conn.execute("INSERT INTO session_responses(session_id,item_id,answer_json,question_text,ts) VALUES(?,?,?,?,?)",
                         (record["id"], item_id, _json(answer), question_texts.get(item_id),
                          record.get("finalized_at") or record.get("started_at") or ""))
    return {"sessions": len(records)}
