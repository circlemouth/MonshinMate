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
- 問診テンプレート管理: 初診・再診ごとにテンプレートを作成・編集・複製・削除・ID変更できます。項目の型（string/multi/yesno/date/slider）、必須、選択肢、条件表示（when）、年齢・性別による表示制限、説明文、画像添付に対応。テンプレート一式のエクスポート/インポート（画像同梱・任意パスワード暗号化）も可能です。
- セッション管理: 氏名・生年月日・性別・受診種別と全回答を保存。固定フォームの回答に加えて、LLM 追加質問の「質問文」と回答も履歴化します。検索（氏名/生年月日/期間）、詳細表示、単体/一括ダウンロード（PDF/Markdown/CSV）、単体/一括削除、JSON エクスポート/インポート（任意パスワード暗号化）に対応。
- LLM 連携: 不足項目に応じた追加質問の生成と、問診完了時の要約作成を提供。ollama もしくは OpenAI 互換（LM Studio 等）に接続できます。プロバイダ・モデル・温度・システムプロンプト・タイムアウトは管理画面から設定でき、モデル一覧取得と疎通テストを備えます（既定は無効で、設定しない限り外部送信はありません）。
- エクスポート/出力: 問診結果を PDF / CSV / Markdown で出力可能。複数選択の ZIP（MD/PDF）や集計 CSV に対応。テンプレート・セッションの JSON エクスポート/インポートはパスワード付き暗号化（Fernet）に対応し、画像（項目画像・ロゴ）も同梱します。
- 管理画面（設定）: タイムゾーン、施設表示名、導入文/完了文のカスタマイズ、テーマカラー、ロゴ/アイコンのアップロード、PDF レイアウト（構造化/レガシー）、既定テンプレートの切替を提供します。状態カードで DB 種別・LLM 疎通状況を表示します。
- 二段階認証（Authenticator/TOTP）: 管理者ログインに TOTP を導入できます。TOTP シークレットの暗号化保存（`TOTP_ENC_KEY`）や非常用リセット（`ADMIN_EMERGENCY_RESET_PASSWORD`）、適用モード（off/reset_only/login_and_reset）を備えます。
- データ永続化: 既定は SQLite。環境変数で CouchDB を有効化するとセッション/回答のみを CouchDB に保存します。
- 運用補助: ヘルスチェック（/health, /healthz, /readyz）、メトリクス（/metrics, /metrics/ui）、監査ログ（パスワード/TOTP変更・ログイン試行）を提供します。

## システム構成
- バックエンド: FastAPI（`backend/app/main.py`）。Uvicorn でポート `8001` を公開。
- フロントエンド: React + Vite + Chakra UI（`frontend/`）。開発は Vite、配信は Nginx（`frontend/Dockerfile`）。
- 永続化:
  - SQLite（既定）: テンプレート/各種設定/監査ログ/管理ユーザー等を保存。`MONSHINMATE_DB` 未設定時は `backend/app/app.sqlite3` を使用。
  - CouchDB（任意）: セッションと回答を保存。`COUCHDB_URL` を設定すると有効化。
- LLM ゲートウェイ: ollama または OpenAI 互換 API（LM Studio 等）に接続（`backend/app/llm_gateway.py`）。モデル一覧取得と疎通テストを提供。
- 配布/起動: `docker-compose.yml` で `couchdb` / `backend` / `frontend` を定義。`FRONTEND_HTTP_PORT` でフロントのホスト側ポート変更可。

## クイックスタート（Docker 推奨）
1) リポジトリ直下でビルドして起動します。
```
docker compose build
docker compose up -d
```

2) アクセス
- フロントエンド: `http://localhost:5173`（`FRONTEND_HTTP_PORT` で変更可）
- バックエンド API: `http://localhost:8001`
- CouchDB 管理画面: `http://localhost:5984/_utils`（既定ユーザー `admin/admin`）

3) 初期セットアップ
- 管理ユーザーは `admin`。初期パスワードは `ADMIN_PASSWORD`（未設定時は `admin`）です。ログイン後に必ず変更してください。
- 「セキュリティ」から TOTP（二段階認証）を有効化できます（QR を読み取り 6 桁コードを登録）。
- 「LLM 設定」でプロバイダ・ベース URL・モデル・API キーを設定して疎通テストを実行してください（未設定のままでも動作します）。

