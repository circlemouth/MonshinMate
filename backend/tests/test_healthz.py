"""ヘルスチェックエンドポイントのテスト。"""
from pathlib import Path
import sys

# 親ディレクトリをモジュール検索パスに追加
sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app  # type: ignore[import]
from fastapi.testclient import TestClient


def test_healthz() -> None:
    """/healthz が正常に応答することを確認する。"""
    client = TestClient(app)
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
