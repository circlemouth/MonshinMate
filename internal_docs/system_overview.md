# システム概要（MonshinMate）

本書はセキュリティ改修後のローカル実装を整理したものです。公開API、患者フロー、管理者認証、永続化の境界を優先して記述します。実DB・実秘密情報の読み書き、本番デプロイ、Cloud Run / Firestore / GCS の実接続確認は今回行っていません。クラウド構成・モデル選定の過去記録は末尾の履歴節に分離し、現在の稼働状態や検証済み保証として扱いません。

## 1. 全体アーキテクチャ

- **バックエンド**: FastAPI / Pydantic。[main.py](<../backend/app/main.py>) がAPIを登録し、[api_policy.py](<../backend/app/api_policy.py>) が既定で管理者認証を要求するルート境界とリクエストサイズ制限を提供する。管理者認証処理は専用ルーターでも用途別に検証する。
- **フロントエンド**: React 18 + TypeScript + Chakra UI。患者用フローと管理画面を分離し、患者情報・管理者資格情報を外部URLへ送らない通信ヘルパーを使う。UIの表示制御だけを認可境界としない。
- **永続化**: [DB切替ハブ](<../backend/app/db/__init__.py>) と [PersistenceAdapter](<../backend/app/db/interfaces.py>)。SQLiteが既定。CouchDB設定時はセッション保存とセキュリティ状態をCouchDBへ委譲し、障害時にSQLiteへ黙って退避しない。設定・アセット等のSQLite保存もあるため、CouchDB利用時にSQLite全体が不要になるわけではない。
- **セキュリティ状態**: [security_state.py](<../backend/app/security_state.py>) に集約する永続CAS（compare-and-swap）。管理者の認証状態、患者capability、操作lease、レート制限をプロセスメモリだけに置かない。保存失敗・競合解消不能は503で閉じる。
- **LLM**: [llm_gateway.py](<../backend/app/llm_gateway.py>) が設定されたプロバイダへ接続。[clinical_context.py](<../backend/app/clinical_context.py>) と [llm_data_security.py](<../backend/app/llm_data_security.py>) が送信項目と宛先を制限する。「既定でローカルLLMなので外部送信なし」とは説明しない。
- **出力**: 管理者向けのPDF / CSV / Markdown / JSON等。患者の完了応答に要約や回答を返さない。出力ファイルは患者情報を含み得るため、認証と保管管理が必要。

## 2. 起動・ビルド構成

- 汎用バックエンドイメージは [Dockerfile](<../backend/Dockerfile>) のPython 3.12を使用し、[requirements.lock](<../backend/requirements.lock>) から依存を導入する。Python依存は仮想環境内へ入れる。
- フロントエンドはVite 7を使用。対応Node.jsは20.19以上の20系、または22.12以上。正確な採用版は [package.json](<../frontend/package.json>) とロックファイルを参照し、古いNode 18を前提にしない。
- [docker-compose.yml](<../docker-compose.yml>) はローカル用で、CouchDB 5984、backend 8001、frontend 5173（`FRONTEND_HTTP_PORT`で変更可能）をループバックへバインドする。共有ネットワーク向けの公開・TLS・アクセス制御は別途設計が必要。
- Composeには管理者やCouchDBの既定パスワードを置かない。`COUCHDB_USER` / `COUCHDB_PASSWORD` / `SECRET_KEY` / `TOTP_ENC_KEY` は事前注入必須。backendは`MONSHINMATE_ENV=production`で鍵検証を行い、SQLiteをホストのデータ領域へ永続化する。
- [.dockerignore](<../.dockerignore>) は環境ファイル、鍵、実DB、ログ、データ類、private領域等を除外する。汎用イメージには非公開クラウドアダプタやGCP専用依存を同梱しない。クラウド向け設定・デプロイ手順は非公開サブモジュール側で管理する。
- 実環境の起動・移行と、合成データによる隔離テストは分ける。既存DBや秘密情報を読み込む通常起動を、無許可の確認手順として実行しない。

## 3. APIの公開境界

[api_policy.py](<../backend/app/api_policy.py>) の完全一致allowlistを基準とし、`/system/*`や`/admin/*`全体を匿名許可するprefix例外は設けない。Swagger / ReDoc / OpenAPI公開ルートも無効。

