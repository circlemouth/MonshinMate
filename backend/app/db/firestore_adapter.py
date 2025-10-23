"""Firestore ベースの永続化アダプタ。"""
from __future__ import annotations

import os
import logging
import unicodedata
from datetime import datetime, UTC
from typing import Any, Iterable, List

try:  # pragma: no cover - オプショナル依存のため
    from google.cloud import firestore  # type: ignore
except Exception:  # pragma: no cover - 依存未導入時
    firestore = None  # type: ignore

from cryptography.fernet import InvalidToken

from ..config import FirestoreConfig
from .sqlite_adapter import pwd_context, fernet


SPACE_CHARS = {" ", "\u3000"}


def _normalize_patient_name_for_search(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "")
    return "".join(ch for ch in normalized if ch not in SPACE_CHARS)


def _extract_question_texts_from_items(items: Iterable[Any] | None) -> dict[str, str]:
    mapping: dict[str, str] = {}
    if not items:
        return mapping
    stack: list[Any] = list(items)
    while stack:
        item = stack.pop()
        if item is None:
            continue
        item_id = None
        label = None
        try:
            item_id = getattr(item, "id", None)
        except Exception:
            item_id = None
        if item_id is None and isinstance(item, dict):
            item_id = item.get("id")
        try:
            label = getattr(item, "label", None)
        except Exception:
            label = None
        if label is None and isinstance(item, dict):
            label = item.get("label")
        if item_id and isinstance(label, str):
            mapping[str(item_id)] = label
        followups = None
        try:
            followups = getattr(item, "followups", None)
        except Exception:
            followups = None
        if followups is None and isinstance(item, dict):
            followups = item.get("followups")
        if isinstance(followups, dict):
            for children in followups.values():
                if not children:
                    continue
                if isinstance(children, (list, tuple, set)):
                    stack.extend(list(children))
                else:
                    stack.append(children)
    return mapping


def _to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    try:
        return value.isoformat()  # type: ignore[attr-defined]
    except Exception:
        return None


    def _ensure_datetime(value: Any) -> datetime | None:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except Exception:
            return None
    return None


