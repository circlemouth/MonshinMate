# MonshinMate（問診メイト）
<img width="1366" height="768" alt="問診メイト" src="https://github.com/user-attachments/assets/c741390c-55f5-48a1-8da2-37bd1e11082d" />


問診メイトは、個人クリニックでも、病院でも無料で使える問診システムです。
現役医師が自分のクリニックでの活用を視野に開発しています。

固定問診項目で、**条件分岐質問**や、**年齢や性別で質問の制限**、
患者さんにもわかりやすい、**画像付きの質問も設定**できます。

また、別途LM StudioやOllamaでローカルLLMを接続することで、
外部に患者情報を漏らさず、**AIにフォローアップの追加質問**をさせたり、**問診内容のサマリを作成**させることが可能になります。

バックエンドは FastAPI、フロントエンドは React（Vite + Chakra UI）で構成されています。
Dockerコンテナで簡単にセットアップできます。

## 機能概要
- 問診テンプレート管理: 初診・再診などの受診種別ごとにテンプレートを作成・編集・複製・削除できます。各項目の型、必須設定、選択肢、条件表示、性別条件などを細かく指定できます。
- セッション管理: 患者情報（氏名、生年月日、性別、受診種別）と回答を保存します。固定項目の回答に加えて、LLM が提示した追加質問の「質問文」と「回答」も保存します。
- LLM 連携: 固定フォームで不足している項目に応じて追加質問を生成し、最終サマリーも作成します。OpenAI 互換 API、LM Studio、ollama などに接続できます（UI から設定します）。
- エクスポート: 問診結果を PDF / CSV / Markdown でダウンロードできます。単体出力に加えて、一括 ZIP 出力や CSV 集計にも対応します。
- 管理画面: テンプレート、セッション一覧、LLM 接続設定、見た目設定、ライセンス表示、セキュリティ設定（パスワード・二段階認証）を提供します。
- 二段階認証（Authenticator/TOTP）: 管理者ログインで TOTP に対応します。非常時のリセット導線や暗号化キーによるシークレット保護も備えています。
- データ管理: メタデータ（テンプレートや設定）は SQLite に、セッションデータは CouchDB に保存します（環境変数で有効化）。Docker Compose で CouchDB を同時に起動できます。
- 運用補助: ヘルスチェック（/healthz, /readyz）、OpenMetrics（/metrics）、監査ログなどの保守ツールを同梱しています。

## システム構成
- バックエンド: FastAPI（`backend/app/main.py`）。Uvicorn でポート `8001` を公開します。
- フロントエンド: React + Vite + Chakra UI（`frontend/`）。開発時は Vite、配信は Nginx を使用します。
- データベース:
  - SQLite: `MONSHINMATE_DB` で指定します（Docker Compose 既定: ホスト `./data/sqlite/app.sqlite3`。テンプレート・設定・監査ログ・管理ユーザーなどを保存します）。
  - CouchDB: セッションと回答を保存します（`COUCHDB_URL` を設定すると使用します）。
- LLM ゲートウェイ: OpenAI 互換 API または ollama/LM Studio に接続可能なスタブ実装です（`backend/app/llm_gateway.py`）。モデル一覧取得や接続テストの API を提供します。
- Docker: `docker-compose.yml` で `couchdb`、`backend`、`frontend` を定義しています。

## クイックスタート（Docker 推奨）
1) リポジトリ直下でビルドして起動します。
```
docker compose build
docker compose up -d
```

2) アクセス
- フロントエンド: `http://localhost:5173`（環境変数 `FRONTEND_HTTP_PORT` で変更できます）。
- バックエンド API: `http://localhost:8001`。
- CouchDB 管理画面: `http://localhost:5984/_utils`（compose の既定はユーザー名・パスワードともに `admin` です）。

3) 初期ログインと設定
- 管理ユーザー名は `admin` です。初期パスワードは環境変数 `ADMIN_PASSWORD`（未設定時は `admin`）です。ログイン後に必ず変更してください。
- 管理画面の「セキュリティ」で二段階認証（Authenticator）を有効化できます（QR をスキャンし、6 桁コードを登録します）。
- 「LLM 設定」からベース URL・モデル名・API キーなどを登録し、接続テストを実行してください。

停止/削除
```
docker compose down
```

補足
- compose では `backend` に `COUCHDB_URL=http://couchdb:5984/` を渡します。セッションは CouchDB に保存され、テンプレートなどは引き続き SQLite に保存されます。

## ローカル開発
前提: Python 3.11 以上、Node.js 18 以上。

バックエンド（API）
```
cd backend
python -m venv venv
venv\Scripts\activate  # Windows（PowerShell）
# または source venv/bin/activate  # macOS/Linux
pip install --upgrade pip
pip install -e .
uvicorn app.main:app --reload --port 8001
```
動作確認: `curl http://localhost:8001/healthz` を実行し、`{"status":"ok"}` が返れば正常です。

フロントエンド（開発サーバ）
```
cd frontend
npm install
npm run dev
# http://localhost:5173 を開く（`FRONTEND_HTTP_PORT` で調整可）
```
開発サーバから API へのアクセスは、`frontend/vite.config.ts` のプロキシ設定により `http://localhost:8001` へ転送します（既定で設定済みです）。

一括起動（開発用ユーティリティ）
- macOS/Linux: `./dev.sh` または `make dev`。
- Windows: `powershell -File dev.ps1`。

`dev.sh` はバックエンドとフロントエンドのみを起動します。CouchDB を利用する場合は、別途 `docker compose up couchdb` などで起動し、リポジトリ直下の `.env`（または `backend/.env`）で `COUCHDB_URL` や認証情報を設定してください。

