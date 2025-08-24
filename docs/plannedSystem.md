---

## 実装計画書

### 1. 方針・前提
- 本実装は、本書の問診ロジック仕様を最小構成で実装する計画である。
- **本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。**（UI上にも明記する）
- スコープに含む：患者名・生年月日の取得、初診/再診の分岐、テンプレートに基づくベース問診、LLMによる不足項目の**必要最小限**の追加質問、最終確認・確定、保存、簡易要約。
- スコープ外：禁忌・赤旗、辞書/正規化、緊急分岐、重複照合/新規ID発行、同意画面、ルールベース追質問（ハードガード）。

#### 1.1 非機能要件 / 設計方針（最小）
- **性能**：フォーム画面の操作反応 < 300ms、API基本処理 < 500ms、LLM 追加質問は 30s タイムアウト（再試行 1 回）。
- **可用性**：単一ノード（オンプレ）を前提。診療時間中の停止は 5 分以内の手動復旧を許容。LLM 障害時はベース問診のみで完了できるフェイルセーフを既定（§7, §9 と整合）。
- **保守性**：12-Factor 構成（設定は .env）。インフラ依存を Docker に集約。データ層は移行容易性を優先（SQLite→PostgreSQL への移行パスを用意）。
- **セキュリティ**：院内 LAN 限定公開（ゼロトラスト境界は Tailscale 等で管理者のみ）。認証は管理 UI のみ必須（患者 UI は発番トークン／セッションID）。
- **監査/保持**：アクセス/操作ログは 180 日以上を目安に保存。問診データの保存期間は院内規程（原則 5 年以上）に準拠。
- **個人情報**：PII 最小化。保存時に一部フィールド（氏名・生年月日）をアプリケーション層で暗号化可能な設計（KMS 代替として OS 保護のキー保管）。

#### 1.2 システム全体像（アーキテクチャ）
- **クライアント**：SPA（React/Vite/TypeScript）。患者フロー/管理フローを分離したルーティング。
- **API**：FastAPI（Python）。同期 REST（§3 の API）＋バックグラウンドジョブ（要約等）。
- **LLM ゲートウェイ**：LiteLLM もしくは OpenAI 互換 API（LM Studio / Ollama）。`LLMGateway` は HTTP 経由で呼び出し、モデル切替は設定で可能。
- **データベース**：PoC は SQLite、本番は PostgreSQL（バイナリバックアップとスナップショット運用が容易）。
- **リバースプロキシ**：Caddy または Nginx（**静的配信＋API リバースプロキシを兼務／プロキシA案**、LAN 内運用、管理UIは OIDC 優先／Basic はフォールバック）。
- **監視/ログ**：アプリ構造化ログ（JSON）→ファイル。必要に応じ Uptime-Kuma（死活）を併用。
- **バックアップ**：DB ダンプ（毎夜）＋スナップショット（QNAP/NAS）。復元手順を §8.1 に定義。

データフロー（概念）：
`Browser（患者/管理） → Reverse Proxy → FastAPI → (DB, LLMGateway)`

#### 1.3 環境 / インフラ構成（推奨）
- **実行基盤**：院内の QNAP Container Station もしくは小型 Linux サーバに Docker Compose 構成。
- **ネットワーク**：院内 LAN のみ公開。管理アクセスは Tailscale で限定。
- **Compose サービス例**：
  - `reverse-proxy`：ビルド済み SPA の静的配信＋API へのリバースプロキシ（Caddy/Nginx）。
  - `api`：FastAPI（Uvicorn/Gunicorn）。
  - `db`：PostgreSQL 15（`volumes:/var/lib/postgresql/data`）。
  - `llm`：LiteLLM（背後で LM Studio/Ollama を利用）。
  - `backup`：`pg_dump` 実行用の軽量ジョブコンテナ（cron）。
- **ボリューム**：`db-data`（DB）、`logs`（アプリログ）、`backups`（暗号化ダンプ）。
- **設定**：`.env` に API 秘密鍵、DB 接続、LLM エンドポイント、管理 UI 認証情報に加え、**MASTER_ADMIN_USERNAME / MASTER_ADMIN_PASSWORD**（環境変数でハードコードされるマスターアカウント）および OIDC 設定（`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAIN`）を定義。マスターアカウントでログインした場合のみ、その他の管理アカウントの作成・編集・削除を許可する。

