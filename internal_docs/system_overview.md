# MonshinMate システム概要（エージェント向け）

## 1. 文書の目的と対象
- 本書は MonshinMate（問診メイト）の**現行実装**を俯瞰し、エージェントが安全に運用・拡張判断できるようにするための概要資料である。
- システム管理者・運用担当・実装エージェントを対象に、主要コンポーネント、データフロー、設定項目、保守導線を整理する。
- 旧来の「計画書」「設計案」と異なり、リポジトリ `main` ブランチ（2025-10-23 時点）のコードベースに基づく。

## 2. システム全体像
### 2.1 コンポーネント構成
- **フロントエンド**（`frontend/`）: React 18 + Vite + Chakra UI。患者フローと管理フローを SPA で提供。
- **バックエンド API**（`backend/app/main.py`）: FastAPI。テンプレート CRUD、セッション管理、LLM 連携、エクスポート、管理者認証を提供。
- **LLM ゲートウェイ**（`backend/app/llm_gateway.py`）: OpenAI 互換 API / ollama / LM Studio への疎通を抽象化し、追加質問・要約生成をハンドリング。
- **永続化層**（`backend/app/db.py`）: SQLite を既定としつつ、環境変数で CouchDB を有効化した場合はセッション回答を CouchDB に保存。監査ログや管理設定は SQLite。
- **ドキュメント生成**（`backend/app/pdf_renderer.py`）: ReportLab で問診結果の PDF を生成。CSV・Markdown 変換も `main.py` 内で扱う。
- **補助スクリプト**（`tools/`、`backend/tools/`）: テンプレート/セッションのエクスポート、管理者パスワードリセット、TOTP 秘密鍵暗号化など。

### 2.2 主要データフロー
1. 患者が `/` で受診種別を選択し、`/basic-info` で氏名・生年月日・性別（＋初診時は詳細個人情報）を入力。
2. `POST /sessions` によりセッションが作成され、テンプレート ID と回答ドラフトが返却。ブラウザ `sessionStorage` に保存。
3. `/questionnaire` でテンプレート項目を回答し、各回答は `POST /sessions/{id}/answers` 経由で保存。`sessionStorage` のドラフトも同期。
4. 追加質問フェーズ `/questions` では `POST /sessions/{id}/llm-questions` → `POST /sessions/{id}/llm-answers` をまとめて呼び出し、上限に達するか LLM が質問を返さなくなるまで繰り返す。
5. `POST /sessions/{id}/finalize` で要約を生成し、完了画面 `/done` に表示。エクスポートや管理画面から PDF/CSV/Markdown を取得可能。
6. 管理画面 `/admin/*` からテンプレート、セッション、LLM 設定、外観設定、セキュリティ（パスワード/TOTP）、データ入出力を操作。
7. `/metrics` で OpenMetrics テキスト、`/metrics/ui` でクライアントイベントを受け、`backend/app/logs/` 配下と SQLite `audit_logs` に監査情報を記録。

## 3. デプロイと実行環境
- **Docker Compose（推奨）**: `docker-compose.yml` で `backend`（FastAPI/Uvicorn）、`frontend`（Nginx 配信）、`couchdb` を起動。`FRONTEND_HTTP_PORT` でホストポート変更可。
- **ローカル開発**: Python 3.11+ と Node.js 18+ が前提。`make dev` / `./dev.sh` でバックエンドと Vite 開発サーバを同時起動。CouchDB を使う場合は別途起動し `.env` に接続設定を記載。
- **環境変数**: `backend/.env` とリポジトリ直下 `.env`（Docker 用）を読み込む。`MONSHINMATE_DB` を未設定の場合、`backend/app/app.sqlite3` を使用。
- **CORS 設定**: Cloud Run 等でフロントとバックエンドを別ドメイン運用する場合は `FRONTEND_ALLOWED_ORIGINS` に許可ドメインをカンマ区切りで指定する。未設定かつ `MONSHINMATE_ENV=local` では `http://localhost:5173` 系を自動許可する。
- **静的アセット**: 問診項目画像は `backend/app/questionnaire_item_images/`、ロゴは `backend/app/system_logo/` に保存し、FastAPI で静的配信。