## 環境変数（主要）
- `ADMIN_PASSWORD`: 初期管理者パスワード（既定: `admin`）。初回起動の判定にも使用します。
- `ADMIN_EMERGENCY_RESET_PASSWORD`: 非常用リセットパスワード。TOTP が無効な場合に限り、UI のパスワードリセットで利用できます。
- `SECRET_KEY`: パスワードリセット用トークンの署名鍵（JWT）。本番では十分に強いランダム値を設定してください。
- `MONSHINMATE_DB`: SQLite のファイルパス（Docker Compose 既定: `/app/data/sqlite/app.sqlite3` → ホスト `./data/sqlite/app.sqlite3`。未設定時は従来の `backend/app/app.sqlite3` を参照します）。
- `TOTP_ENC_KEY`: TOTP シークレット暗号化用キー（Fernet/32byte を URL-safe Base64 化）。本番では必須です。
- `COUCHDB_URL`: CouchDB のベース URL（設定すると、セッション保存先が CouchDB に切り替わります）。
- `COUCHDB_DB`: 使用する DB 名（既定: `monshin_sessions`）。
- `COUCHDB_USER`, `COUCHDB_PASSWORD`: CouchDB の認証情報。

Docker Compose の既定値は `docker-compose.yml` と、リポジトリ直下の `.env.example`（ローカル開発向け）を参照してください。Cloud Run 向けの環境変数例は、非公開サブモジュール（`private/cloud-run-adapter/.env.cloudrun.example`）に用意しています。

## 認証と二段階認証（Authenticator/TOTP）
- 管理ログインにはパスワードが必須です。初回は `admin` / `ADMIN_PASSWORD` でログインし、パスワードを変更してください。
- 二段階認証は管理画面の「セキュリティ」で有効化します。QR を Authenticator アプリで読み取り、6 桁コードを登録します。
- 非常時の復旧:
  - TOTP が無効のときは、`ADMIN_EMERGENCY_RESET_PASSWORD` を設定していれば UI から非常用パスワードでリセットできます。
  - UI 操作ができない場合は、`backend/tools/reset_admin_password.py` を実行して TOTP を無効化・初期化できます。実行前に必ず DB をバックアップしてください。
- セキュリティ強化:
  - `TOTP_ENC_KEY` を設定し、TOTP シークレットを暗号化して保存します。
  - 重要操作は監査ログとして `backend/app/logs/security.log` と SQLite の `audit_logs` に記録します（平文のパスワードやハッシュは記録しません）。

## データ管理（SQLite + CouchDB）
- 既定では、すべて SQLite を使用します。Docker Compose のサンプルでは `./data/sqlite/app.sqlite3`（コンテナ内は `/app/data/sqlite/app.sqlite3`）に保存します。
- `COUCHDB_URL` を設定すると、セッション/回答のみ CouchDB に保存されます。テンプレートや設定は引き続き SQLite に保存します。
- CouchDB は `docker-compose.yml` で自動起動し、ホスト `./data/couchdb` を `/opt/couchdb/data` にマウントします。管理画面は `/_utils` から利用できます。

## エクスポート（PDF / CSV / Markdown）
- 管理画面のセッション一覧で、各行のアイコンから単体の PDF / Markdown / CSV をダウンロードできます。
- 一括出力ボタンで、複数選択の ZIP（PDF/MD）または集計 CSV をダウンロードできます。
- バックエンド API:
  - `GET /admin/sessions/{id}/download/{fmt}`（`fmt=md|pdf|csv`）
  - `GET /admin/sessions/bulk/download/{fmt}`（`ids=...`。MD/PDF は ZIP、CSV は 1 枚の集計）

## 主な API（抜粋）
- ライフチェック: `GET /healthz`, `GET /readyz`, `GET /metrics`
- テンプレート: `GET/POST/DELETE /questionnaires...`、各種プロンプト設定 `.../summary-prompt`, `.../followup-prompt`
- セッション: `POST /sessions`, `POST /sessions/{id}/answers`, `POST /sessions/{id}/llm-questions`, `POST /sessions/{id}/llm-answers`, `POST /sessions/{id}/finalize`
- LLM 設定/テスト: `GET/PUT /llm/settings`, `POST /llm/settings/test`, `POST /llm/list-models`
- 管理/セキュリティ: `POST /admin/login`, `POST /admin/password(change|reset/*)`, `GET/PUT /admin/totp/*`, `GET /admin/sessions`

詳細仕様は `docs/session_api.md` および管理画面の公開ドキュメント（`frontend/public/docs/*.md`）を参照してください。

## 保守ツール
- `backend/tools/reset_admin_password.py`: 管理者パスワードを強制リセットします（TOTP 無効化を含みます）。
- `backend/tools/audit_dump.py`: 監査ログをダンプします（`--limit` / `--db` の指定可）。
- `backend/tools/encrypt_totp_secrets.py`: 既存 DB の TOTP シークレットを暗号化保存へ移行します。

## Cloud Run / Firestore 拡張（プライベートモジュール）
- Google Cloud Run + Firestore 向けの永続化アダプタと Secret Manager 連携は、`private/` 配下に追加する非公開サブモジュールで提供します。
- プライベートモジュールを導入した場合は、以下の環境変数で実装を指定してください。
  - `MONSHINMATE_FIRESTORE_ADAPTER=monshinmate_cloud.firestore_adapter:FirestoreAdapter`
  - `MONSHINMATE_SECRET_MANAGER_ADAPTER=monshinmate_cloud.secret_manager:load_secrets`
- サブモジュールの配置例や要件は `private/README.md` を参照してください。プラグインが存在しない場合は、既定の SQLite + CouchDB 構成で動作します。

## ライセンス
- 本プロジェクトは GNU AFFERO GENERAL PUBLIC LICENSE に基づき公開しています。詳細はリポジトリ直下の `LICENSE` を参照してください。
