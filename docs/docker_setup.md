# Docker での起動手順

## 前提
- Docker および Docker Compose がインストールされていること

## ビルドと起動
```bash
docker compose build
docker compose up -d
```
- フロントエンド: http://localhost:5173
- バックエンド: http://localhost:8001

## データ永続化
- SQLite データベースは `backend/app/app.sqlite3` に作成され、ホスト側にボリュームとして保持されます。
