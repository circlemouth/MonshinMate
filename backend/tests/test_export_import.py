"""Portability tests use only isolated synthetic fixtures; never clean source DB/assets."""
import asyncio
import base64
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image


@pytest.fixture
def main(monkeypatch):
    # Importing main initializes persistence. Refuse the real checkout outright.
    root = Path(__file__).resolve().parents[2]
    if not root.name.startswith("monshinmate-security-tests-") or os.getenv("MONSHINMATE_ENV") != "test":
        pytest.skip("Run with backend/tools/run_security_tests.py (source-only isolated harness)")
    from app import main as module
    monkeypatch.setattr(module, "save_binary_asset", lambda *a, **k: pytest.fail("unexpected asset write"))
    monkeypatch.setattr(module, "import_sessions_data", lambda *a, **k: pytest.fail("legacy non-atomic import"))
    monkeypatch.setattr(module, "import_questionnaire_settings", lambda *a, **k: pytest.fail("legacy non-atomic import"))
    return module


def raster():
    stream = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(stream, format="PNG")
    return stream.getvalue()


def upload(envelope):
    return UploadFile(filename="test.json", file=io.BytesIO(json.dumps(envelope).encode()))


def test_export_password_roundtrip(main):
    data = {"sessions": []}
    envelope = main._build_export_envelope(data, "session_data", "synthetic-passphrase")
    assert main._parse_import_envelope(json.dumps(envelope).encode(), "synthetic-passphrase") == ("session_data", data)
    with pytest.raises(HTTPException) as exc:
        main._parse_import_envelope(json.dumps(envelope).encode(), "incorrect")
    assert exc.value.detail == "invalid_password"


@pytest.mark.parametrize("change", [
    {"iterations": 1}, {"iterations": 390001}, {"iterations": True},
    {"iterations": "390000"}, {"algorithm": "other"}, {"kdf": "other"},
    {"salt": "%%%"}, {"salt": base64.b64encode(b"short").decode()},
])
def test_invalid_encryption_rejected_before_kdf(main, monkeypatch, change):
    envelope = main._build_export_envelope({"sessions": []}, "session_data", "pass")
    envelope["encryption"].update(change)
    monkeypatch.setattr(main.hashlib, "pbkdf2_hmac", lambda *a, **k: pytest.fail("untrusted KDF work"))
    with pytest.raises(HTTPException):
        main._parse_import_envelope(json.dumps(envelope).encode(), "pass")


@pytest.mark.parametrize("mode", ["merge", "replace"])
def test_import_requires_atomic_adapter(main, monkeypatch, mode):
    from app import db
    monkeypatch.setattr(db, "get_active_adapter", lambda: SimpleNamespace())
    for kind, function, payload in [
        ("session_data", main.import_sessions_api, {"sessions": []}),
        ("questionnaire_settings", main.import_questionnaire_settings_api, {"templates": []}),
    ]:
        envelope = main._build_export_envelope(payload, kind, None)
        with pytest.raises(HTTPException) as exc:
            asyncio.run(function(file=upload(envelope), password=None, mode=mode))
        assert exc.value.status_code == 501
        assert exc.value.detail == "atomic_import_not_supported"


def test_invalid_later_asset_has_no_mutation(main, monkeypatch):
    called = []
    monkeypatch.setattr(main, "atomic_import", lambda *a, **k: called.append(True))
    envelope = main._build_export_envelope({"templates": [], "images": {
        "valid.png": base64.b64encode(raster()).decode(),
        "bad.svg": base64.b64encode(b"<svg onload='evil()'/>").decode(),
    }}, "questionnaire_settings", None)
    with pytest.raises(HTTPException):
        asyncio.run(main.import_questionnaire_settings_api(file=upload(envelope), password=None, mode="merge"))
    assert not called


def test_import_hook_receives_only_validated_assets_and_portable_state(main, monkeypatch):
    from app import db
    received = {}
    def hook(data, **kwargs):
        received.update(data=data, **kwargs)
        return {"templates": 0}
    monkeypatch.setattr(db, "get_active_adapter", lambda: SimpleNamespace(atomic_import_questionnaire_settings=hook))
    envelope = main._build_export_envelope({"templates": [], "app_settings": {
        "display_name": "synthetic clinic", "security_state": {"token": "never-portable"},
        "admin_password": "never-portable",
    }, "images": {"valid.png": base64.b64encode(raster() + b"trailer").decode()}}, "questionnaire_settings", None)
    result = asyncio.run(main.import_questionnaire_settings_api(file=upload(envelope), password=None, mode="merge"))
    assert result["status"] == "ok"
    assert received["data"]["app_settings"] == {"display_name": "synthetic clinic"}
    assert not received["images"]["valid.png"]["content"].endswith(b"trailer")


def test_import_size_limit_before_json(main):
    from app.transfer_security import MAX_IMPORT_BYTES
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.import_sessions_api(file=UploadFile(file=io.BytesIO(b"x" * (MAX_IMPORT_BYTES + 1))), password=None, mode="merge"))
    assert exc.value.status_code == 413


def test_existing_asset_is_revalidated_and_headers_are_safe(main):
    with pytest.raises(HTTPException) as exc:
        main._build_binary_asset_response({"content": b"<svg/>"}, "legacy.svg")
    assert exc.value.status_code == 404
    response = main._build_binary_asset_response({"content": raster(), "content_type": "text/html"}, "image.html")
    assert response.media_type == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]


@pytest.mark.parametrize("name", ["upload_system_logo", "upload_questionnaire_item_image"])
def test_upload_ignores_claimed_name_and_mime(main, monkeypatch, name):
    writes = []
    monkeypatch.setattr(main, "save_binary_asset", lambda *args, **kwargs: writes.append((args, kwargs)))
    file = UploadFile(filename="payload.svg", file=io.BytesIO(raster() + b"<script>evil</script>"))
    result = getattr(main, name)(file=file)
    assert result["url"].endswith(".png")
    assert writes[0][1]["content_type"] == "image/png"
    assert b"evil" not in writes[0][0][1]


@pytest.mark.parametrize("name", ["upload_system_logo", "upload_questionnaire_item_image"])
def test_upload_read_is_bounded(main, name):
    from app.transfer_security import MAX_ASSET_BYTES
    class Reader:
        def read(self, limit):
            assert limit == MAX_ASSET_BYTES + 1
            return b"x" * limit
    with pytest.raises(HTTPException) as exc:
        getattr(main, name)(file=SimpleNamespace(file=Reader()))
    assert exc.value.status_code == 413


def test_setting_update_never_resends_records(main, monkeypatch):
    monkeypatch.setattr(main, "db_list_sessions", lambda: pytest.fail("history enumeration"))
    monkeypatch.setattr(main, "save_llm_settings", lambda value: None)
    monkeypatch.setattr(main.llm_gateway, "settings", main.llm_gateway.settings.model_copy(deep=True))
    settings = main.LLMSettings(provider="openai", model="synthetic", temperature=0.2, enabled=False)
    monkeypatch.setattr(main, "_merge_preserved_api_keys", lambda _: settings)
    background = SimpleNamespace(add_task=lambda *a, **k: pytest.fail("history resend scheduled"))
    main.update_llm_settings(settings, background)
