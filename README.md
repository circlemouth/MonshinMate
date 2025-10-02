# MonshinMate（問診メイト）
<img width="1366" height="768" alt="問診メイト" src="https://github.com/user-attachments/assets/c741390c-55f5-48a1-8da2-37bd1e11082d" />


MonshinMate は、診療所やクリニックのための「問診テンプレート管理」「患者回答収集」「LLM による追加質問とサマリー生成」「各種エクスポート（PDF/CSV/Markdown）」を提供するフルスタックのローカル実行システムです。バックエンドは FastAPI、フロントエンドは React（Vite + Chakra UI）で構成されています。

本 README はシステム全体像、主要機能、セットアップ（Docker を含む）、必要な環境変数、二段階認証（Authenticator/TOTP）、CouchDB を用いたデータ管理の概要をまとめています。

## 機能概要
- 問診テンプレート管理: 初診/再診など受診種別ごとにテンプレートを作成・編集・複製・削除。項目ごとに型・必須・選択肢・条件表示・性別条件などを詳細設定。
- セッション管理: 患者情報（氏名/生年月日/性別/受診種別）と回答を保存。固定項目の回答に加え、LLM が提示した「追加質問の質問文と回答」も保存。
- LLM 連携: 固定フォームの不足項目に応じた追加質問の生成、最終サマリー（Markdown テキスト）の生成。OpenAI 互換 API/LM Studio/ollama 等の接続を想定（UI から設定）。
- エクスポート: 問診結果を PDF / CSV / Markdown でダウンロード（単体・一括ZIP/CSV 集計に対応）。
- 管理画面: テンプレート、セッション一覧、LLM 接続設定、見た目設定、ライセンス表示、セキュリティ設定（パスワード/二段階認証）。
- 二段階認証（Authenticator/TOTP）: 管理者ログインに TOTP 対応。非常時のリセット導線や暗号化キーによるシークレット保護に対応。
- データ管理: メタデータ（テンプレートや設定）は SQLite、セッションデータは CouchDB（環境変数で有効化）に保存。Docker Compose で CouchDB を同時起動可能。
- 運用補助: ヘルスチェック（/healthz, /readyz）、OpenMetrics（/metrics）、監査ログ、保守ツール同梱。

## システム構成
- バックエンド: FastAPI（`backend/app/main.py`）。Uvicorn で `:8001` を公開。
- フロントエンド: React + Vite + Chakra UI（`frontend/`）。開発は Vite、コンテナ配信は Nginx。
- データベース:
  - SQLite: `MONSHINMATE_DB` で指定（Docker Compose 既定: ホスト `./data/sqlite/app.sqlite3`。テンプレート・設定・監査ログ・管理ユーザーなどを保存）
  - CouchDB: セッション/回答を保存（`COUCHDB_URL` を設定すると使用）。
- LLM ゲートウェイ: OpenAI 互換 API または ollama/LM Studio へ接続可能なスタブ実装（`backend/app/llm_gateway.py`）。モデル一覧取得や接続テスト API を提供。
- Docker: `docker-compose.yml` で `couchdb`/`backend`/`frontend` を定義。

## クイックスタート（Docker 推奨）
1) リポジトリ直下でビルド/起動
```
docker compose build
docker compose up -d
```

2) アクセス
- フロントエンド: `http://localhost:5173`（環境変数 `FRONTEND_HTTP_PORT` で変更可能）
- バックエンド API: `http://localhost:8001`
- CouchDB 管理画面: `http://localhost:5984/_utils`（compose 既定は user/pass 共に `admin`）

3) 初期ログインと設定
- 管理ユーザー名は `admin` です。初期パスワードは環境変数 `ADMIN_PASSWORD`（未設定時は `admin`）。ログイン後に必ず変更してください。
- 管理画面の「セキュリティ」で二段階認証（Authenticator）を有効化できます（QR スキャン→6 桁コード）。
- 「LLM 設定」からベース URL・モデル名・API キー等を登録し、接続テストを実行してください。

停止/削除
```
docker compose down
```

補足
- compose では `backend` に `COUCHDB_URL=http://couchdb:5984/` を渡しており、セッションは CouchDB に保存されます。テンプレート等は引き続き SQLite に保存されます。

## ローカル開発
前提: Python 3.11+ / Node.js 18+

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
動作確認: `curl http://localhost:8001/healthz` → `{"status":"ok"}`

フロントエンド（開発サーバ）
```
cd frontend
npm install
npm run dev
# http://localhost:5173 を開く（`FRONTEND_HTTP_PORT` で調整可）
```
開発サーバから API へは `frontend/vite.config.ts` のプロキシ設定で `http://localhost:8001` に転送します（既定で設定済み）。

一括起動（開発用ユーティリティ）
- macOS/Linux: `./dev.sh` または `make dev`
- Windows: `powershell -File dev.ps1`

`dev.sh` はバックエンドとフロントエンドのみを起動します。CouchDB を利用する場合は別途 `docker compose up couchdb` などで起動し、リポジトリ直下の `.env`（または `backend/.env` を作成）で `COUCHDB_URL` や認証情報を設定してください。

