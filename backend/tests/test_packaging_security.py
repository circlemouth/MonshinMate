"""Static packaging regressions, using only the runner's allowlisted configs."""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[2]


def test_build_context_excludes_secrets_and_actual_mutable_asset_directories():
    patterns = set((ROOT / ".dockerignore").read_text().splitlines())
    assert {"**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.sqlite3",
            "**/logs/**", "private", "backend/app/questionnaire_item_images/**",
            "backend/app/system_logo/**"} <= patterns


def test_compose_loopback_and_no_default_credentials():
    source = (ROOT / "docker-compose.yml").read_text()
    published = re.findall(r'^\s+- "([^"]+)"', source, re.MULTILINE)
    ports = [item for item in published if item.endswith((":8001", ":5984", ":8080"))]
    assert len(ports) == 3
    assert all(port.startswith("127.0.0.1:") for port in ports)
    assert "COUCHDB_USER:?" in source and "COUCHDB_PASSWORD:?" in source
    assert "SECRET_KEY:?" in source and "TOTP_ENC_KEY:?" in source
    assert "MONSHINMATE_ENV=production" in source
    assert "./backend:/app" not in source


def test_runtime_dependencies_are_pinned_and_cloud_not_bundled():
    lock = (ROOT / "backend/requirements.lock").read_text().splitlines()
    pinned = [line for line in lock if line.strip() and not line.startswith("#")]
    assert len(pinned) >= 30
    assert all(re.fullmatch(r"[a-zA-Z0-9_.-]+==[a-zA-Z0-9_.+-]+", line) for line in pinned)
    assert "urllib3==2.8.0" in pinned
    docker = (ROOT / "backend/Dockerfile").read_text()
    assert "-r requirements.lock" in docker and "--no-deps -e ." in docker
    assert "COPY private" not in docker and "google-cloud-firestore" not in docker
    assert "USER appuser" in docker


def test_frontend_uses_one_canonical_lock_and_loopback_development():
    package = json.loads((ROOT / "frontend/package.json").read_text())
    assert "20.19.0" in package["engines"]["node"]
    assert "22.12.0" in package["engines"]["node"]
    assert "npm ci" in (ROOT / "frontend/Dockerfile").read_text()
    assert "'127.0.0.1'" in (ROOT / "frontend/vite.config.ts").read_text()


def test_nginx_asset_cache_keeps_security_headers():
    source = (ROOT / "frontend/nginx.conf.template").read_text()
    asset = source.split("location /assets/ {", 1)[1].split("}", 1)[0]
    for header in ("X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Content-Security-Policy"):
        assert header in asset
    assert "client_max_body_size 6m" in source
    assert "location ~ ^/admin/(bootstrap|recovery|reauth)$" in source
