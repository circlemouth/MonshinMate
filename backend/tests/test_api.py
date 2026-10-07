from pathlib import Path
import sys
import base64
import logging
import hashlib
import json
from datetime import UTC, datetime
from types import SimpleNamespace

sys.path.append(str(Path(__file__).resolve().parents[1]))

import app.main as main_module  # type: ignore[import]
from app.main import (  # type: ignore[import]
    PATIENT_SUMMARY_RATE_LIMIT,
    SessionCreateRequest,
    _find_latest_finalized_session,
    app,
    create_session,
    llm_gateway,
    on_startup,
    sessions,
)
from app.db import (
    get_session as db_get_session,
    load_app_settings,
    load_llm_settings,
    save_app_settings,
    save_session,
)
from app.llm_gateway import DEFAULT_FOLLOWUP_PROMPT
from fastapi.testclient import TestClient
import pytest

from app import admin_security, db, patient_security
from app.db.sqlite_adapter import SQLiteAdapter
from security_support import bootstrap_admin_headers


client = TestClient(app)
_admin_credentials: tuple[object, dict, dict[str, str]] | None = None


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    """各テストで資格情報・レート制限・患者データを新しいDBへ隔離する。"""
    global _admin_credentials
    adapter = SQLiteAdapter(str(tmp_path / "synthetic.sqlite3"))
    adapter.init()
    monkeypatch.setattr(db, "_adapter", adapter)
    monkeypatch.setattr(llm_gateway, "settings", main_module.default_llm_settings.model_copy(deep=True))
    sessions.clear()
    _admin_credentials = None
    yield adapter
    sessions.clear()
    _admin_credentials = None


def _admin_headers() -> dict[str, str]:
    """同じDB・同じ有効なアカウントの実MFA tokenだけを再利用する。"""
    global _admin_credentials
    account = admin_security.account()
    if _admin_credentials is not None:
        adapter, cached_account, headers = _admin_credentials
        if adapter is db._adapter and cached_account == account:
            response = client.get("/admin/auth/status", headers=headers)
            if response.status_code == 200 and response.json().get("is_authenticated"):
                return headers
    headers = bootstrap_admin_headers(client)
    _admin_credentials = (db._adapter, admin_security.account(), headers)
    return headers


def _patient_headers(created) -> dict[str, str]:
    assert created.status_code == 200, created.text
    data = created.json()
    assert data["session_token"]
    assert datetime.fromisoformat(data["expires_at"]) > datetime.now(UTC)
    return {"Authorization": "Bearer " + data["session_token"]}


def _saved_session(session_id: str) -> dict:
    response = client.get(f"/admin/sessions/{session_id}", headers=_admin_headers())
    assert response.status_code == 200, response.text
    return response.json()


def _assert_receipt(response, session_id: str) -> dict:
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert set(receipt) == {"id", "status", "finalized_at"}
    assert receipt["id"] == session_id
    assert receipt["status"] == "finalized"
    assert receipt["finalized_at"]
    return receipt


def test_system_bootstrap_aggregates_settings_with_one_storage_read(monkeypatch) -> None:
    calls = 0

    def load_settings_once() -> dict:
        nonlocal calls
        calls += 1
        return {
            "timezone": "Asia/Tokyo",
            "display_name": "統合表示名",
            "completion_message": "完了しました",
            "entry_message": "受付へお声がけください",
            "theme_color": "#123456",
            "logo_url": "/system-logo/test.png",
            "logo_crop": {"x": 0.1, "y": 0.2, "w": 0.7, "h": 0.6},
            "default_questionnaire_id": "clinic-default",
        }

    monkeypatch.setattr(main_module, "load_app_settings", load_settings_once)

    response = client.get("/system/bootstrap")

    assert response.status_code == 200
    assert calls == 1
    assert response.json() == {
        "timezone": "Asia/Tokyo",
        "display_name": "統合表示名",
        "completion_message": "完了しました",
        "entry_message": "受付へお声がけください",
        "theme_color": "#123456",
        "logo": {
            "url": "/system-logo/test.png",
            "crop": {"x": 0.1, "y": 0.2, "w": 0.7, "h": 0.6},
        },
        "default_questionnaire_id": "clinic-default",
    }


def _create_finalized_patient_summary_session(
    patient_name: str,
    dob: str,
    *,
    visit_type: str = "initial",
    answers: dict | None = None,
) -> str:
    created = create_session(
        SessionCreateRequest(
            patient_name=patient_name,
            dob=dob,
            gender="female",
            visit_type=visit_type,
            answers=answers or {"chief_complaint": "合成テスト回答"},
        )
    )
    session_id = created.id
    session = main_module._get_session(session_id)
    assert session is not None
    session.finalized_at = datetime.now(UTC)
    session.interrupted = False
    session.completion_status = "finalized"
    save_session(session)
    return session_id


def test_patient_summary_requires_exact_normalized_name_and_dob(monkeypatch) -> None:
    monkeypatch.setattr(llm_gateway, "sync_status", lambda **_kwargs: None)
    on_startup()
    api_key = "synthetic-summary-key-20260812"
    settings = load_app_settings() or {}
    settings["patient_summary_api_key_hash"] = hashlib.sha256(api_key.encode()).hexdigest()
    save_app_settings(settings)
    session_id = _create_finalized_patient_summary_session(
        "統合試験 花子", "1990-02-03"
    )

    partial = client.post(
        "/patient-summary",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={"patient_name": "統合試験", "dob": "1990-02-03"},
    )
    assert partial.status_code == 404

    exact = client.post(
        "/patient-summary",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={"patient_name": "統合試験花子", "dob": "1990/02/03"},
    )
    assert exact.status_code == 200
    assert exact.json()["session_id"] == session_id


def test_patient_summary_finds_exact_name_beyond_recent_partial_matches(monkeypatch) -> None:
    monkeypatch.setattr(llm_gateway, "sync_status", lambda **_kwargs: None)
    on_startup()
    api_key = "synthetic-summary-key-many-partial-matches"
    settings = load_app_settings() or {}
    settings["patient_summary_api_key_hash"] = hashlib.sha256(api_key.encode()).hexdigest()
    save_app_settings(settings)
    dob = "1991-04-05"
    expected_session_id = _create_finalized_patient_summary_session("検索試験", dob)

    for index in range(26):
        _create_finalized_patient_summary_session(f"検索試験 {index:02d}", dob)

    session = _find_latest_finalized_session("検索試験", dob)

    assert session is not None
    assert session["id"] == expected_session_id


def test_patient_summary_invalid_auth_log_contains_no_request_pii(caplog) -> None:
    patient_name = "ログ非記録 合成患者"
    dob = "1988-07-06"
    invalid_key = "invalid-synthetic-key"
    caplog.set_level(logging.WARNING)

    response = client.post(
        "/patient-summary",
        headers={"X-MonshinMate-Api-Key": invalid_key},
        json={"patient_name": patient_name, "dob": dob},
    )

    assert response.status_code == 401
    combined = "\n".join(record.getMessage() for record in caplog.records)
    assert "patient_summary_invalid_api_key" in combined
    assert patient_name not in combined
    assert dob not in combined
    assert invalid_key not in combined


def test_invalid_patient_summary_auth_does_not_exhaust_valid_request_rate_limit() -> None:
    api_key = "synthetic-summary-key-after-invalid-burst"
    settings = load_app_settings() or {}
    settings["patient_summary_api_key_hash"] = hashlib.sha256(api_key.encode()).hexdigest()
    save_app_settings(settings)
    # 永続レート制限の状態は isolated_storage がテストごとに初期化する。
    for _ in range(PATIENT_SUMMARY_RATE_LIMIT + 1):
        invalid = client.post(
            "/patient-summary",
            headers={"X-MonshinMate-Api-Key": "invalid-synthetic-key"},
            json={"patient_name": "合成 該当なし", "dob": "1900-01-01"},
        )
        assert invalid.status_code == 401

    valid = client.post(
        "/patient-summary",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={"patient_name": "合成 該当なし", "dob": "1900-01-01"},
    )
    assert valid.status_code == 404