### 3.5 Cloud Run / Firestore 拡張
- Cloud Run + Firestore 向けの永続化アダプタおよび Secret Manager 連携は、`private/` 配下に配置する非公開サブモジュールで提供する。
- プライベートモジュールが提供する `FirestoreAdapter` を利用する場合は、`MONSHINMATE_FIRESTORE_ADAPTER` 環境変数に `モジュール:クラス` 形式で指定する（例: `monshinmate_cloud.firestore_adapter:FirestoreAdapter`）。
- Secret Manager 連携を有効化する際は `MONSHINMATE_SECRET_MANAGER_ADAPTER` を設定し、プラグイン側の `load_secrets` をロードさせる。
- 本リポジトリのみで運用する場合は `PERSISTENCE_BACKEND=sqlite` を既定とし、Cloud Run 向け設定値は読み込まれない。
- Cloud Run 部署時に利用する `.env` サンプルはサブモジュール側の `.env.cloudrun.example` を参照する。

## 4. バックエンド（FastAPI）
### 4.1 主要モジュール
- `main.py`: エントリポイント。Pydantic モデル、API ルーティング、PDF/CSV生成、エクスポート暗号化、TOTP・JWT ロジック、メトリクスを包含。
- `db.py`: SQLite テーブル作成・マイグレーション代替（`init_db`）、テンプレート/セッション/ユーザー CRUD、CouchDB 接続ヘルパー、監査ログ記録。
- `session_fsm.py`: セッション状態遷移（残項目管理、LLM 追加質問キュー）。
- `validator.py`: 項目タイプ別バリデーション。個人情報フィールドは `personal_info` ユーティリティで整形。
- `structured_context.py`: 回答値の正規化（空回答→`該当なし` など）とセッション辞書更新。
- `llm_gateway.py`: LLM 設定の正規化、HTTP 呼び出し、状態キャッシュ、直列化ロック。
- `pdf_renderer.py`: A4 縦構成／structured/legacy レイアウト切替、質問ツリーのフラット化、ReportLab スタイル適用。

### 4.2 API グルーピング（抜粋）
- **ヘルスチェック**: `/health`, `/healthz`, `/readyz`。
- **テンプレート管理**: `GET/POST/DELETE /questionnaires`, `/questionnaires/{id}/duplicate|rename|reset`, `/questionnaires/{id}/summary-prompt`, `/questionnaires/{id}/followup-prompt`。
- **テンプレート入出力**: `/admin/questionnaires/export|import`。テンプレート・LLM設定・システム設定をまとめて転送でき、エクスポート時に PBKDF2+Fernet で暗号化可。
- **LLM**: `/llm/settings`（GET/PUT）、`/llm/settings/test`、`/llm/list-models`、`/llm/chat`。
- **システム設定**: `/system/timezone|display-name|entry-message|completion-message|theme-color|logo|pdf-layout|default-questionnaire|database-status|llm-status`。
- **管理者認証**: `/admin/login`（パスワード）→ `/admin/login/totp`（TOTP）、`/admin/auth/status`、`/admin/password`（初期設定）、`/admin/password/change`、`/admin/password/reset/*`、`/admin/totp/*`（setup/verify/disable/regenerate/mode）。
- **セッション**: `/sessions`、`/sessions/{id}/answers`、`/sessions/{id}/llm-questions`、`/sessions/{id}/llm-answers`、`/sessions/{id}/finalize`。
- **管理セッション**: `GET /admin/sessions`（フィルタ: 氏名・DOB・期間）、`/admin/sessions/{id}`、`/admin/sessions/stream`（SSE）、`/admin/sessions/bulk/download/{fmt}`、`/admin/sessions/{id}/download/{fmt}`、削除 API。
- **メトリクス**: `GET /metrics`（OpenMetrics テキスト）、`POST /metrics/ui`（UI 追跡イベント）。

### 4.3 セッションライフサイクル
- `POST /sessions` はテンプレ ID、回答ドラフト、最大追加質問数を返す。作成時に `METRIC_SESSIONS_CREATED` をインクリメント。
- `SessionFSM.step` が `Validator.validate_partial` → `StructuredContextManager.update_structured_context`（回答正規化）→ 残項目再計算。
- 追加質問は `SessionFSM.next_questions()` が LLM ゲートウェイを呼び、`llm_*` 形式の ID を採番して `pending_llm_questions` に積む。提示文は `llm_question_texts` と `question_texts` に保持し、履歴テーブルにも保存。
- 回答は `session_responses` テーブルに JSON で永続化。CouchDB が有効な場合は `answers` ドキュメントにも反映（`db.py` の `save_session`）。
- `POST /sessions/{id}/finalize` で `METRIC_SUMMARIES` を加算し、まとめた回答と要約を保存・返却。LLM 失敗時は `llm_error` を `sessionStorage` に退避して完了まで進める設計。