class FirestoreAdapter:
    """Firestore 版の永続化アダプタ。

    既存 SQLite 実装と同等のインターフェースを提供するため、
    Cloud Run/Firebase 移行の第一段階としてテンプレート関連 API を実装する。
    未対応の操作は今後順次実装する。
    """

    name = "firestore"

    def __init__(self, config: FirestoreConfig) -> None:
        self.config = config
        self.default_db_path: str | None = None
        self.couch_db = None
        self.couchdb_url = None
        self._client: Any | None = None
        self._namespace_parts: tuple[str, ...] = (
            (config.namespace,) if config and config.namespace else tuple()
        )

    # ------------------------------------------------------------------
    # 初期化 / 共通ヘルパ
    # ------------------------------------------------------------------

    def _ensure_client(self):
        if self._client is None:
            raise RuntimeError("Firestore client not initialized. call init_db() first.")
        return self._client

    def _collection(self, *segments: str):
        client = self._ensure_client()
        parts = [segment for segment in self._namespace_parts + tuple(segments) if segment]
        return client.collection(*parts)

    def _document(self, *segments: str):
        client = self._ensure_client()
        parts = [segment for segment in self._namespace_parts + tuple(segments) if segment]
        return client.document(*parts)

    def _template_ref(self, template_id: str):
        return self._collection("questionnaireTemplates").document(template_id)

    def _variant_ref(self, template_id: str, visit_type: str):
        return self._template_ref(template_id).collection("variants").document(visit_type)

    def _config_ref(self, config_id: str):
        return self._collection("systemConfigs").document(config_id)

    def _user_ref(self, username: str):
        return self._collection("users").document(username)

    def _audit_collection(self):
        return self._collection("auditLogs")

    @staticmethod
    def _normalize_items(items: Iterable[dict[str, Any]]) -> List[dict[str, Any]]:
        normalized: List[dict[str, Any]] = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            entry = dict(item)
            if entry.get("type") == "single":
                entry["type"] = "multi"
            normalized.append(entry)
        return normalized

    @staticmethod
    def _restore_items(items: Iterable[dict[str, Any]] | None) -> List[dict[str, Any]]:
        restored: List[dict[str, Any]] = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            entry = dict(item)
            if entry.get("type") == "single":
                entry["type"] = "multi"
            restored.append(entry)
        return restored

    def _build_session_payload(self, session: Any) -> dict[str, Any]:
        raw_llm_qtexts = getattr(session, "llm_question_texts", {}) or {}
        llm_qtexts: dict[str, str] = {
            str(key): str(value)
            for key, value in raw_llm_qtexts.items()
            if isinstance(key, str) and isinstance(value, str)
        }

        question_texts = {
            str(key): str(value)
            for key, value in (getattr(session, "question_texts", {}) or {}).items()
            if isinstance(value, str)
        }
        if not question_texts:
            template_items = getattr(session, "template_items", None)
            question_texts.update(_extract_question_texts_from_items(template_items))
        for key, value in llm_qtexts.items():
            question_texts.setdefault(key, value)

        started_at = getattr(session, "started_at", None)
        finalized_at = getattr(session, "finalized_at", None)
        if started_at is None and finalized_at is not None:
            started_at = finalized_at

        payload: dict[str, Any] = {
            "patient_name": getattr(session, "patient_name", None),
            "dob": getattr(session, "dob", None),
            "gender": getattr(session, "gender", None),
            "visit_type": getattr(session, "visit_type", None),
            "questionnaire_id": getattr(session, "questionnaire_id", None),
            "answers": getattr(session, "answers", {}),
            "summary": getattr(session, "summary", None),
            "remaining_items": getattr(session, "remaining_items", []),
            "completion_status": getattr(session, "completion_status", "in_progress"),
            "attempt_counts": getattr(session, "attempt_counts", {}),
            "additional_questions_used": getattr(session, "additional_questions_used", 0),
            "max_additional_questions": getattr(session, "max_additional_questions", 5),
            "followup_prompt": getattr(session, "followup_prompt", ""),
            "interrupted": getattr(session, "interrupted", False),
            "llm_question_texts": llm_qtexts,
            "question_texts": question_texts,
            "started_at": _to_iso(started_at),
            "finalized_at": _to_iso(finalized_at),
            "updated_at": firestore.SERVER_TIMESTAMP,
        }

        pending_llm = getattr(session, "pending_llm_questions", None)
        if pending_llm is not None:
            payload["pending_llm_questions"] = pending_llm

        payload["attempt_counts"] = {
            str(k): int(v)
            for k, v in (payload.get("attempt_counts") or {}).items()
            if k is not None
        }
        payload["remaining_items"] = [str(x) for x in (payload.get("remaining_items") or [])]

        return payload

    def _session_snapshot_to_dict(self, snapshot: Any) -> dict[str, Any] | None:
        if snapshot is None or not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        session_id = snapshot.id
        started_iso = _to_iso(data.get("started_at"))
        finalized_iso = _to_iso(data.get("finalized_at"))
        if not started_iso:
            started_iso = finalized_iso
        completion = str(data.get("completion_status") or "")
        interrupted = completion != "finalized"

        def _ensure_dict_str(obj: Any) -> dict[str, str]:
            if not isinstance(obj, dict):
                return {}
            return {str(k): str(v) for k, v in obj.items() if isinstance(v, str)}

        result = {
            "id": session_id,
            "patient_name": data.get("patient_name"),
            "dob": data.get("dob"),
            "gender": data.get("gender"),
            "visit_type": data.get("visit_type"),
            "questionnaire_id": data.get("questionnaire_id"),
            "answers": data.get("answers") or {},
            "summary": data.get("summary"),
            "remaining_items": list(data.get("remaining_items") or []),
            "completion_status": completion,
            "attempt_counts": data.get("attempt_counts") or {},
            "additional_questions_used": data.get("additional_questions_used", 0),
            "max_additional_questions": data.get("max_additional_questions", 0),
            "followup_prompt": data.get("followup_prompt"),
            "started_at": started_iso,
            "finalized_at": finalized_iso,
            "interrupted": interrupted,
            "llm_question_texts": _ensure_dict_str(data.get("llm_question_texts")),
            "question_texts": _ensure_dict_str(data.get("question_texts")),
        }

        pending_llm = data.get("pending_llm_questions")
        if pending_llm is not None:
            result["pending_llm_questions"] = pending_llm
        return result

    def init(self) -> None:
        if firestore is None:
            raise RuntimeError(
                "google-cloud-firestore がインストールされていません。"
            )

        project_id = self.config.project_id
        if self.config.use_emulator:
            if self.config.emulator_host:
                os.environ.setdefault("FIRESTORE_EMULATOR_HOST", self.config.emulator_host)
            project_id = project_id or "monshinmate-emulator"
            os.environ.setdefault("FIRESTORE_PROJECT_ID", project_id)
        elif not project_id:
            raise RuntimeError(
                "FIRESTORE_PROJECT_ID を設定してください。（エミュレータ利用時は FIRESTORE_USE_EMULATOR=1 でも可）"
            )

        # credentials_file が指定されている場合は標準の Google 認証機構が処理する。
        self._client = firestore.Client(project=project_id)

    # ------------------------------------------------------------------
    # テンプレート / プロンプト
    # ------------------------------------------------------------------

    def upsert_template(
        self,
        template_id: str,
        visit_type: str,
        items: Iterable[dict[str, Any]],
        llm_followup_enabled: bool = True,
        llm_followup_max_questions: int = 5,
        **_kwargs: Any,
    ) -> None:
        client = self._ensure_client()
        normalized_items = self._normalize_items(items)
        visit_type = str(visit_type)

        template_ref = self._template_ref(template_id)
        variant_ref = self._variant_ref(template_id, visit_type)

        def _apply(transaction):
            template_snapshot = template_ref.get(transaction=transaction)
            template_payload: dict[str, Any] = {
                "id": template_id,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            }
            if not template_snapshot.exists:
                template_payload["createdAt"] = firestore.SERVER_TIMESTAMP
            transaction.set(template_ref, template_payload, merge=True)

            variant_snapshot = variant_ref.get(transaction=transaction)
            variant_payload: dict[str, Any] = {
                "visitType": visit_type,
                "items": normalized_items,
                "llmFollowupEnabled": bool(llm_followup_enabled),
                "llmFollowupMaxQuestions": int(llm_followup_max_questions),
                "updatedAt": firestore.SERVER_TIMESTAMP,
            }
            if not variant_snapshot.exists:
                variant_payload["createdAt"] = firestore.SERVER_TIMESTAMP
            transaction.set(variant_ref, variant_payload, merge=True)

        transaction = client.transaction()
        transaction.run(_apply)

    def get_template(self, template_id: str, visit_type: str, **_kwargs: Any) -> dict[str, Any] | None:
        variant_ref = self._variant_ref(template_id, visit_type)
        snapshot = variant_ref.get()
        if not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        items = self._restore_items(data.get("items"))
        return {
            "id": template_id,
            "visit_type": visit_type,
            "items": items,
            "llm_followup_enabled": bool(data.get("llmFollowupEnabled", True)),
            "llm_followup_max_questions": int(data.get("llmFollowupMaxQuestions", 5)),
        }

    def list_templates(self, **_kwargs: Any) -> list[dict[str, Any]]:
        client = self._ensure_client()
        results: list[dict[str, Any]] = []
        query = client.collection_group("variants")
        for snapshot in query.stream():
            parent = snapshot.reference.parent.parent
            if not parent:
                continue
            data = snapshot.to_dict() or {}
            visit_type = data.get("visitType") or snapshot.id
            results.append({
                "id": parent.id,
                "visit_type": str(visit_type),
            })
        return sorted(results, key=lambda x: (x["id"], x["visit_type"]))

    def delete_template(self, template_id: str, visit_type: str, **_kwargs: Any) -> None:
        client = self._ensure_client()
        variant_ref = self._variant_ref(template_id, visit_type)
        try:
            variant_ref.delete()
        except Exception:
            # Firestore の delete は存在しなくても例外にならないが、将来の互換性のため例外は握りつぶす。
            pass

        # 残りの variant が無ければテンプレートドキュメントも削除
        template_ref = self._template_ref(template_id)
        remaining = list(template_ref.collection("variants").limit(1).stream())
        if not remaining:
            try:
                template_ref.delete()
            except Exception:
                pass

    # rename_template はセッション更新・既定テンプレート更新処理が未実装のため、後続タスクで対応

    def rename_template(self, *args, **kwargs):  # pragma: no cover - 未実装通知
        self._ensure_client()
        if len(args) < 2:
            raise ValueError("template_id and new_id are required")
        template_id = str(args[0])
        new_id = str(args[1])
        if template_id == new_id:
            return

        old_ref = self._template_ref(template_id)
        new_ref = self._template_ref(new_id)

        old_doc = old_ref.get()
        if not old_doc.exists:
            raise LookupError(f"template {template_id} not found")
        if new_ref.get().exists:
            raise ValueError(f"template id {new_id} already exists")

        template_data = old_doc.to_dict() or {}
        template_data["id"] = new_id
        template_data["updatedAt"] = firestore.SERVER_TIMESTAMP
        new_ref.set(template_data, merge=True)

        old_variants = list(old_ref.collection("variants").stream())
        for variant_snapshot in old_variants:
            data = variant_snapshot.to_dict() or {}
            data["updatedAt"] = firestore.SERVER_TIMESTAMP
            dest_ref = new_ref.collection("variants").document(variant_snapshot.id)
            dest_ref.set(data, merge=True)

        # 旧ドキュメントを削除（variants -> template の順）
        for variant_snapshot in old_variants:
            variant_snapshot.reference.delete()
        old_ref.delete()

        # セッションの questionnaire_id を更新
        sessions_query = self._collection("sessions").where("questionnaire_id", "==", template_id)
        for snapshot in sessions_query.stream():
            snapshot.reference.update(
                {
                    "questionnaire_id": new_id,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                }
            )

        # 既定テンプレートIDを更新
        settings = self.load_app_settings() or {}
        if settings.get("default_questionnaire_id") == template_id:
            settings["default_questionnaire_id"] = new_id
            self.save_app_settings(settings)

    # ------------------------------------------------------------------
    # プロンプト設定
    # ------------------------------------------------------------------

    def upsert_summary_prompt(
        self,
        template_id: str,
        visit_type: str,
        prompt_text: str,
        enabled: bool = False,
        **_kwargs: Any,
    ) -> None:
        variant_ref = self._variant_ref(template_id, visit_type)
        payload = {
            "visitType": str(visit_type),
            "summaryPrompt": prompt_text,
            "summaryEnabled": bool(enabled),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        variant_ref.set(payload, merge=True)

    def upsert_followup_prompt(
        self,
        template_id: str,
        visit_type: str,
        prompt_text: str,
        enabled: bool = False,
        **_kwargs: Any,
    ) -> None:
        variant_ref = self._variant_ref(template_id, visit_type)
        payload = {
            "visitType": str(visit_type),
            "followupPrompt": prompt_text,
            "followupEnabled": bool(enabled),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        variant_ref.set(payload, merge=True)

    def get_summary_config(self, template_id: str, visit_type: str, **_kwargs: Any) -> dict[str, Any] | None:
        data = self._load_variant(template_id, visit_type)
        if not data or "summaryPrompt" not in data:
            return None
        return {
            "prompt": data.get("summaryPrompt"),
            "enabled": bool(data.get("summaryEnabled", False)),
        }

    def get_followup_config(self, template_id: str, visit_type: str, **_kwargs: Any) -> dict[str, Any] | None:
        data = self._load_variant(template_id, visit_type)
        if not data or "followupPrompt" not in data:
            return None
        return {
            "prompt": data.get("followupPrompt"),
            "enabled": bool(data.get("followupEnabled", False)),
        }

    def get_summary_prompt(self, template_id: str, visit_type: str, **_kwargs: Any) -> str | None:
        cfg = self.get_summary_config(template_id, visit_type)
        return cfg["prompt"] if cfg else None

    def get_followup_prompt(self, template_id: str, visit_type: str, **_kwargs: Any) -> str | None:
        cfg = self.get_followup_config(template_id, visit_type)
        return cfg["prompt"] if cfg else None

    # ------------------------------------------------------------------
    # 非対応メソッド（順次実装予定）
    # ------------------------------------------------------------------

    def _not_implemented(self, method: str) -> None:  # pragma: no cover - ガード
        raise NotImplementedError(f"FirestoreAdapter.{method} は未実装です")

    def _load_variant(self, template_id: str, visit_type: str) -> dict[str, Any] | None:
        snapshot = self._variant_ref(template_id, visit_type).get()
        if not snapshot.exists:
            return None
        return snapshot.to_dict() or {}

    def save_session(self, *args, **kwargs):
        self._ensure_client()
        if not args:
            raise ValueError("session instance is required")
        session = args[0]
        session_id = getattr(session, "id", None)
        if not session_id:
            raise ValueError("session id is required")
        payload = self._build_session_payload(session)
        doc_ref = self._collection("sessions").document(str(session_id))
        doc_ref.set(payload, merge=True)

    def list_sessions(self, *args, **kwargs):
        self._ensure_client()
        patient_name = kwargs.get("patient_name")
        dob = kwargs.get("dob")
        start_date = kwargs.get("start_date")
        end_date = kwargs.get("end_date")

        docs = list(self._collection("sessions").stream())
        results: list[dict[str, Any]] = []
        patient_query = (patient_name or "").strip()
        normalized_query = (
            _normalize_patient_name_for_search(patient_query) if patient_query else ""
        )

        for snapshot in docs:
            data = self._session_snapshot_to_dict(snapshot)
            if not data:
                continue
            raw_name = data.get("patient_name") or ""
            if patient_query:
                direct_match = patient_query in raw_name
                normalized_match = True
                if normalized_query:
                    normalized_match = normalized_query in _normalize_patient_name_for_search(raw_name)
                if not direct_match and not normalized_match:
                    continue
            if dob and dob != data.get("dob"):
                continue
            started_at = data.get("started_at") or data.get("finalized_at")
            if start_date and started_at and started_at < f"{start_date}T00:00:00":
                continue
            if end_date and started_at and started_at > f"{end_date}T23:59:59":
                continue
            results.append(
                {
                    "id": data.get("id"),
                    "patient_name": data.get("patient_name"),
                    "dob": data.get("dob"),
                    "visit_type": data.get("visit_type"),
                    "started_at": started_at,
                    "finalized_at": data.get("finalized_at"),
                    "interrupted": data.get("interrupted", False),
                }
            )

        results.sort(
            key=lambda x: ((x.get("started_at") or ""), (x.get("finalized_at") or "")),
            reverse=True,
        )
        return results

    def list_sessions_finalized_after(self, *args, **kwargs):
        self._ensure_client()
        if not args:
            raise ValueError("since datetime is required")
        since = args[0]
        limit = max(1, int(kwargs.get("limit", 50)))
        collect_events = since is not None

        docs = list(self._collection("sessions").stream())
        latest_dt: datetime | None = None
        events: list[dict[str, Any]] = []

        for snapshot in docs:
            data = self._session_snapshot_to_dict(snapshot)
            if not data:
                continue
            finalized_iso = data.get("finalized_at")
            finalized_dt = _ensure_datetime(finalized_iso)
            if finalized_dt is None:
                continue
            if latest_dt is None or finalized_dt > latest_dt:
                latest_dt = finalized_dt
            if collect_events and since and finalized_dt <= since:
                continue
            if collect_events:
                events.append(
                    {
                        "id": data.get("id"),
                        "patient_name": data.get("patient_name"),
                        "dob": data.get("dob"),
                        "visit_type": data.get("visit_type"),
                        "started_at": data.get("started_at"),
                        "finalized_at": finalized_dt.isoformat(),
                    }
                )

        events.sort(key=lambda x: x.get("finalized_at") or "")
        if len(events) > limit:
            events = events[-limit:]
        return events, latest_dt

    def get_session(self, *args, **kwargs):
        self._ensure_client()
        if not args:
            raise ValueError("session_id is required")
        session_id = args[0]
        snapshot = self._collection("sessions").document(str(session_id)).get()
        return self._session_snapshot_to_dict(snapshot)

    def delete_session(self, *args, **kwargs):
        self._ensure_client()
        if not args:
            raise ValueError("session_id is required")
        session_id = args[0]
        doc_ref = self._collection("sessions").document(str(session_id))
        snapshot = doc_ref.get()
        if not snapshot.exists:
            return False
        doc_ref.delete()
        return True

    def delete_sessions(self, ids: Iterable[str], *args, **kwargs):
        deleted = 0
        for session_id in ids:
            if not session_id:
                continue
            if self.delete_session(session_id):
                deleted += 1
        return deleted

    def save_llm_settings(self, *args, **kwargs):
        self._ensure_client()
        if not args:
            raise ValueError("settings dict is required")
        settings = args[0] or {}
        self._config_ref("llmSettings").set(
            {
                "configId": "llmSettings",
                "payload": settings,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

    def load_llm_settings(self, *args, **kwargs):
        self._ensure_client()
        snapshot = self._config_ref("llmSettings").get()
        if not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        payload = data.get("payload")
        if isinstance(payload, dict):
            return payload
        return None

    def _write_audit_event(self, event: str, username: str | None = None, note: str | None = None) -> None:
        try:
            self._audit_collection().add(
                {
                    "event": event,
                    "username": username,
                    "note": note,
                    "createdAt": firestore.SERVER_TIMESTAMP,
                }
            )
        except Exception:
            pass

    def save_app_settings(self, *args, **kwargs):
        self._ensure_client()
        if not args:
            raise ValueError("settings dict is required")
        settings = args[0] or {}
        self._config_ref("appSettings").set(
            {
                "configId": "appSettings",
                "payload": settings,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

    def load_app_settings(self, *args, **kwargs):
        self._ensure_client()
        snapshot = self._config_ref("appSettings").get()
        if not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        payload = data.get("payload")
        if isinstance(payload, dict):
            return payload
        return None

    def export_questionnaire_settings(self, *args, **kwargs):
        self._ensure_client()
        templates: list[dict[str, Any]] = []
        summary_prompts: list[dict[str, Any]] = []
        followup_prompts: list[dict[str, Any]] = []

        for template_snapshot in self._collection("questionnaireTemplates").stream():
            template_id = template_snapshot.id
            variant_query = template_snapshot.reference.collection("variants").stream()
            for variant in variant_query:
                data = variant.to_dict() or {}
                visit_type = data.get("visitType") or variant.id
                templates.append(
                    {
                        "id": template_id,
                        "visit_type": str(visit_type),
                        "items": self._restore_items(data.get("items")),
                        "llm_followup_enabled": bool(data.get("llmFollowupEnabled", True)),
                        "llm_followup_max_questions": int(data.get("llmFollowupMaxQuestions", 5)),
                    }
                )
                if "summaryPrompt" in data:
                    summary_prompts.append(
                        {
                            "id": template_id,
                            "visit_type": str(visit_type),
                            "prompt": data.get("summaryPrompt", ""),
                            "enabled": bool(data.get("summaryEnabled", False)),
                        }
                    )
                if "followupPrompt" in data:
                    followup_prompts.append(
                        {
                            "id": template_id,
                            "visit_type": str(visit_type),
                            "prompt": data.get("followupPrompt", ""),
                            "enabled": bool(data.get("followupEnabled", False)),
                        }
                    )

        app_settings = self.load_app_settings() or {}
        default_qid = app_settings.get("default_questionnaire_id")

        return {
            "templates": templates,
            "summary_prompts": summary_prompts,
            "followup_prompts": followup_prompts,
            "default_questionnaire_id": default_qid,
        }

    def import_questionnaire_settings(self, *args, **kwargs):
        self._ensure_client()
        if not args:
            raise ValueError("data payload is required")
        data = args[0] or {}
        mode = kwargs.get("mode", "merge")
        if mode not in {"merge", "replace"}:
            raise ValueError("invalid mode")

        templates = data.get("templates") or []
        summary_prompts = data.get("summary_prompts") or []
        followup_prompts = data.get("followup_prompts") or []
        default_qid = data.get("default_questionnaire_id")

        if mode == "replace":
            for template_snapshot in self._collection("questionnaireTemplates").stream():
                for variant in template_snapshot.reference.collection("variants").stream():
                    variant.reference.delete()
                template_snapshot.reference.delete()

        for tpl in templates:
            tpl_id = tpl.get("id")
            visit_type = tpl.get("visit_type")
            if not tpl_id or not visit_type:
                continue
            items = tpl.get("items") or []
            self.upsert_template(
                tpl_id,
                visit_type,
                items,
                llm_followup_enabled=bool(tpl.get("llm_followup_enabled", True)),
                llm_followup_max_questions=int(tpl.get("llm_followup_max_questions", 5) or 0),
            )

        for sp in summary_prompts:
            tpl_id = sp.get("id")
            visit_type = sp.get("visit_type")
            if not tpl_id or not visit_type:
                continue
            self.upsert_summary_prompt(
                tpl_id,
                visit_type,
                sp.get("prompt", ""),
                enabled=bool(sp.get("enabled")),
            )

        for fp in followup_prompts:
            tpl_id = fp.get("id")
            visit_type = fp.get("visit_type")
            if not tpl_id or not visit_type:
                continue
            self.upsert_followup_prompt(
                tpl_id,
                visit_type,
                fp.get("prompt", ""),
                enabled=bool(fp.get("enabled")),
            )

        if default_qid is not None:
            settings = self.load_app_settings() or {}
            settings["default_questionnaire_id"] = default_qid
            self.save_app_settings(settings)

        return {
            "templates": len(templates),
            "summary_prompts": len(summary_prompts),
            "followup_prompts": len(followup_prompts),
        }

    # ------------------------------------------------------------------
    # ユーザー管理
    # ------------------------------------------------------------------

    def get_user_by_username(self, *args, **kwargs):
        self._ensure_client()
        if not args:
            raise ValueError("username is required")
        username = str(args[0])
        snapshot = self._user_ref(username).get()
        if not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        if data.get("totp_secret"):
            try:
                data["totp_secret"] = fernet.decrypt(data["totp_secret"].encode()).decode()
            except InvalidToken:
                pass
        data.setdefault("username", username)
        return data

    def update_password(self, *args, **kwargs):
        self._ensure_client()
        if len(args) < 2:
            raise ValueError("username and new_password are required")
        username = str(args[0])
        new_password = str(args[1])
        hashed_password = pwd_context.hash(new_password)
        now = datetime.now(UTC).isoformat()
        self._user_ref(username).set(
            {
                "username": username,
                "hashed_password": hashed_password,
                "is_initial_password": False,
                "password_updated_at": now,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        logging.getLogger("security").warning(
            "password_update username=%s backend=firestore", username
        )
        self._write_audit_event("password_update", username=username)

    def verify_password(self, plain_password: str, hashed_password: str) -> bool:
        return pwd_context.verify(plain_password, hashed_password)

    def update_totp_secret(self, *args, **kwargs):
        self._ensure_client()
        if len(args) < 2:
            raise ValueError("username and secret are required")
        username = str(args[0])
        secret = str(args[1])
        encrypted = fernet.encrypt(secret.encode()).decode()
        now = datetime.now(UTC).isoformat()
        self._user_ref(username).set(
            {
                "totp_secret": encrypted,
                "totp_changed_at": now,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        logging.getLogger("security").warning(
            "totp_secret_updated username=%s backend=firestore", username
        )
        self._write_audit_event("totp_secret_update", username=username)

    def set_totp_status(self, username: str, enabled: bool, *args, **kwargs) -> None:
        self._ensure_client()
        clear_secret = kwargs.get("clear_secret", False)
        now = datetime.now(UTC).isoformat()
        ref = self._user_ref(username)
        doc = ref.get()
        data = doc.to_dict() if doc.exists else {}
        mode = data.get("totp_mode", "off")
        updates: dict[str, Any] = {
            "totp_changed_at": now,
            "is_totp_enabled": bool(enabled),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        if enabled:
            updates["totp_mode"] = mode if mode and mode != "off" else "login_and_reset"
        else:
            updates["totp_mode"] = "off"
            if clear_secret:
                updates["totp_secret"] = None
        ref.set(updates, merge=True)
        logging.getLogger("security").warning(
            "totp_status_changed username=%s enabled=%s backend=firestore",
            username,
            bool(enabled),
        )
        self._write_audit_event("totp_status_change", username=username, note=str(bool(enabled)))

    def get_totp_mode(self, username: str, *args, **kwargs) -> str:
        self._ensure_client()
        doc = self._user_ref(username).get()
        if not doc.exists:
            return "off"
        data = doc.to_dict() or {}
        secret = data.get("totp_secret")
        if not secret:
            return "off"
        mode = str(data.get("totp_mode") or "off")
        if mode in {"off", "reset_only", "login_and_reset"}:
            return mode
        return "login_and_reset" if data.get("is_totp_enabled") else "off"

    def set_totp_mode(self, username: str, mode: str, *args, **kwargs) -> None:
        self._ensure_client()
        if mode not in {"off", "reset_only", "login_and_reset"}:
            raise ValueError("invalid totp mode")
        now = datetime.now(UTC).isoformat()
        updates = {
            "totp_mode": mode,
            "totp_changed_at": now,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        if mode == "off":
            updates["is_totp_enabled"] = False
        self._user_ref(username).set(updates, merge=True)
        self._write_audit_event("totp_mode_change", username=username, note=mode)

    def export_sessions_data(self, *args, **kwargs):
        self._not_implemented("export_sessions_data")

    def import_sessions_data(self, *args, **kwargs):
        self._not_implemented("import_sessions_data")

    def list_audit_logs(self, *args, **kwargs):
        self._ensure_client()
        limit = int(kwargs.get("limit", 100) or 100)
        limit = max(1, min(limit, 500))
        query = self._audit_collection().order_by("createdAt", direction=firestore.Query.DESCENDING).limit(limit)
        entries = []
        for snapshot in query.stream():
            data = snapshot.to_dict() or {}
            created_at = data.get("createdAt")
            iso = _to_iso(created_at) or _to_iso(data.get("ts"))
            entries.append(
                {
                    "ts": iso,
                    "event": data.get("event"),
                    "username": data.get("username"),
                    "note": data.get("note"),
                }
            )
        return entries

    def shutdown(self) -> None:
        self._client = None


__all__ = ["FirestoreAdapter"]