停止/削除
```
docker compose down
```

補足
- compose では `backend` に `COUCHDB_URL=http://couchdb:5984/` を渡します。セッションは CouchDB に保存され、テンプレートなどは SQLite に保存されます。

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
動作確認: `curl http://localhost:8001/healthz` → `{"status":"ok"}` で正常。

フロントエンド（開発サーバ）
```
cd frontend
npm install
npm run dev
# http://localhost:5173 を開く（`FRONTEND_HTTP_PORT` で調整可）
```
開発サーバの API へのアクセスは `frontend/vite.config.ts` のプロキシで `http://localhost:8001` へ転送されます。

一括起動（開発用ユーティリティ）
- macOS/Linux: `./dev.sh` または `make dev`
- Windows: `powershell -File dev.ps1`

補足: `dev.sh` はバックエンド/フロントのみを起動します。CouchDB を利用する場合は `docker compose up couchdb` で起動し、`.env` で `COUCHDB_URL` 等を設定してください。

## 環境変数（主要）
- 基本/実行: `MONSHINMATE_ENV`（既定 `local`）、`FRONTEND_HTTP_PORT`
- 管理者/認証: `ADMIN_PASSWORD`、`ADMIN_EMERGENCY_RESET_PASSWORD`、`SECRET_KEY`（JWT 署名鍵）
- 二段階認証: `TOTP_ENC_KEY`（Fernet 鍵。URL-safe Base64 32byte）
- データベース（SQLite/CouchDB）:
  - `MONSHINMATE_DB`（SQLite ファイルパス。Compose 既定は `/app/data/sqlite/app.sqlite3`）
  - `COUCHDB_URL`、`COUCHDB_DB`（既定 `monshin_sessions`）、`COUCHDB_USER`、`COUCHDB_PASSWORD`
- （CouchDB を使う場合は `COUCHDB_URL` 等を設定してください）
- Secret Manager（任意・プライベートモジュール導入時）:
  - `MONSHINMATE_SECRET_MANAGER_ADAPTER`（例: `monshinmate_cloud.secret_manager:load_secrets`）
  - `SECRET_MANAGER_ENABLED`、`SECRET_MANAGER_PROJECT`、`SECRET_MANAGER_PREFIX`
- ファイルストレージ（任意）: `FILE_STORAGE_BACKEND`（既定 `local`）、`GCS_BUCKET`、`STORAGE_EMULATOR_HOST`、`GCS_SIGNED_URL_TTL`

Docker Compose の既定値は `docker-compose.yml` と `.env.example` を参照してください。

## 認証と二段階認証（Authenticator/TOTP）
- 管理ログインにはパスワードが必須です。初回は `admin` / `ADMIN_PASSWORD` でログインし、速やかに変更してください。
- 二段階認証は管理画面「セキュリティ」で有効化します。QR を Authenticator アプリで読み取り、6 桁コードを登録します。
- 非常時の復旧:
  - TOTP が無効のときは `ADMIN_EMERGENCY_RESET_PASSWORD` 設定時に UI から非常用パスワードで初期化できます。
  - UI が使えない場合は `backend/tools/reset_admin_password.py` で初期化（実行前に DB バックアップを推奨）。
- セキュリティ強化:
  - `TOTP_ENC_KEY` を設定すると TOTP シークレットを暗号化保存します。
  - パスワード変更/TOTP 状態変更/ログイン試行は `backend/app/logs/security.log` と SQLite `audit_logs` に監査記録します（PII は平文で出力しません）。

## データ管理（SQLite / CouchDB）
- 既定は SQLite。Compose では `./data/sqlite/app.sqlite3`（コンテナ内 `/app/data/sqlite/app.sqlite3`）に保存します。
- `COUCHDB_URL` を設定すると、セッション/回答のみ CouchDB に保存されます。テンプレート・設定は SQLite に保存します。
- 管理画面の「メイン」カードで、現在の DB 種別（SQLite/CouchDB/エラー）を確認できます。