def test_patient_summary_rate_limit_survives_adapter_recreation(isolated_storage, monkeypatch) -> None:
    api_key = "synthetic-persistent-rate-key"
    save_app_settings({"patient_summary_api_key_hash": hashlib.sha256(api_key.encode()).hexdigest()})
    now = [1_800_000_000.0]
    monkeypatch.setattr(patient_security, "time", SimpleNamespace(time=lambda: now[0]))
    for _ in range(PATIENT_SUMMARY_RATE_LIMIT):
        response = client.post("/patient-summary", headers={"X-MonshinMate-Api-Key": api_key},
                               json={"patient_name": "該当なし", "dob": "2000-01-01"})
        assert response.status_code == 404
    reloaded = SQLiteAdapter(isolated_storage.default_db_path)
    reloaded.init()
    monkeypatch.setattr(db, "_adapter", reloaded)
    limited = client.post("/patient-summary", headers={"X-MonshinMate-Api-Key": api_key},
                          json={"patient_name": "該当なし", "dob": "2000-01-01"})
    assert limited.status_code == 429
    now[0] += main_module.PATIENT_SUMMARY_RATE_WINDOW_SECONDS
    resumed = client.post("/patient-summary", headers={"X-MonshinMate-Api-Key": api_key},
                          json={"patient_name": "該当なし", "dob": "2000-01-01"})
    assert resumed.status_code == 404


def test_patient_summary_api_key_write_route_is_not_public() -> None:
    response = client.put(
        "/system/patient-summary-api-key",
        json={"api_key": "synthetic-summary-key-should-not-be-set"},
    )
    assert response.status_code == 401
    authorized = client.put(
        "/system/patient-summary-api-key", headers=_admin_headers(),
        json={"api_key": "synthetic-summary-key-should-not-be-set"},
    )
    assert authorized.status_code == 404
    assert not (load_app_settings() or {}).get("patient_summary_api_key_hash")


def test_patient_summaries_pages_finalized_exact_identity_and_personal_info(monkeypatch) -> None:
    monkeypatch.setattr(llm_gateway, "sync_status", lambda **_kwargs: None)
    def synthetic_postal_lookup(postal_code):
        assert postal_code == "1000001"
        return {"candidates": [{"prefecture": "東京都", "city": "千代田区", "town": "千代田"}]}
    monkeypatch.setattr(main_module, "lookup_postal_code", synthetic_postal_lookup)
    on_startup()
    api_key = "synthetic-history-key-20260830"
    settings = load_app_settings() or {}
    settings["patient_summary_api_key_hash"] = hashlib.sha256(api_key.encode()).hexdigest()
    save_app_settings(settings)
    patient_name = "履歴試験 花子"
    dob = "1992-03-04"
    first_id = _create_finalized_patient_summary_session(
        patient_name,
        dob,
        answers={
            "personal_info": {
                "kana": "リレキシケン ハナコ",
                "postal_code": "1000001",
                "address": "東京都千代田区千代田1-1",
                "phone": "0312345678",
            },
            "chief_complaint": "1回目",
        },
    )
    second_id = _create_finalized_patient_summary_session(patient_name, dob)
    first_session = main_module._get_session(first_id)
    second_session = main_module._get_session(second_id)
    first_session.finalized_at = datetime(2026, 8, 29, tzinfo=UTC)
    second_session.finalized_at = datetime(2026, 8, 30, tzinfo=UTC)
    save_session(first_session)
    save_session(second_session)
    _create_finalized_patient_summary_session("履歴試験 花子別人", dob)

    first_page = client.post(
        "/patient-summaries",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={"patient_name": "履歴試験花子", "dob": "1992/03/04", "limit": 1},
    )

    assert first_page.status_code == 200
    first_data = first_page.json()
    assert first_data["items"][0]["session_id"] == second_id
    assert first_data["next_cursor"] == second_id

    inserted_id = _create_finalized_patient_summary_session(patient_name, dob)
    inserted_session = main_module._get_session(inserted_id)
    inserted_session.finalized_at = datetime(2026, 8, 31, tzinfo=UTC)
    save_session(inserted_session)

    second_page = client.post(
        "/patient-summaries",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={
            "patient_name": patient_name,
            "dob": dob,
            "limit": 1,
            "cursor": first_data["next_cursor"],
        },
    )
    assert second_page.status_code == 200
    second_data = second_page.json()
    assert second_data["items"][0]["session_id"] == first_id
    assert second_data["items"][0]["personal_info"] == {
        "kana": "リレキシケン ハナコ",
        "postal_code": "1000001",
        "address": "東京都千代田区千代田1-1",
        "phone": "0312345678",
        "address_parts": {
            "prefecture": "東京都",
            "city": "千代田区",
            "town": "千代田",
        },
    }
    assert second_data["next_cursor"] is None

    unauthorized = client.post(
        "/patient-summaries",
        json={"patient_name": patient_name, "dob": dob, "limit": 20},
    )
    assert unauthorized.status_code == 401

    invalid_cursor = client.post(
        "/patient-summaries",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={"patient_name": patient_name, "dob": dob, "limit": 20, "cursor": "invalid"},
    )
    assert invalid_cursor.status_code == 400


