"""Build an LLM allowlist from server-defined, non-identifying questions."""
from __future__ import annotations

import re
from typing import Any

_IDENTITY = re.compile(r"氏名|名前|生年月日|住所|電話|メール|郵便|患者番号|保険証|マイナンバー", re.I)
_IDENTITY_KEYS = {"name", "patient_name", "dob", "birthdate", "birthday", "address", "email", "phone", "postal_code", "personal_info", "gender"}


def clinical_answers(session: Any) -> dict[str, Any]:
    allowed: set[str] = set()
    def visit(items):
        for item in items:
            data = item if isinstance(item, dict) else item.model_dump()
            key = str(data.get("id", ""))
            if (data.get("type") != "personal_info" and key.lower() not in _IDENTITY_KEYS
                    and not _IDENTITY.search(str(data.get("label", "")))):
                allowed.add(key)
            for children in (data.get("followups") or {}).values():
                visit(children or [])
    visit(session.template_items)
    # Generated question IDs must have actually been issued by this server.
    allowed.update(key for key, text in (getattr(session, "llm_question_texts", {}) or {}).items()
                   if not _IDENTITY.search(text))
    return {key: value for key, value in session.answers.items() if key in allowed}