| 区分 | 主なAPI | 認証・公開内容 |
| --- | --- | --- |
| 最小ヘルス情報 | `GET /health`, `/healthz`, `/readyz` | 匿名可。内部構成や秘密情報を公開しない |
| 患者用表示設定 | `GET /system/bootstrap`、表示名・案内文・テーマ・ロゴ・タイムゾーン・既定テンプレート等の明示されたGET | 患者表示に必要な設定だけ |
| 問診の公開素材 | `GET /questionnaires`, `/questionnaires/{id}/template`、検証済み画像取得、郵便番号検索 | 問診表示に必要な素材のみ |
| LLM公開稼働可否 | `GET /system/llm-availability` | `status`のみ。詳細状態は管理者限定 |
| セッション開始 | `POST /sessions` | 匿名開始可、IP別・全体の永続レート制限。capabilityを一度発行 |
| 患者操作 | `POST /sessions/{id}/answers`, `/llm-answers`, `/llm-answers/batch`, `/llm-questions`, `/finalize` | 当該セッション専用のBearer capabilityが必要 |
| 管理者認証 | `/admin/login`, `/admin/login/totp`, `/admin/bootstrap`, `/admin/recovery`等 | パスワード・challenge・offline credential等を用途別に検証。安全な状態フラグのみ匿名取得可 |
| 外部連携 | `POST /patient-summary`, `/patient-summaries`, `/patient-summary/pdf` | 連携用APIキーを専用ハンドラーで検証。患者capabilityとは別 |
| 管理操作 | セッション一覧・詳細・削除・出力、テンプレート更新、LLM設定・chat、システム設定更新、DB/LLM詳細状態、`/metrics`等 | 有効な管理者access JWTが必要。認証設定変更は再認証も要求 |

通常bodyは256KiB、画像アップロードは512KiBにmultipart用の限定余裕、インポートは5MiBに限定余裕を設け、`Content-Length`だけでなく受信チャンクも上限検査する。応答には`no-store`、`nosniff`、`no-referrer`、`X-Frame-Options: DENY`を付ける。CORSは認証の代用ではなく、必要なoriginを明示設定する。

## 4. 患者セッションのライフサイクル

### 4.1 開始・回答・永続状態

1. 患者は受診種別・基本情報・テンプレート項目を入力する。`POST /sessions`は`id`, `session_token`, `expires_at`を返す。セッションIDだけでは患者操作を認可しない。
2. capabilityは暗号学的乱数から生成し、有効期限は24時間。サーバーにはSHA-256ハッシュを保存し、生tokenをDBやログへ保存しない。作成応答以外で再発行しない。
3. 回答更新・追加質問・確定はBearer capabilityを検証し、永続CASによるセッション単位の操作leaseを取得する。他の操作が実行中なら409を返す。レート制限は永続カウンタで行う。
4. lease取得後は毎回DBからセッションを復元する。インスタンス内の`sessions`キャッシュは正本にしない。回答、進行状況、質問文マップ、`pending_llm_questions`キューを保存し、別プロセスでも発行済み質問と未回答状態を引き継げる。
5. [session_fsm.py](<../backend/app/session_fsm.py>) の`SessionFSM`はテンプレート回答・追加質問の進行を扱う。LLMへ渡す回答はサーバー側テンプレートと発行済み質問を基準に制限する。LLM呼出し入口で永続レート制限を適用する。

**異常終了時のleaseを時間経過だけで横取りしない。** 遅延した旧workerが後から上書きする危険を避けるため、取り残されたleaseは閉じたままとする。運用者が保存状態と旧処理の停止を確認して整合性を回復する必要があり、自動復旧・自動引継ぎを保証しない。

### 4.2 確定と患者情報の消去

- `/finalize`は回答・必要な要約を管理者用記録として保存した後、`{id, status: "finalized", finalized_at}`だけを返す。回答、患者氏名、生年月日、要約を患者向け完了レスポンスへ含めない。
- 有効な同一capabilityでの確定再試行は同じreceiptだけを返し、LLM要約を再生成しない。確定後の回答変更・追加質問等は409で拒否する。失効・不正なcapabilityは401。
- フロントエンドはreceiptのIDと状態を検証してから患者情報・token・回答・質問・再送キューをまとめて消去する。未送信回答が残る場合や確定応答を取得できない場合に、成功したように完了画面へ進めない。
- [Done.tsx](<../frontend/src/pages/Done.tsx>) は完了メッセージだけを表示し、戻る操作で患者要約を再表示しない。次患者開始、手動終了、無操作タイムアウトでも患者状態を消去する。