def test_patient_summary_pdf_requires_owned_finalized_initial_session(monkeypatch) -> None:
    monkeypatch.setattr(llm_gateway, "sync_status", lambda **_kwargs: None)
    on_startup()
    api_key = "synthetic-pdf-key-20260830"
    settings = load_app_settings() or {}
    settings["patient_summary_api_key_hash"] = hashlib.sha256(api_key.encode()).hexdigest()
    save_app_settings(settings)
    session_id = _create_finalized_patient_summary_session("PDF試験 太郎", "1980-01-02")

    response = client.post(
        "/patient-summary/pdf",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={"patient_name": "PDF試験太郎", "dob": "1980/01/02", "session_id": session_id},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-disposition"].startswith("attachment; filename*=UTF-8''")
    assert response.content.startswith(b"%PDF-")

    unauthorized = client.post(
        "/patient-summary/pdf",
        json={"patient_name": "PDF試験 太郎", "dob": "1980-01-02", "session_id": session_id},
    )
    assert unauthorized.status_code == 401

    wrong_patient = client.post(
        "/patient-summary/pdf",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={"patient_name": "別人", "dob": "1980-01-02", "session_id": session_id},
    )
    assert wrong_patient.status_code == 404

    followup_id = _create_finalized_patient_summary_session(
        "PDF試験 太郎", "1980-01-02", visit_type="followup"
    )
    followup = client.post(
        "/patient-summary/pdf",
        headers={"X-MonshinMate-Api-Key": api_key},
        json={"patient_name": "PDF試験 太郎", "dob": "1980-01-02", "session_id": followup_id},
    )
    assert followup.status_code == 404


def test_get_questionnaire_template() -> None:
    """テンプレート取得エンドポイントが固定データを返すことを確認する。"""
    on_startup()
    res = client.get("/questionnaires/sample/template?visit_type=initial")
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == "sample"
    assert any(item["id"] == "chief_complaint" for item in data["items"])


def test_default_template_contains_items() -> None:
    """デフォルトテンプレートに必要な項目が含まれることを確認する。"""
    on_startup()
    res = client.get("/questionnaires/default/template?visit_type=initial")
    assert res.status_code == 200
    ids = {item["id"] for item in res.json()["items"]}
    expected = {
        "personal_info",
        "chief_complaint",
        "symptom_location",
        "onset",
        "pregnancy",
        "breastfeeding",
    }
    assert expected.issubset(ids)


def test_llm_chat() -> None:
    """チャットエンドポイントが応答を返すことを確認する。"""
    on_startup()
    assert client.post("/llm/chat", json={"message": "こんにちは"}).status_code == 401
    res = client.post(
        "/llm/chat", json={"message": "こんにちは"}, headers=_admin_headers()
    )
    assert res.status_code == 200
    assert res.json()["reply"].startswith("LLM応答")


def test_llm_settings_get_and_update(monkeypatch) -> None:
    """明示的に許可したローカル環境でプロバイダ別設定を保持する。"""
    monkeypatch.setenv("MONSHINMATE_ENV", "local")
    monkeypatch.setenv("MONSHINMATE_ALLOW_LOCAL_LLM", "1")
    on_startup()
    profiles = {
        "ollama": {
            "model": "llama2",
            "temperature": 0.2,
            "system_prompt": "",
            "base_url": "http://localhost:11434",
            "api_key": "",
            "followup_timeout_seconds": 30,
        },
        "lm_studio": {
            "model": "",
            "temperature": 0.2,
            "system_prompt": "",
            "base_url": "http://localhost:1234",
            "api_key": "",
            "followup_timeout_seconds": 30,
        },
        "openai": {
            "model": "",
            "temperature": 0.2,
            "system_prompt": "",
            "base_url": "https://api.openai.com",
            "api_key": "",
            "followup_timeout_seconds": 30,
        },
    }

    res = client.put(
        "/llm/settings",
        headers=_admin_headers(),
        json={
            "provider": "ollama",
            "enabled": True,
            **profiles["ollama"],
            "provider_profiles": profiles,
        },
    )
    assert res.status_code == 200
    res = client.get("/llm/settings", headers=_admin_headers())
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "ollama"
    assert data["enabled"] is True
    assert data["provider_profiles"]["ollama"]["model"] == "llama2"
    assert data["followup_timeout_seconds"] == 30
    assert data["provider_profiles"]["ollama"]["followup_timeout_seconds"] == 30

    profiles["lm_studio"] = {
        "model": "test-model",
        "temperature": 0.5,
        "system_prompt": "test",
        "base_url": "http://localhost:1234",
        "api_key": "",
        "followup_timeout_seconds": 45,
    }
    res = client.put(
        "/llm/settings",
        headers=_admin_headers(),
        json={
            "provider": "lm_studio",
            "enabled": True,
            **profiles["lm_studio"],
            "provider_profiles": profiles,
        },
    )
    assert res.status_code == 200
    res = client.get("/llm/settings", headers=_admin_headers())
    updated = res.json()
    assert updated["provider"] == "lm_studio"
    assert updated["enabled"] is True
    assert updated["provider_profiles"]["ollama"]["model"] == "llama2"
    assert updated["provider_profiles"]["lm_studio"]["model"] == "test-model"
    assert updated["provider_profiles"]["ollama"]["followup_timeout_seconds"] == 30
    assert updated["followup_timeout_seconds"] == 45
    assert updated["provider_profiles"]["lm_studio"]["followup_timeout_seconds"] == 45
    chat_res = client.post(
        "/llm/chat", json={"message": "hi"}, headers=_admin_headers()
    )
    assert chat_res.json()["reply"].startswith("LLM応答[lm_studio:test-model")

    # OpenAI 互換エンドポイントに切り替え、プロバイダごとの設定保持を確認
    profiles["openai"] = {
        "model": "gpt-4.1-mini",
        "temperature": 0.3,
        "system_prompt": "openai",
        "base_url": "https://api.openai.com",
        "api_key": "sk-test",
        "followup_timeout_seconds": 60,
    }
    res = client.put(
        "/llm/settings",
        headers=_admin_headers(),
        json={
            "provider": "openai",
            "enabled": True,
            **profiles["openai"],
            "provider_profiles": profiles,
        },
    )
    assert res.status_code == 200
    res = client.get("/llm/settings", headers=_admin_headers())
    openai_settings = res.json()
    assert openai_settings["provider"] == "openai"
    assert openai_settings["model"] == "gpt-4.1-mini"
    assert openai_settings["base_url"] == "https://api.openai.com"
    assert openai_settings["provider_profiles"]["ollama"]["model"] == "llama2"
    assert openai_settings["provider_profiles"]["lm_studio"]["model"] == "test-model"
    assert "api_key" not in openai_settings
    assert "api_key" not in openai_settings["provider_profiles"]["openai"]
    assert openai_settings["api_key_configured"] is True
    assert openai_settings["provider_profiles"]["openai"]["api_key_configured"] is True
    assert openai_settings["followup_timeout_seconds"] == 60
    assert openai_settings["provider_profiles"]["ollama"]["followup_timeout_seconds"] == 30
    assert openai_settings["provider_profiles"]["lm_studio"]["followup_timeout_seconds"] == 45
    assert openai_settings["provider_profiles"]["openai"]["followup_timeout_seconds"] == 60
    stored_settings = load_llm_settings() or {}
    assert stored_settings.get("api_key") == "sk-test"
    openai_chat = client.post(
        "/llm/chat", json={"message": "hello"}, headers=_admin_headers()
    )
    assert openai_chat.json()["reply"].startswith("LLM応答[openai:gpt-4.1-mini")

    # provider切替時はOpenAI keyをOpenAI profileに残しつつ、
    # GCPのトップレベル設定へ混入させない。
    profiles["gcp_vertex"] = {
        "model": "gemini-3.1-flash-lite",
        "temperature": 0.2,
        "system_prompt": "",
        "project_id": "synthetic-project",
        "location": "global",
        "max_output_tokens": 8192,
        "followup_timeout_seconds": 30,
    }
    switched = client.put(
        "/llm/settings",
        headers=_admin_headers(),
        json={
            "provider": "gcp_vertex",
            "enabled": True,
            **profiles["gcp_vertex"],
            "provider_profiles": profiles,
        },
    )
    assert switched.status_code == 200
    switched_storage = load_llm_settings() or {}
    assert not switched_storage.get("api_key")
    assert (
        switched_storage["provider_profiles"]["openai"]["api_key"] == "sk-test"
    )
    assert not switched_storage["provider_profiles"]["gcp_vertex"].get("api_key")


def test_llm_configuration_endpoints_require_admin_authentication() -> None:
    settings_payload = {
        "provider": "ollama",
        "model": "llama2",
        "temperature": 0.2,
        "system_prompt": "",
        "enabled": False,
    }

    assert client.get("/llm/settings").status_code == 401
    assert client.put("/llm/settings", json=settings_payload).status_code == 401
    assert client.post("/llm/settings/test").status_code == 401
    assert client.post(
        "/llm/list-models", json={"provider": "ollama"}
    ).status_code == 401
    assert client.get("/llm/providers").status_code == 401
    assert client.get("/system/llm-status").status_code == 401
    providers = client.get("/llm/providers", headers=_admin_headers())
    assert providers.status_code == 200
    assert all("api_key" not in item["default_profile"] for item in providers.json())


def test_llm_settings_test_endpoint() -> None:
    """疎通テストエンドポイントがステータスを返すことを確認する。"""
    on_startup()
    assert client.post("/llm/settings/test").status_code == 401
    res = client.post("/llm/settings/test", headers=_admin_headers())
    assert res.status_code == 200
    assert res.json()["status"] == "ng"


def test_llm_settings_response_and_storage_exclude_secret_fields(caplog) -> None:
    on_startup()
    caplog.set_level(logging.INFO)
    secrets = {
        "service_account_json": "SYNTHETIC_SERVICE_ACCOUNT_JSON",
        "future_private_key": "SYNTHETIC_FUTURE_PRIVATE_KEY",
        "future_secret_key": "SYNTHETIC_FUTURE_SECRET_KEY",
        "auth_token": "SYNTHETIC_AUTH_TOKEN",
        "id_token": "SYNTHETIC_ID_TOKEN",
    }
    payload = {
        "provider": "gcp_vertex",
        "model": "gemini-3.1-flash-lite",
        "temperature": 0.2,
        "system_prompt": "",
        "enabled": True,
        "followup_timeout_seconds": 30,
        "provider_profiles": {
            "gcp_vertex": {
                "model": "gemini-3.1-flash-lite",
                "project_id": "synthetic-project",
                "location": "global",
                **secrets,
            }
        },
    }

    response = client.put(
        "/llm/settings", json=payload, headers=_admin_headers()
    )

    assert response.status_code == 200
    serialized_response = response.text
    serialized_storage = json.dumps(load_llm_settings(), ensure_ascii=False)
    for field, secret in secrets.items():
        assert field not in serialized_response
        assert secret not in serialized_response
        assert field not in serialized_storage
        assert secret not in serialized_storage
        assert secret not in caplog.text


def test_llm_settings_test_with_body() -> None:
    """疎通テストでリクエストの設定が利用されることを確認する。"""
    on_startup()
    payload = {"provider": "ollama", "model": "dummy", "enabled": True}
    res = client.post(
        "/llm/settings/test", json=payload, headers=_admin_headers()
    )
    assert res.status_code == 200
    assert res.json()["status"] == "ng"


def test_llm_status_snapshot_endpoint() -> None:
    """LLM 状態スナップショットが取得できる。"""
    on_startup()
    assert client.get("/system/llm-status").status_code == 401
    assert client.get("/system/llm-availability").status_code == 200
    res = client.get("/system/llm-status", headers=_admin_headers())
    assert res.status_code == 200
    data = res.json()
    assert data["status"] in {"disabled", "pending", "ng", "ok"}


def test_llm_status_updates_after_settings_change(monkeypatch) -> None:
    """設定保存は通信せず、明示的な疎通テストだけで状態を更新する。"""
    on_startup()
    calls = []
    def failed_connection(*, source="manual_test"):
        calls.append(source)
        llm_gateway._record_status("ng", source, "synthetic connection failure")
        return {"status": "ng", "detail": "synthetic connection failure"}
    monkeypatch.setattr(llm_gateway, "test_connection", failed_connection)
    monkeypatch.setattr(llm_gateway, "_last_status", {"status": "disabled", "checked_at": None})
    payload = {
        "provider": "ollama",
        "model": "test-model",
        "temperature": 0.2,
        "system_prompt": "",
        "enabled": True,
        "base_url": "http://127.0.0.1:9",
    }
    denied = client.put("/llm/settings", json=payload, headers=_admin_headers())
    assert denied.status_code == 400
    assert denied.json()["detail"] == "llm_destination_not_allowed"
    assert load_llm_settings() is None
    monkeypatch.setenv("MONSHINMATE_ENV", "local")
    monkeypatch.setenv("MONSHINMATE_ALLOW_LOCAL_LLM", "1")
    res = client.put("/llm/settings", json=payload, headers=_admin_headers())
    assert res.status_code == 200
    snapshot = client.get("/system/llm-status", headers=_admin_headers()).json()
    assert snapshot["status"] == "pending"
    assert snapshot.get("checked_at") is None
    assert calls == []
    client.post("/llm/settings/test", headers=_admin_headers())
    snapshot_after = client.get(
        "/system/llm-status", headers=_admin_headers()
    ).json()
    assert snapshot_after["status"] in {"ng", "disabled", "ok"}
    assert snapshot_after.get("checked_at") is not None
    assert len(calls) == 1


def test_create_session() -> None:
    """セッション作成が行われ ID が発行されることを確認する。"""
    on_startup()
    payload = {
        "patient_name": "山田太郎",
        "dob": "1990-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {
            "chief_complaint": "頭痛",
            "personal_info": {
                "name": " 山田太郎 ",
                "kana": "やまだたろう",
                "postal_code": "123-4567 ",
                "address": "東京都新宿区1-2-3",
                "phone": "03-1234-5678",
            },
        },
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["answers"]["chief_complaint"] == "頭痛"
    assert data["questionnaire_id"]
    expected_personal_info = {
        "name": "山田太郎",
        "kana": "やまだたろう",
        "postal_code": "123-4567",
        "address": "東京都新宿区1-2-3",
        "phone": "03-1234-5678",
    }
    assert data["answers"]["personal_info"] == expected_personal_info
    assert "id" in data
    assert data["status"] == "created"
    session_id = data["id"]
    stored = db_get_session(session_id)
    assert stored is not None
    assert stored["answers"].get("personal_info") == expected_personal_info
    assert stored["questionnaire_id"] == data["questionnaire_id"]

    # 追加質問の取得と回答
    q_res = client.post(f"/sessions/{session_id}/llm-questions", headers=_patient_headers(res))
    assert q_res.status_code == 200
    q_data = q_res.json()
    assert q_data["questions"] == []


def test_initial_session_marks_personal_info_complete() -> None:
    """初診セッションでは個人情報が残タスクにならないことを確認する。"""
    on_startup()
    payload = {
        "patient_name": "山田太郎",
        "dob": "1990-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {
            "personal_info": {
                "name": "山田太郎",
                "kana": "やまだたろう",
                "postal_code": "123-4567",
                "address": "東京都新宿区1-2-3",
                "phone": "03-1234-5678",
            }
        },
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    data = res.json()
    # 返却された回答に personal_info が保存され、欠落項目扱いになっていないことを確認
    assert "personal_info" in data["answers"]
    assert data["answers"]["personal_info"]["kana"] == "やまだたろう"
    assert "personal_info" not in data["remaining_items"]


def test_upload_and_delete_question_item_image(tmp_path) -> None:
    """問診項目画像のアップロードと削除ができる。"""
    on_startup()
    png_b64 = (
        b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII="
    )
    data = base64.b64decode(png_b64)
    res = client.post(
        "/questionnaire-item-images", headers=_admin_headers(),
        files={"file": ("test.png", data, "image/png")},
    )
    assert res.status_code == 200
    url = res.json()["url"]
    get_res = client.get(url)
    assert get_res.status_code == 200
    filename = url.split("/")[-1]
    del_res = client.delete(f"/questionnaire-item-images/{filename}", headers=_admin_headers())
    assert del_res.status_code == 200
    after = client.get(url)
    assert after.status_code == 404


def test_add_answers() -> None:
    """複数回答の保存ができることを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "佐藤花子",
        "dob": "1985-05-05",
        "gender": "female",
        "visit_type": "initial",
        "answers": {},
    }
    res = client.post("/sessions", json=create_payload)
    assert res.status_code == 200
    session_id = res.json()["id"]

    add_payload = {"answers": {"chief_complaint": "腹痛", "onset": "1週間前から"}}
    add_res = client.post(f"/sessions/{session_id}/answers", headers=_patient_headers(res), json=add_payload)
    assert add_res.status_code == 200
    assert add_res.json()["status"] == "ok"

    finalize_res = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    assert finalize_res.status_code == 200
    data = finalize_res.json()
    assert data["status"] == "finalized"
    assert "finalized_at" in data and data["finalized_at"]
    _assert_receipt(finalize_res, session_id)
    ans = _saved_session(session_id)["answers"]
    assert ans["chief_complaint"] == "腹痛"
    assert ans["onset"] == ["1週間前から"]


def test_finalize_with_summary_enabled() -> None:
    """サマリー作成モード有効時に要約が生成されることを確認する。"""
    on_startup()
    # サマリー作成を有効化
    client.post(
        "/questionnaires/default/summary-prompt", headers=_admin_headers(),
        json={"visit_type": "initial", "prompt": "", "enabled": True},
    )
    payload = {
        "patient_name": "佐藤健",
        "dob": "1992-03-03",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "発熱"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]

    fin = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    assert fin.status_code == 200
    _assert_receipt(fin, session_id)
    assert _saved_session(session_id)["summary"].startswith("要約")


def test_startup_preserves_custom_summary_prompt() -> None:
    """起動時初期化でカスタムプロンプトがリセットされないことを確認する。"""
    on_startup()
    custom_summary = "カスタムサマリー"
    custom_followup = "カスタム追質問"
    res = client.post(
        "/questionnaires/default/summary-prompt", headers=_admin_headers(),
        json={"visit_type": "initial", "prompt": custom_summary, "enabled": True},
    )
    assert res.status_code == 200
    res = client.post(
        "/questionnaires/default/followup-prompt", headers=_admin_headers(),
        json={"visit_type": "initial", "prompt": custom_followup, "enabled": True},
    )
    assert res.status_code == 200

    # on_startup を再実行（=アプリ再起動相当）しても上書きされないことを検証
    on_startup()

    summary_cfg = client.get(
        "/questionnaires/default/summary-prompt?visit_type=initial", headers=_admin_headers()
    )
    followup_cfg = client.get(
        "/questionnaires/default/followup-prompt?visit_type=initial", headers=_admin_headers()
    )
    assert summary_cfg.status_code == 200
    assert followup_cfg.status_code == 200

    assert summary_cfg.json()["prompt"] == custom_summary
    assert summary_cfg.json()["enabled"] is True
    assert followup_cfg.json()["prompt"] == custom_followup
    assert followup_cfg.json()["enabled"] is True


def test_blank_answer_saved_as_not_applicable() -> None:
    """空欄回答が「該当なし」として保存されることを確認する。"""
    on_startup()
    payload = {
        "patient_name": "空欄太郎",
        "dob": "1999-09-09",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": ""},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    data = res.json()
    session_id = data["id"]
    assert data["answers"]["chief_complaint"] == "該当なし"

    finalize_res = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    assert finalize_res.status_code == 200
    _assert_receipt(finalize_res, session_id)
    assert _saved_session(session_id)["answers"]["chief_complaint"] == "該当なし"

def test_llm_question_loop() -> None:
    """追加質問エンドポイントが順次質問を返すことを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "テスト太郎",
        "dob": "2000-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=create_payload)
    session_id = res.json()["id"]
    q_list = client.post(f"/sessions/{session_id}/llm-questions", headers=_patient_headers(res)).json()["questions"]
    assert q_list == []
    fin = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    assert fin.status_code == 200


def test_followup_session_flow() -> None:
    """再診テンプレートでもセッションが完了することを確認する。"""
    on_startup()
    payload = {
        "patient_name": "再診太郎",
        "dob": "1995-12-12",
        "gender": "male",
        "visit_type": "followup",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]
    q_res = client.post(f"/sessions/{session_id}/llm-questions", headers=_patient_headers(res))
    assert q_res.status_code == 200
    assert q_res.json()["questions"] == []
    fin = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    assert fin.status_code == 200
    assert fin.json()["status"] == "finalized"


def test_llm_disabled() -> None:
    """LLM 無効設定時は追加質問を行わないことを確認する。"""
    on_startup()
    # LLM を無効化
    client.put(
        "/llm/settings",
        json={"provider": "ollama", "model": "llama2", "temperature": 0.2, "system_prompt": "", "enabled": False},
        headers=_admin_headers(),
    )
    payload = {
        "patient_name": "無効太郎",
        "dob": "1990-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=payload)
    session_id = res.json()["id"]
    q_res = client.post(f"/sessions/{session_id}/llm-questions", headers=_patient_headers(res))
    assert q_res.status_code == 200
    assert q_res.json()["questions"] == []
    # 設定の後片付けはテスト単位の隔離fixtureで行う。


def test_admin_session_list_and_detail() -> None:
    """管理用セッション一覧と詳細取得を確認する。"""
    on_startup()
    payload = {
        "patient_name": "一覧太郎",
        "dob": "1980-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "発熱"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]
    fin = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    assert fin.status_code == 200

    list_res = client.get("/admin/sessions", headers=_admin_headers())
    assert list_res.status_code == 200
    sessions = list_res.json()
    assert any(s["id"] == session_id for s in sessions)

    detail_res = client.get(f"/admin/sessions/{session_id}", headers=_admin_headers())
    assert detail_res.status_code == 200
    detail = detail_res.json()
    assert detail["patient_name"] == "一覧太郎"
    assert detail["answers"]["chief_complaint"] == "発熱"


def test_admin_session_search_filters() -> None:
    """セッション一覧APIの検索フィルタを確認する。"""
    on_startup()
    payload = {
        "patient_name": "検索花子",
        "dob": "1990-12-31",
        "gender": "female",
        "visit_type": "followup",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]
    fin = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    assert fin.status_code == 200

    # 正常にヒットする検索
    list_res = client.get(
        "/admin/sessions", headers=_admin_headers(),
        params={
            "patient_name": "検索",
            "dob": "1990-12-31",
            "start_date": fin.json()["finalized_at"][:10],
            "end_date": fin.json()["finalized_at"][:10],
        },
    )
    assert list_res.status_code == 200
    sessions = list_res.json()
    assert any(s["id"] == session_id for s in sessions)

    # 不一致の検索ではヒットしない
    nohit_res = client.get(
        "/admin/sessions", headers=_admin_headers(),
        params={"patient_name": "不存在"},
    )
    assert nohit_res.status_code == 200
    assert all(s["id"] != session_id for s in nohit_res.json())


def test_admin_session_search_ignores_spaces() -> None:
    """患者名検索で空白を除いた部分一致が機能することを確認する。"""
    on_startup()
    payload = {
        "patient_name": "空白 太郎",
        "dob": "1988-03-03",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "咳"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    session_id = res.json()["id"]
    fin = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    assert fin.status_code == 200

    # 全角・半角スペースを取り除いた検索語でも一致する
    list_res = client.get("/admin/sessions", headers=_admin_headers(), params={"patient_name": "空白太郎"})
    assert list_res.status_code == 200
    assert any(s["id"] == session_id for s in list_res.json())

    # 前後の空白を含む検索語でも一致する
    padded_res = client.get("/admin/sessions", headers=_admin_headers(), params={"patient_name": "  空白太郎　"})
    assert padded_res.status_code == 200
    assert any(s["id"] == session_id for s in padded_res.json())


def test_admin_session_download() -> None:
    """問診結果を各形式でダウンロードできることを確認する。"""
    on_startup()
    payload = {
        "patient_name": "出力太郎",
        "dob": "1985-05-05",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "頭痛"},
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    sid = res.json()["id"]
    fin = client.post(f"/sessions/{sid}/finalize", headers=_patient_headers(res))
    assert fin.status_code == 200

    for fmt, ctype in [("md", "text/markdown"), ("csv", "text/csv"), ("pdf", "application/pdf")]:
        r = client.get(f"/admin/sessions/{sid}/download/{fmt}", headers=_admin_headers())
        assert r.status_code == 200
        assert r.headers["content-type"].startswith(ctype)
        assert len(r.content) > 0


def test_markdown_export_formats_personal_info_and_yesno() -> None:
    """Markdown出力で個人情報とYES/NO回答が日本語で整形される。"""

    on_startup()
    payload = {
        "patient_name": "問診 花子",
        "dob": "1992-04-01",
        "gender": "female",
        "visit_type": "initial",
        "answers": {
            "personal_info": {
                "name": "問診 花子",
                "kana": "もんしん はなこ",
                "postal_code": "123-4567",
                "address": "東京都千代田区1-1-1",
                "phone": "090-1234-5678",
            },
            "chief_complaint": "頭痛が続いている",
            "symptom_location": ["頭・顔"],
            "onset": "本日",
            "pregnancy": "yes",
        },
    }
    res = client.post("/sessions", json=payload)
    assert res.status_code == 200
    sid = res.json()["id"]
    finalize = client.post(f"/sessions/{sid}/finalize", headers=_patient_headers(res))
    assert finalize.status_code == 200

    response = client.get(f"/admin/sessions/{sid}/download/md", headers=_admin_headers())
    assert response.status_code == 200
    text = response.text

    assert "- 患者名: 問診 花子" in text
    assert "- よみがな: もんしん はなこ" in text
    assert "- 性別: 女性" in text
    assert "- 受診種別: 初診" in text
    assert "- 郵便番号: 123-4567" in text
    assert "- 住所: 東京都千代田区1-1-1" in text
    assert "- 電話番号: 090-1234-5678" in text
    assert "- 妊娠中ですか？: はい" in text
    assert "- personal_info:" not in text

def test_admin_bulk_download() -> None:
    """複数セッションの一括ダウンロードが各形式で成功することを確認する。"""
    on_startup()
    # セッションを2件作成・確定
    payload1 = {
        "patient_name": "一括太郎1",
        "dob": "1980-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "腹痛"},
    }
    payload2 = {
        "patient_name": "一括太郎2",
        "dob": "1990-02-02",
        "gender": "female",
        "visit_type": "followup",
        "answers": {"chief_complaint": "頭痛"},
    }
    r1 = client.post("/sessions", json=payload1)
    r2 = client.post("/sessions", json=payload2)
    assert r1.status_code == 200 and r2.status_code == 200
    sid1 = r1.json()["id"]
    sid2 = r2.json()["id"]
    assert client.post(f"/sessions/{sid1}/finalize", headers=_patient_headers(r1)).status_code == 200
    assert client.post(f"/sessions/{sid2}/finalize", headers=_patient_headers(r2)).status_code == 200

    # CSV は単一CSVとして返る
    r_csv = client.get("/admin/sessions/bulk/download/csv", headers=_admin_headers(), params=[("ids", sid1), ("ids", sid2)])
    assert r_csv.status_code == 200
    assert r_csv.headers["content-type"].startswith("text/csv")
    assert len(r_csv.content) > 0

    # MD/PDF は ZIP で返る
    for fmt in ("md", "pdf"):
        r_zip = client.get(f"/admin/sessions/bulk/download/{fmt}", headers=_admin_headers(), params=[("ids", sid1), ("ids", sid2)])
        assert r_zip.status_code == 200
        assert r_zip.headers["content-type"].startswith("application/zip")
        assert len(r_zip.content) > 0


def test_pdf_layout_setting_toggle() -> None:
    """PDFレイアウト設定の取得と更新が行える。"""

    on_startup()
    res = client.get("/system/pdf-layout", headers=_admin_headers())
    assert res.status_code == 200
    first = res.json()
    assert first["mode"] in {"structured", "legacy"}

    put_res = client.put("/system/pdf-layout", headers=_admin_headers(), json={"mode": "legacy"})
    assert put_res.status_code == 200
    assert put_res.json()["mode"] == "legacy"

    confirm = client.get("/system/pdf-layout", headers=_admin_headers())
    assert confirm.status_code == 200
    assert confirm.json()["mode"] == "legacy"

    # 他テストに影響を与えないよう既定に戻す
    revert = client.put("/system/pdf-layout", headers=_admin_headers(), json={"mode": "structured"})
    assert revert.status_code == 200
    assert revert.json()["mode"] == "structured"


def test_questionnaire_options() -> None:
    """選択肢付きテンプレートの保存と取得を確認する。"""
    on_startup()
    payload = {
        "id": "opt",
        "visit_type": "initial",
        "items": [
            {
                "id": "color",
                "label": "色",
                "type": "multi",
                "required": True,
                "options": ["red", "blue"],
                "description": "説明",
            },
            {
                "id": "fruits",
                "label": "好きな果物",
                "type": "multi",
                "required": False,
                "options": ["apple", "banana"],
                "allow_freetext": True,
            },
        ],
    }
    res = client.post("/questionnaires", headers=_admin_headers(), json=payload)
    assert res.status_code == 200
    get_res = client.get("/questionnaires/opt/template?visit_type=initial")
    assert get_res.status_code == 200
    data = get_res.json()
    assert data["items"][0]["options"] == ["red", "blue"]
    assert data["items"][0]["description"] == "説明"
    assert data["items"][1]["type"] == "multi"
    assert data["items"][1]["allow_freetext"] is True
    # 後片付け
    del_res = client.delete("/questionnaires/opt?visit_type=initial", headers=_admin_headers())
    assert del_res.status_code == 200


def test_questionnaire_image() -> None:
    """画像付きテンプレートの保存と取得を確認する。"""
    on_startup()
    img = "data:image/png;base64," + base64.b64encode(b"test").decode()
    payload = {
        "id": "img",
        "visit_type": "initial",
        "items": [
            {
                "id": "img_q",
                "label": "画像付き",
                "type": "string",
                "required": False,
                "image": img,
            }
        ],
    }
    res = client.post("/questionnaires", headers=_admin_headers(), json=payload)
    assert res.status_code == 200
    get_res = client.get("/questionnaires/img/template?visit_type=initial")
    assert get_res.status_code == 200
    data = get_res.json()
    assert data["items"][0]["image"] == img
    # 画像を削除して更新
    payload["items"][0]["image"] = None
    res2 = client.post("/questionnaires", headers=_admin_headers(), json=payload)
    assert res2.status_code == 200
    get_res2 = client.get("/questionnaires/img/template?visit_type=initial")
    assert get_res2.status_code == 200
    data2 = get_res2.json()
    assert data2["items"][0].get("image") is None
    del_res = client.delete("/questionnaires/img?visit_type=initial", headers=_admin_headers())
    assert del_res.status_code == 200


def test_questionnaire_when() -> None:
    """表示条件付きテンプレートの保存と取得を確認する。"""
    on_startup()
    payload = {
        "id": "cond",
        "visit_type": "initial",
        "items": [
            {
                "id": "symptom",
                "label": "症状の有無",
                "type": "multi",
                "required": True,
                "options": ["あり", "なし"],
            },
            {
                "id": "detail",
                "label": "詳細",
                "type": "string",
                "required": False,
                "when": {"item_id": "symptom", "equals": "あり"},
            },
        ],
    }
    res = client.post("/questionnaires", headers=_admin_headers(), json=payload)
    assert res.status_code == 200
    get_res = client.get("/questionnaires/cond/template?visit_type=initial")
    assert get_res.status_code == 200
    data = get_res.json()
    assert data["items"][1]["when"]["item_id"] == "symptom"
    # 後片付け
    del_res = client.delete("/questionnaires/cond?visit_type=initial", headers=_admin_headers())
    assert del_res.status_code == 200


def test_questionnaire_gender_filter() -> None:
    """性別指定の問診項目がフィルタされることを確認する。"""
    on_startup()
    payload = {
        "id": "gender_tpl",
        "visit_type": "initial",
        "items": [
            {"id": "common", "label": "共通", "type": "string", "required": True},
            {
                "id": "male_only",
                "label": "男性のみ",
                "type": "string",
                "required": False,
                "gender_enabled": True,
                "gender": "male",
            },
            {
                "id": "female_only",
                "label": "女性のみ",
                "type": "string",
                "required": False,
                "gender_enabled": True,
                "gender": "female",
            },
            {
                "id": "both_item",
                "label": "両方",
                "type": "string",
                "required": False,
                "gender_enabled": True,
                "gender": "both",
            },
        ],
    }
    res = client.post("/questionnaires", headers=_admin_headers(), json=payload)
    assert res.status_code == 200
    male_res = client.get("/questionnaires/gender_tpl/template?visit_type=initial&gender=male")
    female_res = client.get("/questionnaires/gender_tpl/template?visit_type=initial&gender=female")
    assert male_res.status_code == 200 and female_res.status_code == 200
    male_items = [it["id"] for it in male_res.json()["items"]]
    female_items = [it["id"] for it in female_res.json()["items"]]
    assert "male_only" in male_items and "female_only" not in male_items
    assert "female_only" in female_items and "male_only" not in female_items
    # gender 未指定および "both" はどちらにも表示される
    assert "common" in male_items and "common" in female_items
    assert "both_item" in male_items and "both_item" in female_items
    client.delete("/questionnaires/gender_tpl?visit_type=initial", headers=_admin_headers())


def test_questionnaire_age_filter() -> None:
    """年齢指定の問診項目がフィルタされることを確認する。"""
    on_startup()
    payload = {
        "id": "age_tpl",
        "visit_type": "initial",
        "items": [
            {
                "id": "child",
                "label": "小児のみ",
                "type": "string",
                "age_enabled": True,
                "min_age": 0,
                "max_age": 15,
            },
            {
                "id": "adult",
                "label": "成人のみ",
                "type": "string",
                "age_enabled": True,
                "min_age": 20,
            },
            {"id": "all", "label": "全員", "type": "string"},
        ],
    }
    res = client.post("/questionnaires", headers=_admin_headers(), json=payload)
    assert res.status_code == 200
    child_res = client.get("/questionnaires/age_tpl/template?visit_type=initial&age=10")
    adult_res = client.get("/questionnaires/age_tpl/template?visit_type=initial&age=30")
    child_ids = [it["id"] for it in child_res.json()["items"]]
    adult_ids = [it["id"] for it in adult_res.json()["items"]]
    assert "child" in child_ids and "adult" not in child_ids
    assert "adult" in adult_ids and "child" not in adult_ids
    assert "all" in child_ids and "all" in adult_ids
    client.delete("/questionnaires/age_tpl?visit_type=initial", headers=_admin_headers())


def test_duplicate_questionnaire() -> None:
    """テンプレート複製APIが内容を引き継ぐことを確認する。"""
    on_startup()
    src_initial = {
        "id": "dup_src",
        "visit_type": "initial",
        "items": [{"id": "q1", "label": "Q1", "type": "string", "required": True}],
    }
    src_follow = {
        "id": "dup_src",
        "visit_type": "followup",
        "items": [{"id": "q2", "label": "Q2", "type": "string", "required": False}],
    }
    client.post("/questionnaires", headers=_admin_headers(), json=src_initial)
    client.post("/questionnaires", headers=_admin_headers(), json=src_follow)
    client.post(
        "/questionnaires/dup_src/summary-prompt", headers=_admin_headers(),
        json={"visit_type": "initial", "prompt": "init", "enabled": True},
    )
    client.post(
        "/questionnaires/dup_src/summary-prompt", headers=_admin_headers(),
        json={"visit_type": "followup", "prompt": "fup", "enabled": False},
    )

    res = client.post("/questionnaires/dup_src/duplicate", headers=_admin_headers(), json={"new_id": "dup_copy"})
    assert res.status_code == 200

    init_copy = client.get(
        "/questionnaires/dup_copy/template?visit_type=initial"
    ).json()
    follow_copy = client.get(
        "/questionnaires/dup_copy/template?visit_type=followup"
    ).json()
    assert init_copy["items"][0]["label"] == "Q1"
    assert follow_copy["items"][0]["label"] == "Q2"

    init_prompt = client.get(
        "/questionnaires/dup_copy/summary-prompt?visit_type=initial", headers=_admin_headers()
    ).json()
    follow_prompt = client.get(
        "/questionnaires/dup_copy/summary-prompt?visit_type=followup", headers=_admin_headers()
    ).json()
    assert init_prompt["prompt"] == "init" and init_prompt["enabled"] is True
    assert follow_prompt["prompt"] == "fup" and follow_prompt["enabled"] is False
    client.delete("/questionnaires/dup_src?visit_type=initial", headers=_admin_headers())
    client.delete("/questionnaires/dup_src?visit_type=followup", headers=_admin_headers())
    client.delete("/questionnaires/dup_copy?visit_type=initial", headers=_admin_headers())
    client.delete("/questionnaires/dup_copy?visit_type=followup", headers=_admin_headers())


def test_rename_questionnaire_updates_related_data() -> None:
    """テンプレートID変更時に関連情報も更新されることを確認する。"""

    on_startup()
    initial_payload = {
        "id": "rename_src",
        "visit_type": "initial",
        "items": [{"id": "q1", "label": "Q1", "type": "string"}],
    }
    follow_payload = {
        "id": "rename_src",
        "visit_type": "followup",
        "items": [{"id": "q2", "label": "Q2", "type": "string"}],
    }
    client.post("/questionnaires", headers=_admin_headers(), json=initial_payload)
    client.post("/questionnaires", headers=_admin_headers(), json=follow_payload)
    client.post(
        "/questionnaires/rename_src/summary-prompt", headers=_admin_headers(),
        json={"visit_type": "initial", "prompt": "rename_summary", "enabled": True},
    )
    client.put(
        "/system/default-questionnaire", headers=_admin_headers(),
        json={"questionnaire_id": "rename_src"},
    )

    res = client.post("/questionnaires/rename_src/rename", headers=_admin_headers(), json={"new_id": "rename_dst"})
    assert res.status_code == 200
    assert res.json()["id"] == "rename_dst"

    ids = {row["id"] for row in client.get("/questionnaires").json()}
    assert "rename_dst" in ids
    assert "rename_src" not in ids

    renamed_template = client.get(
        "/questionnaires/rename_dst/template?visit_type=initial"
    ).json()
    assert renamed_template["items"][0]["label"] == "Q1"

    renamed_prompt = client.get(
        "/questionnaires/rename_dst/summary-prompt?visit_type=initial", headers=_admin_headers()
    ).json()
    assert renamed_prompt["prompt"] == "rename_summary"
    assert renamed_prompt["enabled"] is True

    default_after = client.get("/system/default-questionnaire").json()
    assert default_after["questionnaire_id"] == "rename_dst"
    client.delete("/questionnaires/rename_dst?visit_type=initial", headers=_admin_headers())
    client.delete("/questionnaires/rename_dst?visit_type=followup", headers=_admin_headers())


def test_rename_questionnaire_validation() -> None:
    """テンプレートID変更APIのバリデーションを確認する。"""

    on_startup()
    client.post(
        "/questionnaires", headers=_admin_headers(),
        json={
            "id": "rename_a",
            "visit_type": "initial",
            "items": [{"id": "a1", "label": "A1", "type": "string"}],
        },
    )
    client.post(
        "/questionnaires", headers=_admin_headers(),
        json={
            "id": "rename_b",
            "visit_type": "initial",
            "items": [{"id": "b1", "label": "B1", "type": "string"}],
        },
    )

    res_default = client.post(
        "/questionnaires/default/rename", headers=_admin_headers(), json={"new_id": "foo"}
    )
    assert res_default.status_code == 400

    res_duplicate = client.post(
        "/questionnaires/rename_a/rename", headers=_admin_headers(), json={"new_id": "rename_b"}
    )
    assert res_duplicate.status_code == 400
    client.delete("/questionnaires/rename_a?visit_type=initial", headers=_admin_headers())
    client.delete("/questionnaires/rename_b?visit_type=initial", headers=_admin_headers())


def test_session_persisted() -> None:
    """セッションと回答がDBに保存されることを確認する。"""
    on_startup()
    create_payload = {
        "patient_name": "保存太郎",
        "dob": "1999-09-09",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "めまい"},
    }
    res = client.post("/sessions", json=create_payload)
    session_id = res.json()["id"]
    client.post(
        f"/sessions/{session_id}/answers", headers=_patient_headers(res),
        json={"answers": {"onset": "昨日から"}},
    )
    client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(res))
    record = db_get_session(session_id)
    assert record is not None
    assert record["answers"]["onset"] == ["昨日から"]


def test_llm_followup_disabled_by_template(monkeypatch) -> None:
    """テンプレート無効時はLLMが有効でも質問生成を呼ばない。"""
    on_startup()
    monkeypatch.setattr(llm_gateway.settings, "enabled", True)
    calls = []
    def unexpected_followups(**kwargs):
        calls.append(kwargs)
        return []
    monkeypatch.setattr(llm_gateway, "generate_followups", unexpected_followups)
    payload = {
        "id": "nofup",
        "visit_type": "initial",
        "items": [
            {"id": "symptom", "label": "症状は？", "type": "string", "required": True}
        ],
        "llm_followup_enabled": False,
    }
    client.post("/questionnaires", headers=_admin_headers(), json=payload)
    create_payload = {
        "patient_name": "テスト",
        "dob": "2000-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"symptom": "痛み"},
        "questionnaire_id": "nofup",
    }
    res = client.post("/sessions", json=create_payload)
    session_id = res.json()["id"]
    q_res = client.post(f"/sessions/{session_id}/llm-questions", headers=_patient_headers(res)).json()
    assert q_res["questions"] == []
    assert calls == [], "disabled template must not send answers to an LLM"
    client.delete("/questionnaires/nofup?visit_type=initial", headers=_admin_headers())


def test_llm_followup_max_questions(monkeypatch) -> None:
    """追加質問上限を永続化し、別リクエストでも再生成しない。"""
    on_startup()
    monkeypatch.setattr(llm_gateway.settings, "enabled", True)
    calls = []
    def generate_followups(**kwargs):
        calls.append(kwargs)
        assert kwargs["max_questions"] == 2
        return ["合成質問1", "合成質問2"]
    monkeypatch.setattr(llm_gateway, "generate_followups", generate_followups)
    client.post(
        "/questionnaires", headers=_admin_headers(),
        json={
            "id": "maxq",
            "visit_type": "initial",
            "items": [
                {"id": "symptom", "label": "症状は？", "type": "string", "required": True}
            ],
            "llm_followup_enabled": True,
            "llm_followup_max_questions": 2,
        },
    )
    res = client.post(
        "/sessions",
        json={
            "patient_name": "上限太郎",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {"symptom": "痛み"},
            "questionnaire_id": "maxq",
        },
    )
    session_id = res.json()["id"]
    q1 = client.post(f"/sessions/{session_id}/llm-questions", headers=_patient_headers(res)).json()
    assert [question["text"] for question in q1["questions"]] == ["合成質問1", "合成質問2"]
    sessions.clear()
    q2 = client.post(f"/sessions/{session_id}/llm-questions", headers=_patient_headers(res)).json()
    assert q2["questions"] == []
    assert len(calls) == 1
    client.delete("/questionnaires/maxq?visit_type=initial", headers=_admin_headers())


def test_followup_prompt_api() -> None:
    """追加質問プロンプトの取得・保存とセッション反映を確認する。"""
    on_startup()
    client.post(
        "/questionnaires", headers=_admin_headers(),
        json={
            "id": "adv",
            "visit_type": "initial",
            "items": [],
            "llm_followup_enabled": True,
            "llm_followup_max_questions": 1,
        },
    )
    res = client.get("/questionnaires/adv/followup-prompt?visit_type=initial", headers=_admin_headers())
    assert res.json()["prompt"] == DEFAULT_FOLLOWUP_PROMPT
    assert res.json()["enabled"] is False
    client.post(
        "/questionnaires/adv/followup-prompt", headers=_admin_headers(),
        json={
            "visit_type": "initial",
            "prompt": "{max_questions}個以内で返答",
            "enabled": True,
        },
    )
    res = client.get("/questionnaires/adv/followup-prompt?visit_type=initial", headers=_admin_headers())
    assert res.json()["prompt"] == "{max_questions}個以内で返答"
    assert res.json()["enabled"] is True
    res = client.post(
        "/sessions",
        json={
            "patient_name": "太郎",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {},
            "questionnaire_id": "adv",
        },
    )
    sid = res.json()["id"]
    rec = db_get_session(sid)
    assert rec["followup_prompt"] == "{max_questions}個以内で返答"
    client.post(
        "/questionnaires/adv/followup-prompt", headers=_admin_headers(),
        json={
            "visit_type": "initial",
            "prompt": "ignored",
            "enabled": False,
        },
    )
    res = client.post(
        "/sessions",
        json={
            "patient_name": "次郎",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {},
            "questionnaire_id": "adv",
        },
    )
    sid = res.json()["id"]
    rec = db_get_session(sid)
    assert rec["followup_prompt"] == DEFAULT_FOLLOWUP_PROMPT
    client.delete("/questionnaires/adv?visit_type=initial", headers=_admin_headers())


def test_slider_item_validation() -> None:
    """スライドバー項目の範囲チェックを確認する。"""
    on_startup()
    client.post(
        "/questionnaires", headers=_admin_headers(),
        json={
            "id": "slider",
            "visit_type": "initial",
            "items": [
                {"id": "pain", "label": "痛み", "type": "slider", "min": 0, "max": 10, "required": True}
            ],
        },
    )
    res = client.post(
        "/sessions",
        json={
            "patient_name": "三郎",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {},
            "questionnaire_id": "slider",
        },
    )
    sid = res.json()["id"]
    ok = client.post(f"/sessions/{sid}/answers", headers=_patient_headers(res), json={"answers": {"pain": 5}})
    assert ok.status_code == 200
    second_created = client.post(
        "/sessions",
        json={
            "patient_name": "四郎",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {},
            "questionnaire_id": "slider",
        },
    )
    sid2 = second_created.json()["id"]
    ng = client.post(f"/sessions/{sid2}/answers", headers=_patient_headers(second_created), json={"answers": {"pain": 11}})
    assert ng.status_code == 400


def test_summary_prompt_api_default() -> None:
    """サマリープロンプトの既定値取得を確認する。"""
    on_startup()
    res = client.get("/questionnaires/unknown/summary-prompt?visit_type=initial", headers=_admin_headers())
    assert res.status_code == 200
    data = res.json()
    assert data["prompt"].startswith("あなたは医療記録作成の専門家です")
    assert data["enabled"] is False


def test_session_can_resume_after_memory_cache_loss_and_batch_answers() -> None:
    """別Cloud Runインスタンス相当でも永続層からセッションを復元できる。"""

    on_startup()
    created = client.post(
        "/sessions",
        json={
            "patient_name": "復元試験",
            "dob": "2000-01-01",
            "gender": "female",
            "visit_type": "initial",
            "answers": {},
        },
    )
    session_id = created.json()["id"]
    sessions.clear()
    response = client.post(
        f"/sessions/{session_id}/llm-answers/batch", headers=_patient_headers(created),
        json={"answers": {"chief_complaint": "発熱", "onset": "昨日"}},
    )
    assert response.status_code == 200
    stored = db_get_session(session_id)
    assert stored["answers"]["chief_complaint"] == "発熱"
    assert stored["answers"]["onset"] == ["昨日"]


def test_finalize_is_idempotent_after_memory_cache_loss() -> None:
    """再送や別インスタンス到着でも確定日時を更新しない。"""

    on_startup()
    client.post(
        "/questionnaires/default/summary-prompt", headers=_admin_headers(),
        json={"visit_type": "initial", "prompt": "", "enabled": False},
    )
    created = client.post(
        "/sessions",
        json={
            "patient_name": "冪等試験",
            "dob": "2000-01-01",
            "gender": "male",
            "visit_type": "initial",
            "answers": {"chief_complaint": "頭痛"},
        },
    )
    session_id = created.json()["id"]
    first = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(created))
    sessions.clear()
    second = client.post(f"/sessions/{session_id}/finalize", headers=_patient_headers(created))
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["finalized_at"] == first.json()["finalized_at"]


def test_admin_sessions_page_has_bounded_shape() -> None:
    response = client.get("/admin/sessions/page?limit=2", headers=_admin_headers())
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["items"]) <= 2
    assert "next_cursor" in payload