## エクスポート（PDF / CSV / Markdown / JSON）
- 管理画面のセッション一覧から、単体の PDF / Markdown / CSV をダウンロードできます。
- 一括出力ボタンで、複数選択の ZIP（PDF/MD）または集計 CSV をダウンロードできます。
- テンプレート設定・問診データの JSON エクスポート/インポートに対応。任意パスワードで暗号化できます（インポートは merge/replace 指定）。
- バックエンド API 例:
  - `GET /admin/sessions/{id}/download/{fmt}`（`fmt=md|pdf|csv`）
  - `GET /admin/sessions/bulk/download/{fmt}`（`ids=...`。MD/PDF は ZIP、CSV は 1 枚の集計）
  - `POST /admin/questionnaires/export` / `POST /admin/questionnaires/import`
  - `POST /admin/sessions/export` / `POST /admin/sessions/import`

## 主な API（抜粋）
- ライフチェック/状態: `GET /health` `GET /healthz` `GET /readyz` `GET /metrics` `POST /metrics/ui` `GET /system/llm-status` `GET /system/database-status`
- テンプレート: `GET /questionnaires` `POST /questionnaires` `DELETE /questionnaires/{id}` `POST /questionnaires/{id}/duplicate` `POST /questionnaires/{id}/rename` `POST /questionnaires/{id}/reset` `POST /questionnaires/default/reset` `GET /questionnaires/{id}/template`
- プロンプト: `GET/POST /questionnaires/{id}/summary-prompt` `GET/POST /questionnaires/{id}/followup-prompt`
- 項目画像/ロゴ: `POST /questionnaire-item-images` `DELETE /questionnaire-item-images/{filename}` `POST /system-logo` `GET /system/logo`
- システム設定: `GET/PUT /system/timezone` `GET/PUT /system/display-name` `GET/PUT /system/entry-message` `GET/PUT /system/completion-message` `GET/PUT /system/theme-color` `GET/PUT /system/pdf-layout` `GET/PUT /system/default-questionnaire`
- セッション: `POST /sessions` `POST /sessions/{id}/answers` `POST /sessions/{id}/llm-questions` `POST /sessions/{id}/llm-answers` `POST /sessions/{id}/finalize`
- 管理/セッション一覧: `GET /admin/sessions`（検索クエリ: `patient_name`/`dob`/`start_date`/`end_date`） `GET /admin/sessions/{id}` `GET /admin/sessions/updates`
- ダウンロード/入出力: `GET /admin/sessions/{id}/download/{fmt}` `GET /admin/sessions/bulk/download/{fmt}` `POST /admin/sessions/export` `POST /admin/sessions/import`
- 削除: `DELETE /admin/sessions/{id}` `POST /admin/sessions/bulk/delete`
- LLM 設定/テスト: `GET/PUT /llm/settings` `POST /llm/settings/test` `POST /llm/list-models`
- 認証/TOTP: `GET /admin/auth/status` `POST /admin/login` `POST /admin/password` `POST /admin/password/change` `POST /admin/password/reset/request` `POST /admin/password/reset/confirm` `POST /admin/password/reset/emergency` `GET/PUT /admin/totp/mode` `GET /admin/totp/setup` `POST /admin/totp/verify` `POST /admin/totp/disable` `POST /admin/totp/regenerate`

詳細仕様は `docs/session_api.md` と管理画面マニュアル（`docs/admin_user_manual.md`）を参照してください。

## 保守ツール
- `backend/tools/reset_admin_password.py`: 管理者パスワードを強制リセット（TOTP 無効化を含む）
- `backend/tools/audit_dump.py`: 監査ログのダンプ（`--limit`/`--db`）
- `backend/tools/encrypt_totp_secrets.py`: 既存 DB の TOTP シークレットを暗号化保存へ移行
- `backend/tools/collect_licenses.py`: 依存ライブラリのライセンス情報を収集

 

## ライセンス
- 本プロジェクトは GNU AFFERO GENERAL PUBLIC LICENSE に基づき公開しています。詳細はリポジトリ直下の `LICENSE` を参照してください。

## 但し書き（Firestore について）
- 本リポジトリの本体は、上記のとおり単体で全機能が動作します（Docker Compose またはローカル開発手順のみで可）。
- 作者が管理・運用するサービスでは一部で Firestore を利用しています。これに関連するサブモジュールや設定は、セキュリティ上の理由から非公開としています。
- これらのサブモジュールは本体機能の必須要件ではなく、存在しなくても全機能が利用できます。必要に応じて各自のインフラ（例: 自前の DB/認証/ホスティング）へ置き換えて運用してください。