### 4.3 ブラウザ内の状態と再送

- [patientSession.ts](<../frontend/src/utils/patientSession.ts>) は当該タブの`sessionStorage`でセッションと入力を管理する。無操作15分で警告、16分で消去。これはサーバーcapabilityの24時間TTLとは別の端末保護策。
- 消去時は進行中のfetchを中断し、世代番号を更新する。古い非同期応答が次患者の状態や消去済みデータを復活させない。
- 患者fetchは現在のセッションの同一origin URLに限定し、Bearer付与、`no-store`、redirect拒否を行う。
- [retryQueue.ts](<../frontend/src/retryQueue.ts>) は回答保存と追加回答一括保存だけを対象とする。セッションに紐付け、TTL 30分・最大50件・指数backoff・回数上限で再送する。確定や任意URLをキューに入れず、認可エラー等の恒久失敗は無制限再試行しない。

## 5. 管理者認証と永続CAS

### 5.1 アカウント・鍵・JWT

- [admin_security.py](<../backend/app/admin_security.py>) と [admin_security_routes.py](<../backend/app/admin_security_routes.py>) が認証を実装する。`admin:account:v1`が認証状態の正本であり、旧`users`テーブルや`ADMIN_PASSWORD`の既定値を自動的に信用しない。
- 新しく設定するパスワードは12文字以上・UTF-8で72byte以下、bcryptで保存。承認済み旧ハッシュ継承はこの新規長さ要件を遡及適用しない。TOTP secretはFernet暗号化し、復号不能時にMFAを自動解除しない。
- `K_SERVICE`が設定された環境、または`MONSHINMATE_ENV`がlocal / test / development / dev以外なら本番として扱う。DB初期化前に独立した強い`SECRET_KEY`と`TOTP_ENC_KEY`を検証する。ローカル未指定鍵はプロセスごとの乱数であり、再起動をまたぐ運用には固定の安全な鍵が必要。
- access JWTはHS256、15分、`aud=monshinmate-admin`, `iss=monshinmate`, `scope="admin push:manage"`。`exp/iat/nbf/sub/aud/iss/jti/ver/purpose`と用途・寿命を検証し、永続アカウントのversion変更で既存accessを失効させる。Pushだけ8時間有効な別JWTという構成ではない。
- ログインchallengeは5分、enrollmentは10分、再認証は5分。challengeやenrollment tokenをaccess tokenとして使えない。`amr`はパスワードのみ、またはパスワード+OTPの実際の認証を表す。

### 5.2 MFA・初回登録・復旧

- `/admin/login`はパスワードを検証し、必要に応じて`totp_required`とchallenge、または`enrollment_required`とenrollment tokenを返す。`/admin/login/totp`でchallengeを消費する。今回の指定は `MONSHINMATE_ADMIN_REQUIRE_MFA=0` によるパスワードのみ運用。MFA未登録・必須登録途中でないアカウントは直接accessを返す。未指定の本番／明示1はMFA必須、不正値は拒否。既存MFA・必須登録途中・ロック・由来不明pendingを設定だけで迂回しない。
- TOTPの受理済みtime stepを永続保存する。前後1stepの許容範囲でも、登録・ログイン・再認証間で同じコードを再利用できない。
- パスワード変更、TOTP設定変更・再登録等ではBearer accessに加えて`X-Admin-Reauth`を要求する。再認証tokenは当該accessの`jti`へ結び付ける。
- 初回登録・復旧は [provision_admin.py](<../backend/tools/provision_admin.py>) のoffline `bootstrap` / `recovery`で開始する。operatorが保存先を明示し、0600の新規ファイルへ短命・一回限りのcredentialを発行する。既定15分（許容60〜3600秒）、サーバーにはhashだけ保存し、発行時点で旧管理アクセスをロック・失効させる。
- HTTPの`/admin/bootstrap`または`/admin/recovery`でcredentialと新パスワードを提出。明示MFA任意なら直接access、それ以外はTOTP登録・確認へ進む。
- 現パスワードの継続は承認済みオフライン `migrate-legacy` で対応。MFA無効・非初期の旧admin bcryptハッシュを、未作成の共有認証状態へ一度だけ継承する。既存状態を上書きせず、旧ユーザーのHTTP／起動時自動信頼もしない。旧管理者更新を止めた保守時間帯とバックアップが必要。
- 旧パスワードreset API、非常用固定パスワード、GETによるTOTP secret発行、任意TOTP mode変更は廃止（410）。[reset_admin_password.py](<../backend/tools/reset_admin_password.py>) は旧方式を実行しない。

