from pathlib import Path
import sys

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.main import app, on_startup  # type: ignore
from fastapi.testclient import TestClient

client = TestClient(app)


def test_theme_color_get_and_set() -> None:
    """テーマカラーの取得と更新ができることを確認する。"""
    on_startup()
    res = client.get('/system/theme-color')
    assert res.status_code == 200
    assert res.json()['theme'] == 'blue'

    res = client.put('/system/theme-color', json={'theme': 'green'})
    assert res.status_code == 200
    assert res.json()['theme'] == 'green'

    res = client.get('/system/theme-color')
    assert res.status_code == 200
    assert res.json()['theme'] == 'green'
