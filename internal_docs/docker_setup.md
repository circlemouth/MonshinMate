# Docker での起動手順

## 前提
- Docker および Docker Compose がインストールされていること

## ビルドと起動
```bash
docker compose build
docker compose up -d
```
- フロントエンド: http://localhost:5173（環境変数 FRONTEND_HTTP_PORT で変更可能）
- バックエンド: http://localhost:8001
- CouchDB 管理画面: http://localhost:5984/_utils
- `docker-compose.yml` では CouchDB の認証情報を `COUCHDB_USER` と `COUCHDB_PASSWORD` で指定する。
  - ルートに配置した `.env` の値が compose から参照される。サンプルは `.env.example` を参照し、必要に応じて `COUCHDB_URL` などを上書きする。
  - 各サービスに `restart: unless-stopped` を設定しているため、ホスト側で Docker が再起動した場合も自動的に立ち上がります。手動で停止したい場合は `docker compose stop` もしくは `docker compose down` を実行してください。
- `_users` データベースが存在しない場合、バックエンド起動時に自動作成されるため、
  初回起動時の認証キャッシュエラーが解消される。

## データ永続化
- セッションデータは CouchDB に保存され、ホストの `./data/couchdb` を `/opt/couchdb/data` にマウントして永続化します。
- テンプレートなどのメタデータは SQLite に保存され、Docker Compose の既定ではホスト `./data/sqlite/app.sqlite3`（コンテナ内 `/app/data/sqlite/app.sqlite3`）を利用します。
  - 既存環境で旧パス `backend/app/app.sqlite3` を使用している場合は、ファイルを `./data/sqlite/app.sqlite3` に移動するか、`MONSHINMATE_DB` を旧パスに設定してください。
  - 新規セットアップ時は `./data/sqlite/` 配下が空でも自動的に SQLite ファイルが生成されます。
