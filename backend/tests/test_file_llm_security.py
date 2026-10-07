import asyncio
import base64
import io
import json
import socket

import httpx
import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image, PngImagePlugin

from app.transfer_security import (
    MAX_ASSET_BYTES, MAX_IMPORT_BYTES, SafeCSVWriter, clean_raster, csv_cell,
    portable_session, read_import, validate_assets, validate_questionnaires, validate_sessions,
)
from app.llm_data_security import minimize_answers, validate_destination, validate_profile_destination
from app.llm_gateway import LLMGateway, LLMSettings


def image_bytes(fmt="PNG", size=(4, 4)):
    output = io.BytesIO()
    kwargs = {}
    if fmt == "PNG":
        info = PngImagePlugin.PngInfo()
        info.add_text("private", "patient-identity-marker")
        kwargs["pnginfo"] = info
    Image.new("RGB", size, "blue").save(output, format=fmt, **kwargs)
    return output.getvalue()


@pytest.mark.parametrize("fmt,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_raster_reencode_removes_metadata_and_trailers(fmt, mime):
    cleaned, content_type, ext = clean_raster(image_bytes(fmt) + b"<script>marker</script>")
    assert content_type == mime
    assert b"marker" not in cleaned
    assert b"patient-identity-marker" not in cleaned
    assert Image.open(io.BytesIO(cleaned)).size == (4, 4)


@pytest.mark.parametrize("data", [b"", b"<svg onload='evil()'/>", b"<html>test</html>", b"fake-png", b"GIF89a"])
def test_non_rasters_rejected(data):
    with pytest.raises(HTTPException):
        clean_raster(data)


def test_image_byte_and_pixel_limits():
    with pytest.raises(HTTPException) as exc:
        clean_raster(b"x" * (MAX_ASSET_BYTES + 1))
    assert exc.value.status_code == 413
    with pytest.raises(HTTPException) as exc:
        clean_raster(image_bytes(size=(2001, 2000)))
    assert exc.value.detail == "image_pixel_limit"


def test_animated_image_rejected():
    output = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(output, format="PNG", save_all=True,
                                          append_images=[Image.new("RGB", (4, 4), "blue")])
    with pytest.raises(HTTPException):
        clean_raster(output.getvalue())


@pytest.mark.parametrize("name,encoded", [("../escape.png", "AA=="), ("x.png", "%%%"), ("x.png", 1)])
def test_import_asset_validation(name, encoded):
    with pytest.raises(HTTPException):
        validate_assets({name: encoded})


@pytest.mark.parametrize("value", ["=1+1", "+SUM(A1)", "-1", "@SUM(A1)", " \t\r=cmd", "\x00\x1b+cmd", "\u200b @cmd"])
def test_csv_formula_neutralization_all_cells(value):
    assert csv_cell(value) == "'" + value
    stream = io.StringIO()
    SafeCSVWriter(stream).writerow([value, value, "safe", 42])
    import csv
    assert next(csv.reader(io.StringIO(stream.getvalue()))) == ["'" + value, "'" + value, "safe", "42"]


def test_csv_does_not_change_stored_input():
    row = ["=unsafe", "ordinary", 1]
    SafeCSVWriter(io.StringIO()).writerow(row)
    assert row == ["=unsafe", "ordinary", 1]


def test_import_limits_and_validation():
    with pytest.raises(HTTPException):
        validate_sessions([{}] * 101)
    with pytest.raises(HTTPException):
        validate_questionnaires({"templates": [{"id": "x", "visit_type": "initial", "items": [], "llm_followup_max_questions": "bad"}]})
    class Reader:
        async def read(self, size):
            assert size == MAX_IMPORT_BYTES + 1
            return b"x" * size
    with pytest.raises(HTTPException) as exc:
        asyncio.run(read_import(Reader()))
    assert exc.value.status_code == 413


def test_questionnaire_nullable_followups_roundtrip():
    result = validate_questionnaires({"templates": [{"id": "x", "visit_type": "initial", "items": [
        {"id": "q", "label": "Synthetic", "type": "string", "followups": None}]}]})
    assert result["templates"][0]["items"][0]["followups"] is None


@pytest.mark.parametrize("change", [{"dob": "invalid"}, {"started_at": "invalid"},
                                     {"attempt_counts": {"q": "bad"}}, {"remaining_items": [{}]},
                                     {"question_texts": {"q": {"token": "bad"}}}])
def test_invalid_session_shape_rejected(change):
    record = {"id": "x", "patient_name": "Synthetic", "dob": "2000-01-02", "gender": "other",
              "questionnaire_id": "x", "visit_type": "initial"}
    with pytest.raises(HTTPException):
        validate_sessions([{**record, **change}])


def test_security_state_not_portable():
    assert portable_session({"id": "test", "capability_hash": "secret", "security_state": {}, "auth_token": "secret"}) == {"id": "test"}


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data", "https://metadata.google.internal", "http://localhost:11434",
    "https://127.0.0.1", "https://[::1]", "https://example.org", "https://api.openai.com.evil.test",
    "https://user:password@api.openai.com", "https://api.openai.com/?token=secret", "https://api.openai.com#fragment",
])
def test_llm_destinations_fail_closed(monkeypatch, url):
    monkeypatch.setenv("MONSHINMATE_ENV", "production")
    monkeypatch.delenv("MONSHINMATE_LLM_ALLOWED_ORIGINS", raising=False)
    with pytest.raises(ValueError):
        validate_destination(url, resolve=False)