def test_finalization_summarizes_once_and_settings_never_resend_records(monkeypatch) -> None:
    on_startup()
    prompt = "合成テスト専用サマリープロンプト"
    configured = client.post(
        "/questionnaires/default/summary-prompt", headers=_admin_headers(),
        json={"visit_type": "initial", "prompt": prompt, "enabled": True},
    )
    assert configured.status_code == 200
    created = client.post("/sessions", json={
        "patient_name": "要約合成患者", "dob": "2000-01-01", "gender": "female",
        "visit_type": "initial", "answers": {"chief_complaint": "頭痛"},
    })
    headers = _patient_headers(created)
    session_id = created.json()["id"]
    calls = []
    def summarize_once(received_prompt, context, labels, **kwargs):
        assert received_prompt == prompt
        assert context == {"chief_complaint": "頭痛"}
        assert set(labels) == {"chief_complaint"}
        assert kwargs == {"lock_key": session_id, "retry": 0}
        assert db_get_session(session_id)["completion_status"] != "finalized"
        calls.append(context)
        return "合成テスト要約"
    monkeypatch.setattr(llm_gateway, "has_remote_backend", lambda: True)
    monkeypatch.setattr(llm_gateway, "summarize_with_prompt", summarize_once)
    def unexpected_summary(*args, **kwargs):
        pytest.fail("a second/fallback/background summary must not run")
    monkeypatch.setattr(llm_gateway, "summarize", unexpected_summary)
    first = client.post(f"/sessions/{session_id}/finalize", headers=headers)
    _assert_receipt(first, session_id)
    stored = _saved_session(session_id)
    assert stored["summary"] == "合成テスト要約"
    assert len(calls) == 1
    sessions.clear()
    assert client.post(f"/sessions/{session_id}/finalize", headers=headers).json() == first.json()
    assert len(calls) == 1

    updated = client.put("/llm/settings", headers=_admin_headers(), json={
        "provider": "openai", "model": "synthetic-model", "enabled": True,
        "temperature": 0.2, "base_url": "https://api.openai.com",
    })
    assert updated.status_code == 200, updated.text
    assert _saved_session(session_id) == stored
    assert len(calls) == 1