具体的な管理手順は [管理者セットアップ](<admin_system_setup.md>)、UI操作は [管理者マニュアル](<../docs/admin_user_manual.md>) を参照。

### 5.3 セキュリティ状態の保存先

- SQLite: `security_state(key, revision, value)`に保存し、`BEGIN IMMEDIATE`でCAS更新を直列化する。通常の患者出力・設定exportには混ぜない。
- CouchDB: `COUCHDB_SECURITY_DB`（既定は`COUCHDB_DB + "_security"`）というセッションDBと別のDBを使用し、`_rev`でCASを実装する。同一DB指定は拒否し、接続失敗時にSQLiteやメモリへfallbackしない。
- Firestore: アダプタ生成前に`security_get_state`と`security_compare_and_swap_state`の実装を要求する。ローカルの非公開実装へトランザクションCAS・患者状態保護・メタデータ保存・インポート501を追加し、fakeで隔離検証済み。実SDK通信・実クラウドの並行トランザクションは未検証。[非公開アダプタの運用文書](../private/cloud-run-adapter/README.md) に従い、実revisionの確定と本番前ゲートを別途満たす。
- CAS transformは再試行され得るため副作用を含めない。認証・失効・レート制限は複数worker間で共有される永続状態を参照する。

## 6. LLM連携とデータ最小化

- プロバイダはOllama、LM Studio / OpenAI互換等。利用有効化・モデル・URL・認証設定は管理者が管理する。設定変更だけで保存済みの患者履歴を自動再送しない。
- [LLM設定の秘匿処理](<../backend/app/llm_settings_security.py>) は更新と読み取りを分離し、allowlistで読み取り応答・exportを構成する。API key、認証token、秘密鍵、`service_account_json`は返さず、必要なら設定済みフラグだけを返す。拡張fieldも非機密として許可されたものだけ。
- 追加質問と要約には、テンプレートおよびサーバーが発行した質問に一致する臨床回答だけを渡す。個人情報項目、氏名、生年月日、連絡先、住所、患者ID、token等を除外する。**自由記述に混在する識別情報の完全匿名化は保証しない。** 入力内容・患者説明・送信先事業者との取り決めも必要。
- HTTPS origin allowlist、URL構文、認証情報・query・fragmentの拒否、DNS結果の公開IP検査で宛先を制限する。metadata、private / loopback等への誘導を拒否し、redirectで制限を迂回しない。
- ローカルLLMのloopback例外は`MONSHINMATE_ENV=local`かつ`MONSHINMATE_ALLOW_LOCAL_LLM=1`の場合だけ。`MONSHINMATE_LLM_ALLOWED_ORIGINS`は環境側で管理し、管理画面のURL変更だけで宛先制限を緩和できない。
- 追加質問は`SessionFSM`と`LLMGateway.generate_followups()`で生成し、件数・利用量を制限する。HTTP失敗・不正な構造化応答等は安全なfallbackに収束させ、生の例外本文・credential・患者入力をログや患者応答へ反映しない。
- 要約はテンプレート別プロンプトを使い、失敗時は簡易要約へfallbackする。LLM無効時やstub応答であることと、「設定にかかわらず外部送信しない」ことを混同しない。
- 管理者用`/system/llm-status`は詳細、患者用`/system/llm-availability`は`status`だけ。`/llm/chat`も管理者限定であり、匿名LLM中継APIにしない。
- Vertex AI等のクラウド固有実装・資格情報運用は非公開アダプタの検証が必要。現行reviewでクラウド側の保持、logging、処理地域、実モデル利用可否を確認したとは主張しない。

## 7. テンプレート・出力・アセット

### 7.1 問診・プロンプト

- `questionnaire_templates`はテンプレートID・受診種別ごとの項目と追質問有効フラグ・上限件数を保存する。
- `summary_prompts` / `followup_prompts`に有効フラグとプロンプトを保存し、管理UIから編集する。テンプレート変更・初期化APIは管理者専用。
- 条件分岐、年齢・性別条件、選択肢、自由入力、個人情報ブロック等をフォームに反映する。郵便番号補助に失敗しても手入力を維持する。

