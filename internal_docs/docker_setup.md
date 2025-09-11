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
- CouchDB 管理画面: http://localhost:5984/_utils
  - `docker-compose.yml` では CouchDB の認証情報を `COUCHDB_USER` と `COUCHDB_PASSWORD` で指定する。
  - `backend/.env` には `COUCHDB_URL=http://couchdb:5984/` が既定で含まれており、そのまま compose 内の CouchDB に接続できる。CouchDB を使わない場合はこの行をコメントアウトするか削除する。`backend/.env copy.example` も同内容のテンプレートであり、必要に応じてコピーして使用する。
- `_users` データベースが存在しない場合、バックエンド起動時に自動作成されるため、
  初回起動時の認証キャッシュエラーが解消される。

## データ永続化
 - セッションデータは CouchDB に保存され、`couchdb_data` ボリュームで永続化されます。
 - テンプレートなどのメタデータは `backend/app/app.sqlite3` に保存されます。
   - 初回起動時に自動作成され、リポジトリには同梱されません。
   - 既存環境で旧DBを利用する場合はそのまま残してください。新規セットアップで既定パスワードを利用したい場合は `backend/app/app.sqlite3` を削除してから起動します。
