from pathlib import Path


def test_patient_summary_is_proxied_by_the_public_frontend() -> None:
    nginx_template = (
        Path(__file__).resolve().parents[2] / "frontend" / "nginx.conf.template"
    ).read_text(encoding="utf-8")

    assert "location = /patient-summary {" in nginx_template
    assert "proxy_pass ${BACKEND_ORIGIN};" in nginx_template
