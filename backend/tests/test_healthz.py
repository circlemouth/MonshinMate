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


def test_readyz() -> None:
    """/readyz が依存確認に成功することを確認する。"""
    client = TestClient(app)
    resp = client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"