#### 1.4 既定運用パラメータ
- **追加質問上限**：テンプレートごとに設定可能（初診/再診別）。セッション合計は設定値を上限とし、項目ごとの再質問は既定 3 回。
- **追加質問プロンプト**：デフォルトはシステム固定だが、管理画面のアドバンストモードで編集可能（JSON配列で返答、`{max_questions}` プレースホルダ対応）。
- **LLM**：timeout=30s、max_tokens=128（いずれも設定で変更可）。
- **セッション**：アイドル失効 30 分、全体 TTL 24 時間。失効後は自動廃棄（PII 含む一時データを削除）。
- **バックアップ**：RPO=24 時間、RTO=30 分。保持は日次 14 世代、週次 8 世代、月次 6 ヶ月（≈180 日）。
- **監視**：/healthz（死活）・/readyz（依存疎通）・/metrics（OpenMetrics）。

### 2. マイルストーン（MS）
- **MS1 テンプレ整備**：問診テンプレート CRUD と `get_template_for_visit_type` の動作確認（項目型は text/multi/yesno/date）。
  - 補足：システム既定テンプレートのラベルは「質問文形式」（例：主訴は何ですか？、発症時期はいつからですか？）で初期化する。
- **MS2 セッション基盤**：`SessionFSM` 初期化（`remaining_items`/`completion_status`/`attempt_counts`）、`StructuredContextManager` による永続更新。
- **MS3 追加質問ループ**：`step("answer")` で回答受領→`LLMGateway.generate_followups` により回答全体を基に追加質問を生成→`Validator.is_complete` 判定→不足時に追質問（項目ごと最大3回・セッションあたりの上限N）。
- **MS4 要約と保存**：必要情報が揃ったら `_finalize_item` を実行し、`collected_data` と `SessionResponse` に反映。全項目完了時にセッション終了。
- **MS5 フロントエンド**：患者フロー（基本情報＋受診種別→ベース問診→一次送信→追加質問→最終確認→完了）、管理UI（テンプレ編集）。
- **MS6 ログ/観測性（最小）**：セッション進行ログ、LLM I/O メタ（トークン/所要時間）保存。PII は最小化し、必要に応じマスキング。
- **MS7 UAT/受け入れ**：想定シナリオでエンドツーエンド検証、受け入れ基準を満たせばリリース。

### 3. 機能分解 / WBS（主な作業）
**バックエンド**
1) **モデル/スキーマ**：`questionnaire`、`session`、`session_response`、`llm_settings`、構造化コンテキスト（`collected_data`/進捗）。
2) **サービス**：
   - `SessionFSM`：状態遷移、`step("answer")`、`_finalize_item`、上限管理（attempt/turn/questions）。
   - `LLMGateway`：`generate_question`、`decide_or_ask`、`summarize`。タイムアウト・再試行・上限トークン制御。
   - `Validator`：必須・型・範囲の最小バリデーション。`is_complete` のみ（相関や禁忌判定は実装しない）。
   - `StructuredContextManager`：`update_structured_context` による逐次保存、進捗率更新。
3) **API（例）**：
   - `POST /sessions`：患者名・生年月日・受診種別・`questionnaire_id` を受け新規セッション生成。
   - `POST /sessions/{id}/answer`：`{item_id, answer}` を受け、次の質問（ベース or 追加）を返す。必要に応じて `questions[]` の配列で複数返却可。
   - `POST /sessions/{id}/finalize`：最終確認後の確定。要約（テキスト/Markdown）と `collected_data` を返す。
   - `GET /questionnaires/{id}/template?visit_type=initial|followup`：対象テンプレートの取得。
   - `GET /llm/settings`：現在のLLM設定を取得。
   - `PUT /llm/settings`：LLM設定を更新。
   - `POST /llm/settings/test`：LLM接続テストを実施。
4) **上限/制御**：
   - 項目ごとの追質問：最大3回（`attempt_counts`）。
   - セッションの追加質問合計：最大N件（**初期値5**、テンプレート設定で管理）。
   - LLM 応答タイムアウト時は追加質問ステップをスキップし、ベース問診のみで進行可能。