### 4.4 LLM 連携（通信仕様）
- **デフォルトプロンプト**: 追加質問用 `DEFAULT_SYSTEM_PROMPT` / `DEFAULT_FOLLOWUP_PROMPT`、サマリー用 `DEFAULT_SUMMARY_PROMPT` を `llm_gateway.py` / `main.py` に定義。管理画面の「LLM 設定」「テンプレート詳細」からテンプレート単位で上書きでき、プレースホルダ `{max_questions}` を埋め込む。
- **設定保持**: `LLMSettings` はプロバイダごとのプロファイルを `provider_profiles` に保持し、UI 保存時に `sync_from_active_profile`/`sync_to_active_profile` でトップレベル値と同期。`followup_timeout_seconds` は 5〜120 秒にクランプ。
- **追加質問生成**: `SessionFSM.next_questions()` → `LLMGateway.generate_followups()` を呼び出し、セッション ID 単位でロック。  
  - `provider="ollama"`: `POST {base_url}/api/chat` に `format` で JSON Schema（配列）を渡し、`message.content` または `response` の文字列を `json.loads`。  
  - `provider="lm_studio"`（OpenAI 互換）: `POST {base_url}/v1/chat/completions` に `response_format.json_schema` を指定し、`choices[0].message.content` の文字列 JSON をパース。  
  - パース失敗・HTTP エラー時は警告ログとともにスタブへフォールバックし、追加質問フェーズを即終了（空配列）。成功時は `llm_question_texts` に記録し `llm_1..n` の ID を採番。
- **単一項目用フォールバック質問**: `generate_question()` は未回答項目向けに個別問い合わせを行う実装で、同様に Ollama / LM Studio のチャット API を呼び分ける。失敗時・ローカルモードではスタブの汎用質問を返す（現行フローでは未使用だが残置）。
- **サマリー生成**: `summarize_with_prompt()` がリモート LLM に同様のチャットリクエストを送信。失敗時は `summarize()` の簡易結合文にフォールバック。バックエンドで `summary_prompts` に保存されたプロンプトを使用し、UI から有効化フラグを制御。
- **疎通状態管理**: すべてのリモート呼び出しで成功/失敗を `_record_status()` に報告。`/system/llm-status` が直近結果（`status`, `detail`, `source`, `checked_at`）を返し、フロントは `llmStatusUpdated` イベントで購読。
- **チャット API**: `/llm/chat` はサイドバー用軽量チャット。リモート有効時は上記と同じ経路で呼び出し、失敗時はスタブ応答。呼び出し数は `METRIC_LLM_CHATS` で計測。
- **スタブモード**: `enabled=False` または `base_url` 未設定時はローカルスタブが動作し、追加質問は生成せず、サマリーは簡易結合文を返す。UI フッターには「既定はローカルLLMで外部送信なし」と表示。

### 4.5 テンプレート・プロンプト管理
- テンプレートは `questionnaire_templates` テーブルに `items_json` と LLM 追質問設定（有効フラグ・上限件数）を保存。
- サマリー／追質問プロンプトは `summary_prompts`, `followup_prompts` にテンプレート ID × 受診種別で保存し、UI で有効化フラグを切り替え。
- `reset_questionnaire` / `reset_default_template` は `main.py` 内の `make_default_initial_items` 等を再投入し、設定を初期化。
- 問診項目画像は `/questionnaire-item-images` API 経由でアップロードし、テンプレートの `options[].imageUrl` 等から参照。

### 4.6 エクスポートとファイル処理
- **セッション**: `/admin/sessions/export|import` は JSON エンベロープ（`version`, `type`, `exported_at`, `payload`）でやり取りし、オプションパスワードで PBKDF2+Fernet 暗号化。CSV/Markdown/PDF ダウンロード API を併設。
- **テンプレート**: `/admin/questionnaires/export|import` でテンプレート・LLM設定・ブランド設定・関連画像をまとめてエクスポート。インポート時は mode=`merge|replace` を指定。
- **PDF**: `pdf_renderer.render_session_pdf` が構造化テーブル、Followup 条件表示、個人情報ブロックを描画。施設名やレイアウトモードは `/system/pdf-layout` で設定。

### 4.7 ロギング・監査・メトリクス
- Python 標準 `logging` で API ログ・LLM ログ・セキュリティログ（`security.log`）を出力。主要イベントは `audit_logs` テーブルにも記録（ユーザー変更・パスワード更新・TOTP 状態変更など）。
- メトリクスは整数カウンタの簡易実装（Prometheus 互換書式）。追加要求があれば `prometheus_client` への置換で拡張可能。
- `/metrics/ui` は匿名イベントを受信しログ記録（現状 DB 永続化はしていない）。

