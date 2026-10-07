"""ヘルスチェックエンドポイントのテスト。"""
from pathlib import Path
import sys

# 親ディレクトリをモジュール検索パスに追加
sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app  # type: ignore[import]
from fastapi.testclient import TestClient


def test_health_endpoints() -> None:
    """/health と /healthz が正常に応答することを確認する。"""
    client = TestClient(app)
    for path in ["/health", "/healthz"]:
        resp = client.get(path)
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


def test_readyz(monkeypatch) -> None:
    """公開 readiness は外部LLMの状態に依存せず再現可能に検証する。"""
    from types import SimpleNamespace
    from app import main
    monkeypatch.setattr(main, "get_current_persistence_backend", lambda: "sqlite")
    monkeypatch.setattr(main, "llm_gateway", SimpleNamespace(
        settings=SimpleNamespace(enabled=False, base_url=None),
        get_status_snapshot=lambda: {"status": "disabled"},
    ))
    client = TestClient(app)
    resp = client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ready"}


def test_readiness_backend_failure_and_metrics_auth(monkeypatch) -> None:
    from types import SimpleNamespace
    from app import main
    monkeypatch.setattr(main, "get_current_persistence_backend", lambda: "firestore")
    monkeypatch.setattr(main, "check_firestore_health", lambda: False)
    monkeypatch.setattr(main, "llm_gateway", SimpleNamespace(
        settings=SimpleNamespace(enabled=False, base_url=None),
        get_status_snapshot=lambda: {"status": "disabled"},
    ))
    client = TestClient(app)
    response = client.get("/readyz")
    assert response.status_code == 200
    assert response.json()["status"] == "not_ready"
    assert client.get("/metrics").status_code == 401