### 7.2 インポート・エクスポート

- `/admin/sessions/export|import`と`/admin/questionnaires/export|import`は管理者専用。転送対象はschema allowlistで検査し、認証状態やLLM credentialを出力しない。患者記録のexport自体にはPIIが含まれ得る。
- JSON envelopeは`version/type/exported_at/payload`で構成し、任意パスワード付きのPBKDF2+Fernet形式を扱う。通常のJSONやZIPを自動的に暗号化済みと説明しない。
- importは5MiB・最大100record等の上限、厳格なschemaとアセット検査を行う。`merge|replace`のいずれも、検証完了後にアダプタのatomic import hookで反映する。認証状態・既存credentialを移送データから上書きしない。
- **SQLiteのatomic importは実装済み。** [sqlite_atomic_imports.py](<../backend/app/sqlite_atomic_imports.py>) と [SQLiteAdapter](<../backend/app/db/sqlite_adapter.py>) が同一接続・単一トランザクションで設定、画像、セッション等を更新し、失敗時はrollbackする。
- **CouchDB / Firestoreのatomic importは未対応で501。** 部分更新へのfallbackや本番データをsnapshotで巻き戻す代替処理はしない。アダプタ機能がない場合にUIだけで成功を見せない。
- [pdf_renderer.py](<../backend/app/pdf_renderer.py>) が問診結果・条件項目・個人情報ブロック等のPDFを構成する。PDF設定は管理者用`/system/pdf-layout`で扱い、ReportLabはPDF要求時に読み込む。

### 7.3 画像と保存領域

- 問診画像・ロゴは [transfer_security.py](<../backend/app/transfer_security.py>) で検証し、単一フレームのPNG / JPEG / WebPのみ受理する。SVG、HTML、アニメーションを拒否する。
- 入力と再encode後の画像は各512KiB以下、最大4,000,000pixel。デコード・再encodeでメタデータを除去し、拡張子・申告MIMEだけを信用しない。取得にも安全なヘッダーを適用する。
- アセットの正本は永続化アダプタのbinary asset保存であり、旧ローカル画像ディレクトリを現行の唯一の保存先としない。旧資産の起動時移行は明示的な設定・承認の下で扱い、Composeでは無効化する。

## 8. データストア・運用上の注意

### 8.1 SQLite / CouchDB

主なSQLiteテーブルは`questionnaire_templates`, `summary_prompts`, `followup_prompts`, `sessions`, `session_responses`, `llm_settings`, `app_settings`, `security_state`, `audit_logs`等。`sessions`には回答・進行情報だけでなく`pending_llm_questions_json`, `llm_question_texts_json`, `question_texts_json`も保存する。旧`users`が残っていても、現行管理者認証の正本ではない。

CouchDBのセッションdocumentにも進行状態・質問文・未処理質問を保存する。セッションDBとsecurity DBのアクセス権を分離し、公開設定・患者出力からsecurity状態へ到達させない。CouchDB利用時もローカル設定等を含む全保存先をバックアップ対象として把握する。

### 8.2 フロントエンド

- 患者フローは`/` → `/basic-info` → `/questionnaire` → `/questions` → `/done`。ルートガード、無操作監視、世代管理と消去処理を組み合わせる。単純な「reloadしたらトップへ戻す」だけをプライバシー対策にしない。
- 管理画面はlogin / enrollment / recoveryを経て、テンプレート、セッション、転送、LLM、外観、郵便番号、時刻、安全設定等へ遷移する。管理ページは遅延ロードする。
- [adminApi.ts](<../frontend/src/utils/adminApi.ts>) は同一originへのBearer送信、`no-store`、redirect拒否、401時の認証状態消去を担う。accessは15分であり、期限切れをUIだけで延長しない。
- `/system/bootstrap`は患者表示用の設定を一括取得し、テーマ・タイムゾーン等と共有する。管理者向けのDB/LLM詳細状態を患者表示のために照会しない。

### 8.3 設定・監査・バックアップ

