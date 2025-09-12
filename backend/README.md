# 問診メイト バックエンド

このディレクトリには FastAPI ベースの簡易 API を配置している。

## エンドポイント
- `GET /healthz` : 死活監視用。`{"status": "ok"}` を返す。
- `GET /` : 動作確認用の挨拶を返す。

## ローカル実行
```bash
uvicorn app.main:app --reload
```

## テスト
```bash
pytest
```
