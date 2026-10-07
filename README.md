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
- 管理認証: 今回の指定は明示ポリシーによるパスワードのみ運用。既存パスワードは条件を満たす旧hashのオフライン移行で継承できます。TOTPも利用可能ですが、環境変数の初期/非常用パスワード認証と旧resetは廃止されています。[管理者セットアップ](<internal_docs/admin_system_setup.md>) を参照してください。
- データ永続化: 既定は SQLite。環境変数で CouchDB を有効化するとセッション/回答と共有セキュリティ状態を CouchDB に保存します。
- 運用補助: ヘルスチェック（/health, /healthz, /readyz）、OpenMetrics（/metrics）、監査ログ（パスワード/TOTP変更・ログイン試行）を提供します。

## システム構成
- バックエンド: FastAPI（`backend/app/main.py`）。Uvicorn でポート `8001` を公開。
- フロントエンド: React + Vite + Chakra UI（`frontend/`）。開発は Vite、配信は Nginx（`frontend/Dockerfile`）。
- 永続化:
  - SQLite（既定）: テンプレート/各種設定/監査ログ/管理ユーザー等を保存。`MONSHINMATE_DB` 未設定時は `backend/app/app.sqlite3` を使用。
  - CouchDB（任意）: セッション・回答・共有セキュリティ状態を保存。`COUCHDB_URL` を設定すると有効化。
- LLM ゲートウェイ: ollama または OpenAI 互換 API（LM Studio 等）に接続（`backend/app/llm_gateway.py`）。モデル一覧取得と疎通テストを提供。
- 配布/起動: `docker-compose.yml` で `couchdb` / `backend` / `frontend` を定義。`FRONTEND_HTTP_PORT` でフロントのホスト側ポート変更可。

## クイックスタート（Docker 推奨）
1) [設定例](<.env.example>) と [管理者セットアップ](<internal_docs/admin_system_setup.md>) を確認し、専用CouchDB資格情報・独立した強いJWT/TOTP鍵・MFAポリシーを設定します。既存鍵を不用意に再生成しないでください。開発では合成データのみを使い、本番データとは分離します。その後リポジトリ直下でビルドして起動します。
```
docker compose build
docker compose up -d
```

2) アクセス
- フロントエンド: `http://localhost:5173`（`FRONTEND_HTTP_PORT` で変更可）
- バックエンド API: `http://localhost:8001`
- CouchDB 管理画面: `http://localhost:5984/_utils`（明示設定した専用資格情報。既定 `admin/admin` はありません）

3) 初期セットアップ
- 管理ユーザーは `admin`。現パスワードを継続するアップグレードでは、承認済みオフライン `migrate-legacy` を使います（条件付き・自動移行ではありません）。新規登録だけは単回bootstrap資格情報で行います。固定の初期パスワードはありません。
- 「セキュリティ」から TOTP（二段階認証）を有効化できます（QR を読み取り 6 桁コードを登録）。
- 「LLM 設定」でプロバイダ・ベース URL・モデル・API キーを設定して疎通テストを実行してください（未設定のままでも動作します）。

停止/削除
```
docker compose down
```

補足
- compose では `backend` に `COUCHDB_URL=http://couchdb:5984/` を渡します。セッションは CouchDB に保存され、テンプレートなどは SQLite に保存されます。

## ローカル開発
検証済み: Python 3.12。Node.jsは `^20.19.0 || >=22.12.0`。起動前に `MONSHINMATE_DB` を専用の合成DBパスへ設定し、実DB・実環境ファイルを使用しないでください。

バックエンド（API）
```
cd backend
python -m venv venv
venv\Scripts\activate  # Windows（PowerShell）
# または source venv/bin/activate  # macOS/Linux
pip install --upgrade pip
pip install -r requirements.lock
pip install --no-deps -e .
uvicorn app.main:app --reload --port 8001
```
動作確認: `curl http://localhost:8001/healthz` → `{"status":"ok"}` で正常。

