import base64
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient


DB_PATH = Path(__file__).resolve().parents[1] / "app" / "app.sqlite3"


def _reset_database() -> None:
    if DB_PATH.exists():
        DB_PATH.unlink()


sys.path.append(str(Path(__file__).resolve().parents[1]))
from app.main import app, IMAGE_DIR  # noqa: E402
from app.db import init_db, get_session as db_get_session, get_template as db_get_template  # noqa: E402


client = TestClient(app)


def _clean_images() -> None:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    for child in IMAGE_DIR.glob("*"):
        if child.is_file():
            child.unlink()


def _prepare_sample_template() -> None:
    image_path = IMAGE_DIR / "export-test.png"
    image_path.write_bytes(b"fake-image")
    payload = {
        "id": "default",
        "visit_type": "initial",
        "items": [
            {
                "id": "symptom",
                "label": "症状",
                "type": "string",
                "required": True,
                "allow_freetext": False,
                "description": "テスト用",
                "image": "/questionnaire-item-images/files/export-test.png",
            }
        ],
        "llm_followup_enabled": True,
        "llm_followup_max_questions": 3,
    }
    client.post("/questionnaires", json=payload)
    followup_payload = {**payload, "visit_type": "followup"}
    client.post("/questionnaires", json=followup_payload)


def test_questionnaire_export_import_roundtrip_with_password() -> None:
    _reset_database()
    init_db()
    _clean_images()
    _prepare_sample_template()

    export_res = client.post("/admin/questionnaires/export", json={"password": "secret"})
    assert export_res.status_code == 200
    envelope = json.loads(export_res.content)
    assert envelope["encryption"] is not None
    enc_info = envelope["encryption"]
    salt = base64.b64decode(enc_info["salt"])
    iterations = int(enc_info["iterations"])
    key_material = base64.urlsafe_b64encode(
        hashlib.pbkdf2_hmac("sha256", b"secret", salt, iterations, dklen=32)
    )
    cipher = Fernet(key_material)
    payload = json.loads(cipher.decrypt(base64.b64decode(envelope["payload"])))
    assert any(tpl["id"] == "default" for tpl in payload["templates"])
    assert "export-test.png" in payload["images"]

    # インポート前にテンプレートと画像を削除して差分を確認する
    if (IMAGE_DIR / "export-test.png").exists():
        (IMAGE_DIR / "export-test.png").unlink()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM questionnaire_templates")
    conn.execute("DELETE FROM summary_prompts")
    conn.execute("DELETE FROM followup_prompts")
    conn.commit()
    conn.close()

    # 誤ったパスワードでは復号できない
    bad_import = client.post(
        "/admin/questionnaires/import",
        data={"password": "wrong", "mode": "replace"},
        files={"file": ("settings.json", export_res.content, "application/json")},
    )
    assert bad_import.status_code == 400

    good_import = client.post(
        "/admin/questionnaires/import",
        data={"password": "secret", "mode": "replace"},
        files={"file": ("settings.json", export_res.content, "application/json")},
    )
    assert good_import.status_code == 200

    tpl = db_get_template("default", "initial")
    assert tpl is not None
    assert any(it.get("image", "").endswith("export-test.png") for it in tpl["items"])
    assert (IMAGE_DIR / "export-test.png").exists()


def test_questionnaire_export_normalizes_absolute_image_url() -> None:
    _reset_database()
    init_db()
    _clean_images()
    image_path = IMAGE_DIR / "export-abs.png"
    image_path.write_bytes(b"abs-image")

    payload = {
        "id": "default",
        "visit_type": "initial",
        "items": [
            {
                "id": "with_image",
                "label": "画像付き",
                "type": "string",
                "required": False,
                "image": "https://example.com/questionnaire-item-images/files/export-abs.png?rev=1",
            }
        ],
        "llm_followup_enabled": True,
        "llm_followup_max_questions": 2,
    }
    assert client.post("/questionnaires", json=payload).status_code == 200

    export_res = client.post("/admin/questionnaires/export", json={})
    assert export_res.status_code == 200
    envelope = json.loads(export_res.content)
    assert envelope["encryption"] is None
    payload_export = envelope["payload"]
    template = next(t for t in payload_export["templates"] if t["id"] == "default" and t["visit_type"] == "initial")
    assert template["items"][0]["image"] == "/questionnaire-item-images/files/export-abs.png"
    assert "export-abs.png" in payload_export["images"]

    if (IMAGE_DIR / "export-abs.png").exists():
        (IMAGE_DIR / "export-abs.png").unlink()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM questionnaire_templates")
    conn.execute("DELETE FROM summary_prompts")
    conn.execute("DELETE FROM followup_prompts")
    conn.commit()
    conn.close()

    import_res = client.post(
        "/admin/questionnaires/import",
        data={"mode": "replace"},
        files={"file": ("settings.json", export_res.content, "application/json")},
    )
    assert import_res.status_code == 200

    tpl = db_get_template("default", "initial")
    assert tpl is not None
    assert any(
        it.get("image") == "/questionnaire-item-images/files/export-abs.png" for it in tpl["items"]
    )
    assert (IMAGE_DIR / "export-abs.png").exists()


def test_session_export_import_roundtrip() -> None:
    _reset_database()
    init_db()
    _clean_images()
    payload = {
        "patient_name": "輸出太郎",
        "dob": "1990-01-01",
        "gender": "male",
        "visit_type": "initial",
        "answers": {"chief_complaint": "頭痛"},
    }
    create_res = client.post("/sessions", json=payload)
    assert create_res.status_code == 200
    session_id = create_res.json()["id"]
    finalize_res = client.post(f"/sessions/{session_id}/finalize")
    assert finalize_res.status_code == 200

    export_res = client.post(
        "/admin/sessions/export",
        json={"session_ids": [session_id]},
    )
    assert export_res.status_code == 200
    envelope = json.loads(export_res.content)
    assert envelope["encryption"] is None
    payload = envelope["payload"]
    assert any(s["id"] == session_id for s in payload["sessions"])

    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM session_responses")
    conn.execute("DELETE FROM sessions")
    conn.commit()
    conn.close()
    assert db_get_session(session_id) is None

    import_res = client.post(
        "/admin/sessions/import",
        data={"mode": "merge"},
        files={"file": ("sessions.json", export_res.content, "application/json")},
    )
    assert import_res.status_code == 200
    restored = db_get_session(session_id)
    assert restored is not None
    assert restored["patient_name"] == "輸出太郎"
    assert json.loads(restored["answers_json"])["chief_complaint"] == "頭痛"