## 5. フロントエンド（React + Vite）
### 5.1 ルーティングと画面
- 患者フロー: `/`（Entry）→ `/basic-info` → `/questionnaire` → `/questions` → `/done`。ページ遷移時に `FlowProgress` で進捗を表示。
- 管理フロー: `/admin/login`（モーダル実装あり）→ `/admin/main`（ダッシュボード）→ 各種設定・データページ。
- 管理ページ一覧: `AdminMain`, `AdminTemplates`, `AdminTemplateEditor`（コンポーネント構成）、`AdminSessions`, `AdminSessionDetail`, `AdminDataTransfer`, `AdminLlm`, `AdminAppearance`, `AdminTimezone`, `AdminManual`, `AdminLicense`, `AdminLicenseDeps`, `AdminSecurity`, `AdminInitialPassword`, `AdminTotpSetup`, `AdminPasswordReset`, `LLMChat`, `LlmWait` 等。
- すべて `App.tsx` 内の `Routes` で定義し、ヘッダー右上の「管理画面」ボタンからモーダルログインを起動。

### 5.2 状態管理とユーティリティ
- **コンテキスト**: `AuthContext`（TOTP 状態と adminLoggedIn フラグ）、`NotificationContext`（Chakra Toast を患者/管理で出し分け）、`TimezoneContext`（`/system/timezone` と連動）、`LLMStatus` ユーティリティ（疎通情報の購読）。
- **保存戦略**: 患者回答はブラウザ `sessionStorage` に保存。`retryQueue.ts` でネットワーク断時の POST をキューし、`flushQueue()` がページ遷移時に再送。
- **フォーム補助**: `utils/personalInfo` で個人情報入力（かな等）をフォーマット。`QuestionnaireForm` はテンプレート JSON から Chakra コンポーネントを動的生成し、条件表示（`when`）、年齢/性別制限、複数選択、自由入力を扱う。
- **スタイル**: `theme/` で色・タイポグラフィを定義。`FontSizeControl` と `useAutoFontSize` でロゴ・システム名称の自動縮小を実装。

### 5.3 通信とエラー処理
- `fetch` ベースで API と通信。`NotificationContext` を通じてリトライ案内やエラー通知を表示。患者向け通知は画面下部（8 秒）、管理向けは右上（5 秒）。
- LLM 追加質問画面ではすべての回答をまとめて送信し、失敗時は `postWithRetry` でキューに退避した後 `finalize` を試みる設計。`sessionStorage` に `llm_error` を保存し、バックエンドへ送っておく。
- `metrics.ts` の `track` で UI イベントを `/metrics/ui` に送信（例: 入力検証エラー回数）。
- 管理ダッシュボードの LLM ステータス・DB ステータスは `/system/llm-status` / `/system/database-status` をポーリングし、Chakra `Tag` で状態表示。

## 6. データストア
### 6.1 SQLite スキーマ（`db.py`）
- `questionnaire_templates(id, visit_type, items_json, llm_followup_enabled, llm_followup_max_questions)`
- `summary_prompts(id, visit_type, prompt_text, enabled)`
- `followup_prompts(id, visit_type, prompt_text, enabled)`
- `sessions(id, patient_name, dob, gender, visit_type, questionnaire_id, answers_json, summary, remaining_items_json, completion_status, attempt_counts_json, additional_questions_used, max_additional_questions, followup_prompt, started_at, finalized_at)`
- `session_responses(session_id, item_id, answer_json, question_text, ts)`
- `llm_settings(id, json)` / `app_settings(id, json)`
- `users(id, username, hashed_password, totp_secret, is_totp_enabled, is_initial_password, totp_mode, password_updated_at, totp_changed_at)`
- `audit_logs(id, ts, event, username, note)` と `users` 更新用トリガ。

### 6.2 CouchDB（オプション）
- `COUCHDB_URL` 設定時は `get_couch_db()` で接続し、セッション回答をドキュメントとして保存。`COUCHDB_DB`（既定 `monshin_sessions`）に `session_id` をキーとして `answers`, `question_texts`, `llm_question_texts`, `summary`, `timestamps` を格納。
- `_users` DB を初期化し、認証情報（`COUCHDB_USER`, `COUCHDB_PASSWORD`）を設定。Docker Compose では `admin/admin`。

### 6.3 ファイルストレージ
- 問診項目画像: `backend/app/questionnaire_item_images/` 配下に保存し `/questionnaire-item-images/files/{filename}` で配信。
- システムロゴ/アイコン: `backend/app/system_logo/` に保存し `/system-logo/files/{filename}` で配信。UI はトリミング情報を保持。
- ログ: `backend/app/logs/` に API/LLM/セキュリティログ（ローテーション付き）を生成。