**フロントエンド**
1) **患者フロー**：
   - 画面A：基本情報（患者名・生年月日＋受診種別）
   - 画面C：ベース問診フォーム（テンプレートに沿った入力）
   - 画面D：一次送信→LLM追加質問の提示と回答（1問ずつ or 複数）
   - 画面E：最終確認（全回答の一覧/その場修正）→確定
   - 画面F：完了（受付向け番号や案内は任意）
2) **管理フロー**：問診テンプレ CRUD、テンプレプレビュー（初診/再診）。
3) **UI 表示文**：フッター等に「本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。」を常時表示。

#### 3.5 実装スタック選定（推奨）
- **フロント**：React + Vite + TypeScript、UI コンポーネント（Chakra/Mantine いずれか）。フォームは React Hook Form + Zod で型/バリデーション統一。
- **バックエンド**：FastAPI + SQLAlchemy/SQLModel + Pydantic v2。非同期 I/O。プロセスマネージャは Gunicorn（Uvicorn workers）。
- **DB**：PostgreSQL（開発は SQLite 互換層で代替可）。スキーマ管理は Alembic。
- **LLM**：LiteLLM（OpenAI 互換）経由で LM Studio / Ollama を切替。**初期値**：timeout=30s、max_tokens=128、`temperature` は 0.2（設定化）。
- **テスト**：pytest、Playwright（E2E）、schemathesis（OpenAPI プロパティベーステスト）。
- **CI/CD**：GitHub Actions でビルド/テスト → Docker イメージ発行（`stg`/`prod` タグ）。本番反映は手動 `docker compose pull && up -d`。

#### 3.6 スキーマ / API I/F 仕様（最小・補足）
- **Questionnaire**（例）
  ```json
  {
    "id": "uuid",
    "visit_type": "initial|followup",
    "items": [
      { "id": "chief_complaint", "label": "主訴", "type": "string", "required": true },
      { "id": "pain_present", "label": "痛みはありますか？", "type": "yesno", "required": false },
      { "id": "allergies", "label": "アレルギー", "type": "multi", "options": ["食物", "薬剤", "花粉"], "allow_freetext": true, "required": false }
    ]
  }
  ```
  - `allow_freetext`: `type` が `multi` のときに任意文字列の追加入力を許可するフラグ（省略時は `false`）。
- **POST /sessions**：
  ```json
  {
    "patient_name": "string",
    "dob": "YYYY-MM-DD",
    "visit_type": "initial|followup",
    "questionnaire_id": "uuid"
  }
  ```
- **POST /sessions/{id}/answer**（複数質問返却に対応）
  ```json
  { "item_id": "chief_complaint", "answer": "右頬のしこり" }
  →
  { "questions": [ {"id":"onset","text":"いつ頃からですか？","expected_input_type":"date|string","priority":1} ] }
  ```
- **POST /sessions/{id}/finalize**：`collected_data` と要約（Markdown）を返却。

##### テンプレートのバージョニング（追加）
- `questionnaire.version` を整数で管理し、セッション作成時に `questionnaire_version` をセッションへ固定保存する（後方互換確保）。
- 例（追補）
  ```json
  { "id": "uuid", "version": 1 }
  ```

### 4. プロンプト仕様（最小）
- **System**：
  - 目的：既存回答の不足・確認ポイントのみを抽出し、必要最小限の追加質問を生成する。
  - 禁止：診断断定・治療指示・冗長説明。
  - 出力形式：`questions: [{id, text, expected_input_type, options?, priority}]`（最大N件）。
- **User**：受診種別、`{項目名: 回答}` のリスト、直近ターンの追加回答（あれば）。
- **停止条件**：LLM が質問を返さない／上限到達／ユーザー手動終了。

### 5. データ保存・状態管理（最小）
- `session`：`id`、`questionnaire_id`、受診種別、進捗、作成/更新時刻、完了フラグ。
- `collected_data`：ベース問診 `{項目ID: 値}` と追加質問の `[{id, text, answer, ts}]`。
- `SessionResponse`：表示文・回答の履歴（時系列）。