def test_local_requires_explicit_double_optin(monkeypatch):
    monkeypatch.setenv("MONSHINMATE_ENV", "local")
    monkeypatch.delenv("MONSHINMATE_ALLOW_LOCAL_LLM", raising=False)
    with pytest.raises(ValueError):
        validate_destination("http://localhost:11434", resolve=False)
    monkeypatch.setenv("MONSHINMATE_ALLOW_LOCAL_LLM", "1")
    validate_destination("http://127.0.0.1:11434", resolve=False)
    with pytest.raises(ValueError):
        validate_destination("http://169.254.169.254", resolve=False)


def test_allowed_host_private_dns_denied(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("169.254.169.254", 443))])
    with pytest.raises(ValueError):
        validate_destination("https://api.openai.com")


def settings(**kwargs):
    return LLMSettings(provider="openai", model="synthetic-model", temperature=0.2,
                       base_url="https://api.openai.com", **kwargs)


def test_identity_scrubber_preserves_custom_clinical_fields():
    assert minimize_answers({"personal_info": {"name": "marker"}, "dob": "marker", "contact_update": "marker",
                             "custom_clinical_question": {"answer": "pain", "phone": "marker"}}) == {"custom_clinical_question": {"answer": "pain"}}


def test_prompt_mapping_and_safe_transport(monkeypatch):
    from app import llm_gateway as gateway_module
    requests = []
    monkeypatch.setattr(gateway_module, "validate_destination", lambda *a, **k: None)
    def post(url, **kwargs):
        requests.append(kwargs)
        return httpx.Response(200, request=httpx.Request("POST", url), json={"choices": [{"message": {"content": "synthetic summary"}}]})
    monkeypatch.setattr(httpx, "post", post)
    gateway = LLMGateway(settings())
    result = gateway.summarize_with_prompt("summarize", {"personal_info": {"name": "secret-identity"}, "custom_q": "pain"})
    assert result == "synthetic summary"
    assert "secret-identity" not in json.dumps([request["json"] for request in requests])
    assert "pain" in json.dumps([request["json"] for request in requests])
    assert requests[0]["trust_env"] is False
    assert requests[0]["follow_redirects"] is False


def test_gateway_never_calls_disallowed_destination(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: pytest.fail("disallowed network request"))
    monkeypatch.setattr(httpx, "get", lambda *a, **k: pytest.fail("disallowed network request"))
    gateway = LLMGateway(LLMSettings(provider="openai", model="synthetic", temperature=0.2,
                                    base_url="http://169.254.169.254/latest/meta-data"))
    assert gateway.has_remote_backend() is False
    assert gateway.list_models() == []
    assert gateway.test_connection()["status"] == "ng"
    gateway.generate_followups({"clinical": "pain"}, 2)
    gateway.summarize_with_prompt("summarize", {"clinical": "pain"})
    gateway.chat("synthetic")


def test_gateway_error_does_not_expose_patient_data(monkeypatch, caplog):
    from app import llm_gateway as gateway_module
    monkeypatch.setattr(gateway_module, "validate_destination", lambda *a, **k: None)
    def post(*a, **k):
        raise RuntimeError("secret-patient-marker")
    monkeypatch.setattr(httpx, "post", post)
    gateway = LLMGateway(settings())
    gateway.summarize_with_prompt("summarize", {"clinical": "pain"})
    assert "secret-patient-marker" not in caplog.text
    assert "secret-patient-marker" not in json.dumps(gateway.get_status_snapshot(), default=str)


@pytest.mark.parametrize("field,value", [("location", "evil.example/"), ("project_id", "../secret"), ("model", "//metadata.google.internal")])
def test_vertex_profile_rejects_url_injection(field, value):
    profile = {"project_id": "synthetic-project", "location": "global", "model": "gemini-test"}
    profile[field] = value
    with pytest.raises(ValueError):
        validate_profile_destination("gcp_vertex", profile)


def test_vertex_transport_no_proxy_redirect_or_error_body(monkeypatch):
    from app.llm_providers.gcp_vertex import GcpVertexProvider
    options = {}
    class Client:
        def __init__(self, **kwargs):
            options.update(kwargs)
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def request(self, method, url, **kwargs):
            return httpx.Response(400, request=httpx.Request(method, url), json={"error": {"message": "patient-marker"}})
    monkeypatch.setattr(httpx, "Client", Client)
    with pytest.raises(RuntimeError, match="llm_request_failed") as exc:
        GcpVertexProvider()._perform_request("POST", "https://aiplatform.googleapis.com/v1/test", {})
    assert "patient-marker" not in str(exc.value)
    assert options["trust_env"] is False and options["follow_redirects"] is False