フロントエンド（開発サーバ）
```
cd frontend
npm ci
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
- 管理者/認証: `SECRET_KEY`（JWT署名鍵）、`MONSHINMATE_ADMIN_REQUIRE_MFA`（今回 `0`、必須運用は `1`、未指定の本番は必須。不正値拒否）
- 二段階認証: `TOTP_ENC_KEY`（Fernet 鍵。URL-safe Base64 32byte）
- データベース（SQLite/CouchDB）:
  - `MONSHINMATE_DB`（SQLite ファイルパス。Compose 既定は `/app/data/sqlite/app.sqlite3`）
  - `COUCHDB_URL`、`COUCHDB_DB`（既定 `monshin_sessions`）、`COUCHDB_USER`、`COUCHDB_PASSWORD`
- （CouchDB を使う場合は `COUCHDB_URL` 等を設定してください）
- Cloud Run/Firestoreと秘密情報の起動前注入は [非公開アダプタ運用文書](<private/cloud-run-adapter/README.md>) を参照してください。汎用Composeをその本番設定とみなさないでください。

設定は [Compose](<docker-compose.yml>) と [設定例](<.env.example>) を参照してください。

## 認証と二段階認証（Authenticator/TOTP）
- 今回の指定では `MONSHINMATE_ADMIN_REQUIRE_MFA=0` を明示し、MFA未登録ならパスワードのみでログインします。既存MFA・必須登録・ロックを設定で迂回しません。
- 現パスワードの継続は、非初期・MFA無効などの条件を満たす旧bcryptハッシュのオフライン継承で対応します。変更を強制するbootstrap/recoveryを継続目的で発行しないでください。実アカウントの適用可否と本番ログインは未確認です。
- 新規登録/必要な復旧は、明示対象の単回資格情報を [発行CLI](<backend/tools/provision_admin.py>) で発行します。発行時点で既存アカウントをロック・失効するため、承認・バックアップ・保守計画が必要です。
- MFA有効時はpassword→短命challenge→TOTPの順です。JWTは15分、機密操作は5分再認証。共有CASによる制限/失効を維持します。
- TOTPは「セキュリティ」で登録できます。任意登録の確認前は現在の認証設定を維持します。本番のJWT/TOTP鍵は起動前に独立した強い値を注入し、既存鍵を保持してください。
- 正確な条件・移行手順・72バイト制限は [管理者セットアップ](<internal_docs/admin_system_setup.md>)、認証別のAPI契約は [API仕様](<docs/session_api.md>) を参照してください。

## データ管理（SQLite / CouchDB）
- 既定は SQLite。Compose では `./data/sqlite/app.sqlite3`（コンテナ内 `/app/data/sqlite/app.sqlite3`）に保存します。
- `COUCHDB_URL` を設定すると、セッション/回答と共有セキュリティ状態 CouchDB に保存されます。テンプレート・設定は SQLite に保存します。
- 管理画面の「メイン」カードで、現在の DB 種別（SQLite/CouchDB/エラー）を確認できます。

## 郵便番号辞書
- 住所自動入力用の初期データは `backend/app/postal_code_data/utf_ken_all.csv` に配置しています。
- データ元は日本郵便の「住所の郵便番号（1レコード1行、UTF-8形式）（CSV形式）」です。最新データは https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html から取得できます。
- 初回利用時に上記 CSV から検索用 SQLite 辞書を生成します。生成された `backend/app/postal_code_data/postal_codes.sqlite3` は実行時データのため Git 管理対象外です。
- マスタ更新は管理画面の「郵便番号辞書」から KEN_ALL 形式のUTF-8 CSVを手動アップロードして行えます。更新後は患者基本情報画面の郵便番号による住所自動入力へ反映されます。

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
- ライフチェック/状態: `GET /health` `GET /healthz` `GET /readyz` `GET /metrics` `GET /system/llm-status` `GET /system/database-status`
- テンプレート: `GET /questionnaires` `POST /questionnaires` `DELETE /questionnaires/{id}` `POST /questionnaires/{id}/duplicate` `POST /questionnaires/{id}/rename` `POST /questionnaires/{id}/reset` `POST /questionnaires/default/reset` `GET /questionnaires/{id}/template`
- プロンプト: `GET/POST /questionnaires/{id}/summary-prompt` `GET/POST /questionnaires/{id}/followup-prompt`
- 項目画像/ロゴ: `POST /questionnaire-item-images` `DELETE /questionnaire-item-images/{filename}` `POST /system-logo` `GET /system/logo`
- システム設定: `GET /system/bootstrap`（初期描画用の一括取得） `GET/PUT /system/timezone` `GET/PUT /system/display-name` `GET/PUT /system/entry-message` `GET/PUT /system/completion-message` `GET/PUT /system/theme-color` `GET/PUT /system/pdf-layout` `GET/PUT /system/default-questionnaire`
- セッション: `POST /sessions` `POST /sessions/{id}/answers` `POST /sessions/{id}/llm-questions` `POST /sessions/{id}/llm-answers` `POST /sessions/{id}/finalize`
- 管理/セッション一覧: `GET /admin/sessions`（検索クエリ: `patient_name`/`dob`/`start_date`/`end_date`） `GET /admin/sessions/{id}` `GET /admin/sessions/completed`（Push非対応時の低頻度フォールバック）
- ダウンロード/入出力: `GET /admin/sessions/{id}/download/{fmt}` `GET /admin/sessions/bulk/download/{fmt}` `POST /admin/sessions/export` `POST /admin/sessions/import`
- 削除: `DELETE /admin/sessions/{id}` `POST /admin/sessions/bulk/delete`
- LLM 設定/テスト: `GET/PUT /llm/settings` `POST /llm/settings/test` `POST /llm/list-models`
- 認証/TOTP: `GET /admin/auth/status` `POST /admin/login` `POST /admin/login/totp` `POST /admin/bootstrap` `POST /admin/recovery` `POST /admin/reauth` `POST /admin/password/change` `POST /admin/totp/setup` `POST /admin/totp/verify` `POST /admin/totp/disable`。旧reset・GET setup・PUT modeなどの廃止経路は410です。

公開許可リスト以外は管理JWT必須です。患者操作は専用Bearer `session_token`、サマリー連携は `X-MonshinMate-Api-Key` を使い、互換ではありません。詳細は [API仕様](<docs/session_api.md>) と [管理画面マニュアル](<docs/admin_user_manual.md>) を参照してください。

## 保守ツール
- [管理者オフラインCLI](<backend/tools/provision_admin.py>): `migrate-legacy`（条件付き現パスワード継承）、`bootstrap` / `recovery`（ロック・失効を伴う単回資格情報発行）。旧resetツールは廃止されています。
- `backend/tools/audit_dump.py`: 監査ログのダンプ（`--limit`/`--db`）
- `backend/tools/encrypt_totp_secrets.py`: 既存 DB の TOTP シークレットを暗号化保存へ移行
- `backend/tools/collect_licenses.py`: 依存ライブラリのライセンス情報を収集

 

## Chrome拡張機能

院内運用では、`medical-document-creator-extension`に統合した患者情報タブを使用します。
CLINICSの表示患者と完全一致する確定済み問診履歴を自動取得し、最新問診の基本情報、Markdown本文、初診PDFを確認後にCLINICSへ登録できます。

APIは従来の`POST /patient-summary`を互換維持し、履歴用の`POST /patient-summaries`と初診PDF用の`POST /patient-summary/pdf`を提供します。
従来の[`extensions/patient-summary/`](extensions/patient-summary/)は互換性確認用に残し、新規の院内配布には使用しません。
詳細は[`docs/chrome_extension.md`](docs/chrome_extension.md)と[`docs/session_api.md`](docs/session_api.md)を参照してください。

## ライセンス
- 本プロジェクトは GNU AFFERO GENERAL PUBLIC LICENSE に基づき公開しています。詳細はリポジトリ直下の `LICENSE` を参照してください。

## 但し書き（Firestore について）
- 本リポジトリの本体は、上記のとおり単体で全機能が動作します（Docker Compose またはローカル開発手順のみで可）。
- 作者が管理・運用するサービスでは一部で Firestore を利用しています。これに関連するサブモジュールや設定は、セキュリティ上の理由から非公開としています。
- これらのサブモジュールは本体機能の必須要件ではなく、存在しなくても全機能が利用できます。必要に応じて各自のインフラ（例: 自前の DB/認証/ホスティング）へ置き換えて運用してください。