## 7. セキュリティと認証
- 管理者ユーザーは `admin` 固定。初回パスワードは `ADMIN_PASSWORD`（既定 `admin`）。`/admin/auth/status` で実際に既定パスワードと一致するかを検査し、`is_initial_password` を算出。
- TOTP（二段階認証）は `AdminSecurity` 画面で有効化。`/admin/totp/setup`（QR 生成）、`/admin/totp/verify`、`/admin/totp/disable`、`/admin/totp/regenerate` を利用。モード（`off` / `reset_only` / `login_and_reset`）は `/admin/totp/mode` で制御し、`users.totp_mode` に保存。
- 非常用リセット: `ADMIN_EMERGENCY_RESET_PASSWORD` を設定した場合、TOTP 無効時のみ `/admin/password/reset/emergency` で初期化可能。CLI からは `backend/tools/reset_admin_password.py` を使用。
- TOTP シークレットは `TOTP_ENC_KEY` 環境変数を設定すると Fernet で暗号化保存。`backend/tools/encrypt_totp_secrets.py` が移行ツール。
- 監査ログ `audit_logs` と `security.log` にパスワード変更・TOTP 状態変更・ログイン試行を記録。PII は平文で出力しない。
- 患者画面は匿名アクセス。セッション ID は `sessionStorage` に保持し、URL 共有を防ぐためリロード時にトップへリダイレクト。

## 8. 環境変数と設定
- 認証関連: `ADMIN_PASSWORD`, `ADMIN_EMERGENCY_RESET_PASSWORD`, `SECRET_KEY`, `TOTP_ENC_KEY`。
- データベース: `MONSHINMATE_DB`, `COUCHDB_URL`, `COUCHDB_DB`, `COUCHDB_USER`, `COUCHDB_PASSWORD`。
- LLM: `LLM_PROVIDER`（既定 `local`）、`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` など（UI から保存され `llm_settings` に反映）。
- PDF/外観: `/system/*` API で編集した内容は `app_settings` に JSON として保存され、再起動後も反映される。
- Docker Compose では `.env.example` を参考に `backend` サービスへ環境変数を渡す。セッション保存先 SQLite はホスト `./data/sqlite/app.sqlite3` にマウント。

## 9. 運用・監視
- ヘルスチェック: `curl http://localhost:8001/healthz` → `{"status":"ok"}`。`/readyz` は DB 接続確認を含む。
- LLM ステータス: `/system/llm-status` を参照。UI から手動疎通テスト（`/llm/settings/test`）を実行可。
- DB ステータス: `/system/database-status` が `sqlite` / `couchdb` / `error` を返す。管理ダッシュボードでバッジ表示。
- バックアップ: SQLite はファイルコピー、CouchDB は `_all_dbs` ダンプ（`docker/tools/` に想定スクリプト）。エクスポート API は暗号化 ZIP での退避用途に使う。
- ログ点検: `backend/app/logs/api.log`, `llm.log`, `security.log`。必要に応じて logrotate や外部集中管理へ転送。

## 10. 制約・留意事項
- LLM 問い合わせは同期呼び出しで、タイムアウト時は患者フローがベース問診のみで進行。追加質問が 0 件の場合でも finalize を呼び出す。
- `/metrics` はプロセス内カウンタであり、マルチプロセスで共有されない。Gunicorn ワーカー増設時は Prometheus ライブラリへの置換が必要。
- CouchDB 無効時はセッション回答が SQLite の JSON カラムに保存されるため、サイズ増に注意。大量データ運用時は CouchDB か PostgreSQL への移行を推奨。
- `AuthContext.login` は現時点でダミーのまま。実際のログインは `AdminLogin` ページが直に API を呼び、`sessionStorage` のフラグで状態管理している点に留意。
- `frontend` 側のルータはブラウザリロード時に `/` へ強制移動する実装のため、管理ページへ直接ブックマークするとログイン前提の導線になる。

## 11. 関連資料
- `README.md`: 公開向けセットアップ・機能概要。
- `internal_docs/implementation.md`: 実装履歴とチェックリスト（計画時点のメモ含む）。
- `internal_docs/admin_system_setup.md`: 管理者向け運用手順（TOTP/非常用リセットの詳細）。
- `docs/session_api.md`: 公開 API 仕様書。
- `frontend/public/docs/*.md`: 管理画面向けマニュアル（ビルド成果物は `frontend/dist/docs/`）。
- `tools/export_public.sh`: 公開資料エクスポート。

---
本書に記載の挙動は `main` ブランチの最新コードと一致するよう随時更新すること。差異を発見した場合は、本ファイルと `internal_docs/implementation.md` 双方に記録する。