- 主な環境設定: `MONSHINMATE_ENV`, `SECRET_KEY`, `TOTP_ENC_KEY`, `MONSHINMATE_DB`, `COUCHDB_URL`, `COUCHDB_DB`, `COUCHDB_SECURITY_DB`, `COUCHDB_USER`, `COUCHDB_PASSWORD`、LLM接続・宛先制限、CORS設定。旧`ADMIN_PASSWORD` / `ADMIN_EMERGENCY_RESET_PASSWORD`をbootstrap / recoveryの代替にしない。
- APIログはルートパターン・method・status・時間を中心とし、回答、password、OTP、token、QR secret、生の例外本文を記録しない。セキュリティ監査はcredentialを除いたイベントを扱い、既存user triggerが認証状態の正本ではない。
- `/metrics`は管理者限定。プロセス内の簡易カウンタをクラスタ全体の永続監査やレート制限の代わりにしない。
- バックアップは実際のSQLite / CouchDB各保存先・アセット・必要な暗号鍵を対象とし、暗号化・権限・保持期間・復元手順を運用で定義する。CouchDBのDB名一覧取得はバックアップではない。TOTP暗号鍵の紛失や無計画な差し替えはMFA復号不能につながる。
- 退役したcredentialの復活、旧capabilityの復活、残存leaseとの不整合を避けるため、security状態を含む復元・移行は通常の患者export/importとは別の承認付き作業として扱う。
- 今回の実装確認はローカル・合成データの範囲。実CouchDB / Firestore等の疎通、本番複数インスタンス、クラウドIAM・外部事業者保持方針まで検証済みと解釈しない。

## 9. 履歴: Geminiモデル選定とクラウド配置

> 以下は従来文書に記録されたモデル調査・移行判断の履歴を保存したものです。今回のセキュリティreviewで料金・GA状態・提供地域・実配備・移行完了を再検証していません。現行運用への指示や本番確認結果として扱わず、変更時は一次情報と承認済みの非公開運用記録を再確認してください。

2026-09-01の調査記録では、Gemini 2.5 Flashの移行候補は次のとおりとされていた。

- `gemini-3.5-flash-lite`: GA、Standard PayGoは`global` / `us` / `eu`。Global Standard料金は入力100万tokenあたり0.30米ドル、テキスト出力100万tokenあたり2.50米ドル。
- `gemini-3.1-flash-lite`: GA、Standard PayGoは`global` / `us` / `eu`。同料金は入力0.25米ドル、テキスト出力1.50米ドル。
- `gemini-3.5-flash`: GA。`asia-northeast1`では単一ゾーンProvisioned Throughputのみ、Standard PayGoは`global` / `us` / `eu`。同料金は入力1.50米ドル、テキスト出力9.00米ドル。

当時の記録では、`asia-northeast1`とStandard PayGoを同時に維持できる候補は見つからず、2026-09-16の承認で`gemini-3.1-flash-lite` / `us`へ移行する判断が記載された。アプリは`asia-northeast1`、Firestore / GCSは`asia-northeast2`、モデル処理は米国マルチリージョンという保存・処理地域の区別が説明されていた。新規GCPプロファイルの既定候補は同モデルと`global`、保存済みプロファイルはmodel / locationを維持する方針だった。今回、これらの実配備や移行の実施状況は確認していない。

通信設計の過去記録には、Vertex AIでADCを利用する単発`generateContent`、JSONキーファイル不使用、用途別JSON schema、Gemini 3系の温度省略、出力token 32〜65,536・timeout 5〜120秒、Grounding tools不使用が記載された。`role=user`のみの単発要求では`thoughtSignature`を返送する後続要求がなく、将来model応答やfunction responseを会話へ追加する場合はpartの順序と署名を保った再送が必要、とされた。これらも非公開実装を今回検証した結果ではない。

request-response loggingやプロジェクト単位のインメモリcacheを無効にする方針も記録されていたが、不正利用監視等の事業者側保持までゼロになる保証ではない。現行設定や除外申請の状態は別途確認が必要。

当時参照された一次情報: [モデルのライフサイクル](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)、[Gemini 3.5 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash)、[Gemini 3.5 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite)、[Gemini 3.1 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite)、[料金表](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)、[thought signatures](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures)、[GenerateContent Part](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/Content)。

## 10. 関連ドキュメント

- [管理者セットアップ・復旧](<admin_system_setup.md>)
- [管理者ユーザーマニュアル](<../docs/admin_user_manual.md>)
- [セッションAPI](<../docs/session_api.md>)
- [実装履歴と判断メモ](<implementation.md>)
- [セキュリティレビュー・本番反映前ゲート](<security_review.md>)
- [LLM通信の補足](<LLMcommunication.md>)（過去の手順と現行境界の差に注意）