#### 5.1 セッション有効期限・破棄
- アイドル 30 分で失効、作成から 24 時間で TTL 到達時に自動廃棄。
- 廃棄時は `collected_data` を含む一時データを完全削除（監査ログは保持）。
- セッションは `questionnaire_version` を保持し、後日の参照でも当時の版で再現可能。

### 6. バリデーションとエラーハンドリング（最小）
- 必須・型・範囲のみ。バリデーション NG は当該項目に即時エラー表示。
- LLM 応答がない/遅い場合：追加質問ステップをスキップし、完了まで進行可能。
- 保存失敗：自動再試行（数回）と再送ボタン。

#### 6.1 セキュリティ / コンプライアンス（最小）
- **通信/認証**：院内 LAN。管理 UI は **OIDC を優先**、Basic 認証はフォールバック（緊急時のみ有効化可能）。管理アクセスは Tailscale ACL で限定。
- **保存**：氏名/生年月日等はアプリ層暗号化（AES-GCM）。鍵はサーバ上の OS 保護ストアに保管。バックアップは暗号化（`gpg` 等）。
- **権限**：`master_admin` / `admin` / `staff` の RBAC。`master_admin` は `.env` 由来のマスターアカウントのみ。`master_admin` のみが管理アカウントの作成・編集・削除を実行可。患者 UI は匿名セッション（トークン）で紐付け。
- **ログ**：PII を含まない構造化ログ。必要時のみ相関 ID を出力。**保持期間は 180 日**。
- **Cookie/CSRF/CORS**：患者 UI セッションは HttpOnly + SameSite=strict。CSRF 対策（二重送信トークン）。CORS は許可オリジンを院内ドメインに限定。
- **監視エンドポイント**：/healthz（プロセス・DB 簡易チェック）、/readyz（API・DB・LLM ゲートウェイの疎通）、/metrics（OpenMetrics）。
- **レート制限**：API と LLM 呼出にレート制限／同時実行上限を設定（診療時間帯の突発負荷を吸収）。

### 7. テスト計画
- **ユニット**：`LLMGateway`（モック）、`Validator.is_complete`、`SessionFSM` の状態遷移。
- **結合**：初診・再診の代表テンプレで E2E（入力→追加質問→確定）。
- **UI**：モバイル中心の操作性、未入力や型エラーのガイド。
- **フェイルセーフ**：LLM 無効時でもベース問診のみで完了できること。

#### 7.1 性能・負荷テスト（最小）
- k6 でシナリオ作成：フォーム送信、追質問 3 回、確定まで。目標：P95 < 2s（LLM 呼び出しは除外）、タイムアウト/再試行の挙動確認。
- /healthz・/readyz の応答確認、/metrics に API P95・LLM タイムアウト率・追加質問平均回数が出力されていること。

#### 7.2 バックアップ/リストア演習
- 月次で DB ダンプからの復元演習（ステージング）。アプリ起動・データ整合性を確認し、手順を更新。
- 合格基準：RPO=24 時間以内、RTO=30 分以内を満たすこと（監査チェックリストに記録）。

### 8. リリース手順
1) データベースマイグレーション（テンプレ・セッション関連）。
2) 管理画面で初診/再診のテンプレを投入。
3) ステージングで UAT パス後、本番へロールアウト。

#### 8.1 ロールバック手順（最小）
1) 直近バックアップの確認（タイムスタンプとサイズ）。
2) 本番を `docker compose down`（DB は停止のみ）。
3) DB をバックアップ時点に復元（PostgreSQL：`psql` でリストア／SQLite：ファイル差し替え）。
4) 直前の安定版イメージへ `docker compose pull && up -d`。
5) 死活確認と主要導線の動作確認（患者フロー、管理テンプレ CRUD、要約）。

### 9. 受け入れ基準（抜粋）
- ベース問診のみでもセッションを完了できる。
- 追加質問は上限 N 件を超えない。項目ごとの再質問は最大 3 回。
- 最終確認画面で全入力が一望でき、その場で修正して確定できる。
- スタッフ向け要約が生成され、印刷/EMR への貼付に足る簡潔さである。
- UI 上に「ローカルLLM利用・外部送信なし」の明記が恒常表示されている。