def test_persistent_session_overrides_stale_cache_and_finalized_updates_fail() -> None:
    on_startup()
    created = client.post("/sessions", json={
        "patient_name": "永続合成患者", "dob": "2000-01-01", "gender": "female",
        "visit_type": "initial", "answers": {"chief_complaint": "保存された回答"},
    })
    headers = _patient_headers(created)
    session_id = created.json()["id"]
    stale = main_module._get_session(session_id)
    stale.answers["chief_complaint"] = "古いキャッシュの回答"
    sessions[session_id] = stale
    added = client.post(f"/sessions/{session_id}/answers", headers=headers,
                        json={"answers": {"onset": "昨日"}})
    assert added.status_code == 200
    assert _saved_session(session_id)["answers"]["chief_complaint"] == "保存された回答"
    finalized = client.post(f"/sessions/{session_id}/finalize", headers=headers)
    _assert_receipt(finalized, session_id)
    before = db_get_session(session_id)
    for suffix in ("answers", "llm-answers", "llm-answers/batch", "llm-questions"):
        sessions[session_id] = stale
        response = client.post(f"/sessions/{session_id}/{suffix}", headers=headers, json={
            "answers": {"chief_complaint": "改変"}, "item_id": "chief_complaint", "answer": "改変",
        })
        assert response.status_code == 409
    assert db_get_session(session_id) == before