## 環境変数（主要）
- `ADMIN_PASSWORD`: 初期管理者パスワード（既定: `admin`）。初回起動判定にも使用。
- `ADMIN_EMERGENCY_RESET_PASSWORD`: 非常用リセットパスワード。TOTP 無効時のみ UI のパスワードリセットで利用可。
- `SECRET_KEY`: パスワードリセット用トークンの署名鍵（JWT）。本番では十分に強いランダム値を設定してください。
- `MONSHINMATE_DB`: SQLite ファイルパス（Docker Compose 既定: `/app/data/sqlite/app.sqlite3` → ホスト `./data/sqlite/app.sqlite3`。未設定時は従来の `backend/app/app.sqlite3` を参照）。
- `TOTP_ENC_KEY`: TOTP シークレット暗号化用キー（Fernet/32byte を URL-safe Base64 化）。本番必須。
- `COUCHDB_URL`: CouchDB のベース URL（設定するとセッション保存が CouchDB に切替）。
- `COUCHDB_DB`: 使用 DB 名（既定: `monshin_sessions`）。
- `COUCHDB_USER`, `COUCHDB_PASSWORD`: CouchDB の認証情報。

Docker Compose での既定値は `docker-compose.yml` と リポジトリ直下の `.env.example` を参照してください。

## 認証と二段階認証（Authenticator/TOTP）
- 管理ログインはパスワード必須。初回は `admin`/`ADMIN_PASSWORD` でログインし、パスワードを変更してください。
- 二段階認証は管理画面「セキュリティ」で有効化。QR を Authenticator アプリで読み取り、6 桁コードを登録します。
- 非常時の復旧:
  - TOTP が無効のとき: `ADMIN_EMERGENCY_RESET_PASSWORD` を設定していれば、UI から非常用パスワードでリセット可能。
  - どうしても UI 操作ができない場合: `backend/tools/reset_admin_password.py` を実行（TOTP を無効化し初期化）。実行前に必ず DB をバックアップしてください。
- セキュリティ強化:
  - `TOTP_ENC_KEY` を設定して TOTP シークレットを暗号化保存。
  - 重要操作は監査ログとして `backend/app/logs/security.log` と SQLite の `audit_logs` に記録（平文 PW/ハッシュは記録しません）。

## データ管理（SQLite + CouchDB）
- 既定: すべて SQLite。Docker Compose のサンプルでは `./data/sqlite/app.sqlite3`（コンテナ内 `/app/data/sqlite/app.sqlite3`）に保存します。
- CouchDB 有効時（`COUCHDB_URL` を設定）: セッション/回答のみ CouchDB に保存。テンプレートや設定は引き続き SQLite。
- CouchDB は `docker-compose.yml` で自動起動し、ホスト `./data/couchdb` を `/opt/couchdb/data` にマウントします。管理画面は `/_utils` から利用可能。

## エクスポート（PDF / CSV / Markdown）
- 管理画面のセッション一覧で、各行のアイコンから単体の PDF/Markdown/CSV をダウンロード可能。
- 一括出力ボタンで複数選択の ZIP（PDF/MD）または集計 CSV をダウンロード可能。
- バックエンド API:
  - `GET /admin/sessions/{id}/download/{fmt}`（`fmt=md|pdf|csv`）
  - `GET /admin/sessions/bulk/download/{fmt}`（`ids=...`、MD/PDF は ZIP、CSV は1枚の集計）

## 主な API（抜粋）
- ライフチェック: `GET /healthz`, `GET /readyz`, `GET /metrics`
- テンプレート: `GET/POST/DELETE /questionnaires...`、各種プロンプト設定 `.../summary-prompt`, `.../followup-prompt`
- セッション: `POST /sessions`, `POST /sessions/{id}/answers`, `POST /sessions/{id}/llm-questions`, `POST /sessions/{id}/llm-answers`, `POST /sessions/{id}/finalize`
- LLM 設定/テスト: `GET/PUT /llm/settings`, `POST /llm/settings/test`, `POST /llm/list-models`
- 管理/セキュリティ: `POST /admin/login`, `POST /admin/password(change|reset/*)`, `GET/PUT /admin/totp/*`, `GET /admin/sessions`

詳細仕様は `docs/session_api.md` および管理画面の公開ドキュメント（`frontend/public/docs/*.md`）を参照してください。

## 保守ツール
- `backend/tools/reset_admin_password.py`: 管理者パスワード強制リセット（TOTP 無効化含む）。
- `backend/tools/audit_dump.py`: 監査ログのダンプ（`--limit`/`--db` 指定可）。
- `backend/tools/encrypt_totp_secrets.py`: 既存 DB の TOTP シークレットを暗号化に移行。

## ライセンス
- 本プロジェクトは GNU GPL v3.0 に基づき公開されています。詳細はリポジトリ直下の `LICENSE` を参照してください。

