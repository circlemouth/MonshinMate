"""Run tests against a source-only temporary checkout and synthetic credentials.

The repository's SQLite files, .env files, assets, logs, private adapters and
inherited cloud credentials are never copied. Legacy tests that delete files
relative to __file__ therefore cannot delete a developer's application data.
Usage: venv/bin/python backend/tools/run_security_tests.py [pytest arguments]
"""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import base64


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    destination = Path(tempfile.mkdtemp(prefix="monshinmate-security-tests-"))
    backend = destination / "backend"
    for subdirectory in ("app", "tests", "tools"):
        for source in (root / "backend" / subdirectory).rglob("*.py"):
            target = destination / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    for relative in ("backend/pyproject.toml", "backend/requirements.lock",
                     "backend/Dockerfile", "frontend/Dockerfile", ".dockerignore",
                     "docker-compose.yml", "frontend/nginx.conf.template",
                     "frontend/vite.config.ts", "frontend/package.json"):
        source = root / relative
        if source.is_file():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    environment = {
        "PATH": os.defpath,
        "HOME": str(destination),
        "LANG": "C.UTF-8",
        "PYTHONPATH": str(backend),
        "PYTHONDONTWRITEBYTECODE": "1",
        "MONSHINMATE_ENV": "test",
        "PERSISTENCE_BACKEND": "sqlite",
        "MONSHINMATE_DB": str(backend / "app" / "app.sqlite3"),
        "SECRET_MANAGER_ENABLED": "0",
        "MIGRATE_LEGACY_ASSETS_ON_STARTUP": "0",
        "SECRET_KEY": secrets.token_urlsafe(48),
        "TOTP_ENC_KEY": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
    }
    print(f"Isolated synthetic test checkout: {destination}", flush=True)
    arguments = sys.argv[1:] or ["-q"]
    completed = subprocess.run([sys.executable, "-m", "pytest", *arguments],
                               cwd=backend, env=environment, check=False)
    print(f"[exit code: {completed.returncode}]", flush=True)
    # Retain this synthetic-only directory for failure diagnosis; no live data.
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