def test_llm_answers_require_persistently_issued_question_text(monkeypatch) -> None:
    on_startup()
    monkeypatch.setattr(llm_gateway.settings, "enabled", True)
    monkeypatch.setattr(llm_gateway, "generate_followups", lambda **kwargs: ["合成追加質問"])
    created = client.post("/sessions", json={
        "patient_name": "発行合成患者", "dob": "2000-01-01", "gender": "female",
        "visit_type": "initial", "answers": {"chief_complaint": "頭痛"},
    })
    headers = _patient_headers(created)
    session_id = created.json()["id"]
    for suffix, payload in (
        ("answers", {"answers": {"llm_1": "未発行"}}),
        ("llm-answers", {"item_id": "llm_1", "answer": "未発行"}),
        ("llm-answers/batch", {"answers": {"llm_1": "未発行"}}),
    ):
        rejected = client.post(f"/sessions/{session_id}/{suffix}", headers=headers, json=payload)
        assert rejected.status_code == 422
    issued = client.post(f"/sessions/{session_id}/llm-questions", headers=headers)
    assert issued.status_code == 200, issued.text
    item_id = issued.json()["questions"][0]["id"]
    sessions.clear()
    accepted = client.post(f"/sessions/{session_id}/llm-answers", headers=headers,
                           json={"item_id": item_id, "answer": "発行済みへの回答"})
    assert accepted.status_code == 200, accepted.text
    assert _saved_session(session_id)["answers"][item_id] == "発行済みへの回答"
    assert db_get_session(session_id)["question_texts"][item_id] == "合成追加質問"
