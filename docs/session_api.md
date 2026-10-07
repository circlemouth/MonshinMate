# セッションAPI仕様

本ドキュメントはセキュリティ修正版のAPI契約を示す。**破壊的変更あり・本番未反映**。既存UUIDだけの患者クライアント、無認証の管理API利用、旧パスワードリセットAPIは継続利用できない。

## 認可の共通規則

| 区分 | 必要な資格情報 |
| --- | --- |
| 患者セッション作成、問診テンプレート一覧・取得、表示用設定、郵便番号検索、死活状態 | 認証不要（作成には永続レート制限） |
| 患者回答・追加質問・確定 | 作成時の `session_token` を `Authorization: Bearer <token>` で送信 |
| 患者サマリー連携3 API | 専用 `X-MonshinMate-Api-Key`。患者/管理トークンで代替不可 |
| その他（設定の更新、プロンプト取得、診断、メトリクス、画像登録、全管理データ・ダウンロードを含む） | 有効な管理者Bearer JWT。画面の表示制御とは独立にサーバーで検証 |
| ログイン・登録・復旧手続き | 後述の用途限定challenge/enrollment/recovery資格情報 |

公開GETの正確な許可一覧は [api_policy.py](../backend/app/api_policy.py) が管理する。新設ルートは既定で管理者限定。URLクエリにトークンを入れない。応答には `Cache-Control: no-store`、`nosniff`、`no-referrer` を付ける。

通常リクエスト本文は256KiBまで。回答は深さ6、文字列4000文字、辞書200項目、キー128文字、配列100項目まで。未知の質問IDや未発行LLM質問は422。401=認証無効、409=確定済み/同時操作中、413=本文超過、429=レート制限、503=共有状態利用不能（ローカルメモリに退避して許可しない）。

## POST /patient-summary
- 概要: 患者名と生年月日をキーに、最新の確定済み問診を Markdown 形式で返す統合 API。
- リクエストヘッダー:
  - `X-MonshinMate-Api-Key` (str): Secret Managerから読み込む専用APIキー。登録済みでなければ失敗する。
- リクエストボディ:
  - `patient_name` (str): 患者氏名。NFKC正規化と空白除去後の完全一致で照合する。
  - `dob` (str): 生年月日。`YYYY-MM-DD` 以外に `/` や `.` で区切った表記、`令和5年4月1日` などの和暦表記も自動整形される。
- レスポンス:
  - `session_id` (str)
  - `patient_name` (str)
  - `dob` (str)
  - `visit_type` (str | null)
  - `questionnaire_id` (str | null)
  - `finalized_at` (str | null)
  - `markdown` (str): `build_markdown_lines` と同じ形式の Markdown 本文。
- 備考:
  - 氏名と生年月日が一致するセッションから、最も新しい `completion_status='finalized'` の一件を返す。
  - 氏名の部分一致、候補なし、曖昧な照合、未確定セッションは返さない。該当なしの場合は404。
  - 認証失敗時のログとエラー本文には、患者氏名、生年月日、APIキーを記録しない。
  - API キー未設定/無効な場合は 401。
  - `/system/patient-summary-api` ではエンドポイント、ヘッダー名、キー状態だけを確認できる。
  - 公開HTTP面からのキー登録と更新は無効であり、Secret Managerのrotationと再デプロイで更新する。

## POST /patient-summaries

- 概要: 患者名と生年月日が完全一致する確定済み問診履歴を、新しい順にページ返却する。
- リクエストヘッダー:
  - `X-MonshinMate-Api-Key` (str): Secret Managerから読み込む専用APIキー。
- リクエストボディ:
  - `patient_name` (str): NFKC正規化と空白除去後の完全一致で照合する患者氏名。
  - `dob` (str): 生年月日。`POST /patient-summary`と同じ日付正規化を行う。
  - `cursor` (str | null): 前ページの`next_cursor`。初回は`null`。値は最後に返したセッションを示す不透明カーソルとして扱う。
  - `limit` (int): 1〜100。既定値は20。
- レスポンス:
  - `items` (array): 問診履歴。
  - `items[].session_id` (str)
  - `items[].patient_name` (str)
  - `items[].dob` (str)
  - `items[].visit_type` (str | null)
  - `items[].questionnaire_id` (str | null)
  - `items[].started_at` (str | null)
  - `items[].finalized_at` (str | null)
  - `items[].markdown` (str): `build_markdown_lines`と同じ形式のMarkdown本文。
  - `items[].gender` (str | null)
  - `items[].personal_info` (object): `kana`、`postal_code`、`address`、`phone`、`address_parts`を含む。各値がない場合は`null`。
  - `items[].personal_info.address_parts` (object | null): 郵便番号辞書で解決した`prefecture`、`city`、`town`。
  - `next_cursor` (str | null): 次ページがない場合は`null`。
- 備考:
  - データベースをカーソル方式で最後まで走査し、`completion_status='finalized'`の完全一致セッションだけを返す。
  - 該当がない場合は`items=[]`と`next_cursor=null`を返す。
  - 無効なカーソルは400、認証失敗は401、レート制限は429。

## POST /patient-summary/pdf

- 概要: 指定した患者に所有される確定済み初診問診を、既存の管理画面用帳票レイアウトでPDF出力する。
- リクエストヘッダー:
  - `X-MonshinMate-Api-Key` (str): Secret Managerから読み込む専用APIキー。
- リクエストボディ:
  - `patient_name` (str): 所有者照合に使う患者氏名。
  - `dob` (str): 所有者照合に使う生年月日。
  - `session_id` (str): 初診問診のセッションID。
- レスポンス:
  - 本文は`application/pdf`。
  - `Cache-Control: no-store`を設定する。
  - ファイル名は`問診票_初診_YYYYMMDD_<session-short>.pdf`で、患者氏名を含めない。
- 備考:
  - 氏名と生年月日が指定セッションに完全一致し、`visit_type='initial'`かつ`completion_status='finalized'`の場合だけ返す。
  - 対象なし、所有者不一致、初診以外、未確定はいずれも404とし、他患者の存在を区別できない応答にする。

## POST /sessions
- 概要: 新しい問診セッションを作成する。
- リクエストボディ:
  - `patient_name` (str): 患者氏名
  - `dob` (str): 生年月日 (YYYY-MM-DD)
  - `gender` (str): 性別 (`male` or `female`)
  - `visit_type` (str): 初診/再診などの種別
- `answers` (object): 既知の回答。初診 (`visit_type=initial`) の場合は `personal_info` キーに
  `{ name, kana, postal_code, address, phone }` を含め、固定UIで入力された患者基本情報を
  サーバーに送信する。
- レスポンス:
  - `status` (str): 作成結果。固定値 `created`
  - `id` (str): セッションID（資格情報ではない）
  - `session_token` (str): ランダムな患者専用トークン。サーバーにはハッシュのみ保存。
  - `expires_at` (str): ISO8601形式、発行から24時間。
  - `answers` (object): 現在までの回答
- 制約: 氏名1〜128文字、生年月日1〜32文字、性別32文字以内、`visit_type` は `initial` / `followup`、`questionnaire_id` は128文字以内。
- 作成制限: IPごと60件/分、全体300件/分（全ワーカー共有）。期限切れ・紛失時のUUIDからのトークン再発行APIはない。旧セッションの管理閲覧は可能だが患者の再開は不可。
- 備考: 空欄で送信された回答は「該当なし」として保存される。患者端末は完了/中止/アイドル時に資格情報と回答を消去する。

## GET /postal-code/{postal_code}
- 概要: 郵便番号から住所候補を検索する。患者画面の住所自動入力で利用する。
- パスパラメータ:
  - `postal_code` (str): 7桁の郵便番号。ハイフンや全角数字を含んでもサーバー側で正規化する。
- レスポンス:
  - `postal_code` (str): 正規化後の7桁。
  - `found` (bool): 候補が見つかったか。
  - `address` (str | null): 最初の住所候補。見つからない場合は `null`。
  - `candidates` (array): `{ postal_code, prefecture, city, town, address }` の候補一覧。
- 備考: 見つからない場合も 200 で `found=false` を返す。フロントエンドは住所欄の手入力へフォールバックする。

## GET /system/postal-code-dictionary
- 概要: 郵便番号辞書の登録状態を返す。初回アクセス時、同梱CSVがあれば住所検索用の SQLite 辞書を生成する。
- レスポンス:
  - `is_available` (bool)
  - `row_count` (int)
  - `source_filename` (str | null)
  - `last_updated_at` (str | null): ISO8601形式の最終更新日時。

## POST /system/postal-code-dictionary
- 概要: 管理画面からアップロードした KEN_ALL 形式CSVで郵便番号辞書を更新する。
- リクエスト: `multipart/form-data`
  - `file` (file): UTF-8 CSV。
- レスポンス: `GET /system/postal-code-dictionary` と同じ。
- エラー:
  - CSVが空、形式不正、UTF-8以外の場合は 400。

## POST /sessions/{session_id}/answers
- 概要: 複数の回答をまとめて保存する。
- リクエストボディ:
  - `answers` (object): `{ 質問ID: 回答 }`
- レスポンス:
  - `{ status: "ok", remaining_items: string[] }`
- 備考: 型や選択肢を検証し、不正な場合は 400 を返す。空欄で送信された回答は「該当なし」として保存される。

## POST /sessions/{session_id}/llm-questions
- 概要: これまでの回答を踏まえて追加質問を生成する。LLM との通信は1回で、生成された質問はまとめて返却される。
- レスポンス:
  - `questions` (array): 追加質問リスト。各要素は `id`, `text`, `expected_input_type`, `priority` を含む。
- 備考: LLM が無効化されている場合は常に空配列を返す。フロントエンドは取得した質問を `pending_llm_questions` としてセッションストレージに保持し、未消費の質問が残っている間は本エンドポイントを再度呼び出さない。質問をすべて消費した時点で再度呼び出す。

## POST /sessions/{session_id}/llm-answers
- 概要: 追加質問への回答を保存する。
- リクエストボディ:
  - `item_id` (str): 質問項目ID
  - `answer` (any): 回答内容
- レスポンス:
  - `{ status: "ok", remaining_items: string[] }`
- 備考: 型や選択肢を検証し、不正な場合は 400 を返す。空欄で送信された回答は「該当なし」として保存される。

## POST /sessions/{session_id}/llm-answers/batch

- 概要: 追加質問への複数回答を、一回のリクエストと永続化書き込みで保存する。
- リクエストボディ:
  - `answers` (object): `{ 質問ID: 回答 }`
- レスポンス:
  - `{ status: "ok", remaining_items: string[] }`
- 備考: 従来の単件APIは互換性のため継続して利用できる。

## POST /sessions/{session_id}/finalize
- 認証: 当該患者のBearerトークン必須。他患者・管理者のトークンでは代替できない。
- 概要: 共有DB上の操作ロック内で要約を同期生成し、セッションを確定する。確定済み回答の変更・追加質問生成は409。
- リクエストボディ: `llm_error` (str, 任意) は障害の有無としてのみ利用し、原文は保存・要約へ追記しない。
- レスポンス: `{ "id": "<session-id>", "status": "finalized", "finalized_at": "<ISO8601>" }` の受付情報のみ。**氏名・回答・要約は返さない**。
- 応答消失時は同じトークンで再試行し同じ受付情報を取得する。確定済み記録がある場合は要約を再生成しない。通知はbest-effortで、永続outboxによるexactly-once配信は保証しない。
- 追加質問・要約のLLM利用枠はセッションごと10回/分、全体120回/分。設定変更で過去の問診を自動再送しない。
- 操作中の競合は409。プロセス強制終了でロックが残った場合も時間だけで奪取せず、運用者による記録整合性の確認が必要。
- LLM送信はテンプレートに定義された臨床項目と実際に発行した追加質問に限定し、氏名・住所・電話等の既知の識別項目を除外する。ただし自由記述中の識別情報を完全匿名化する保証ではない。
- クライアントは確定を汎用オフラインキューに積まず明示的再試行とする。正常完了後は保存回答・患者トークン・再送キューを消去して履歴を置換し、戻る操作による再表示を防ぐ。

## GET /admin/sessions/page

- 概要: 管理画面の通常一覧をカーソル方式で取得する。
- クエリ:
  - `limit` (int): 1〜200。既定値は50。
  - `cursor` (str, 任意): 直前の応答に含まれる `next_cursor`。
- レスポンス: `{ items: SessionSummary[], next_cursor: string | null }`
- 備考: 条件検索では従来の `GET /admin/sessions` を使用する。

※ 通常の既定はSQLite。CouchDBを明示設定した場合はセッションと回答をCouchDBに保存する。固定項目の回答に加え、LLM による追加質問で提示された「質問文」とその回答のペアも保存対象。環境変数 `COUCHDB_URL` を設定しない場合は従来通り SQLite に保存される。`COUCHDB_URL` に認証情報を含めない場合は、`COUCHDB_USER` と `COUCHDB_PASSWORD` を併せて設定する。CouchDB が設定されているにもかかわらず保存に失敗した場合、SQLite へは保存されずエラーとなる。サンプル `.env` では `COUCHDB_URL=http://couchdb:5984/` などが設定されており、Docker Compose で構築した CouchDB とそのまま連携できる。

## GET /llm/settings

- 概要: 現在のLLM設定を取得する。
- 認証: `POST /admin/login` またはTOTP完了後に受け取るJWTを `Authorization: Bearer <token>` で送る。未認証は401、管理者scopeがなければ403を返す。
- レスポンス:
  - `provider` (str)
  - `model` (str)
  - `temperature` (float)
  - `system_prompt` (str)
  - `enabled` (bool): LLM を利用するかどうか
  - `api_key_configured` (bool): API keyが保存済みかどうか。値そのものは返さない。
  - `provider_profiles` (object): プロバイダ別の非機密設定。`service_account_json`、API key、認証token、秘密鍵fieldは含まれない。

## PUT /llm/settings

- 概要: LLM設定を更新する。未認証は401、管理者scopeがなければ403を返す。
- 認証: 管理者JWTを `Authorization: Bearer <token>` で送る。
- リクエストボディ:
  - `provider` (str)
  - `model` (str)
  - `temperature` (float)
  - `system_prompt` (str)
  - `enabled` (bool)
- レスポンス:
  - 更新後の非機密設定。読み取り応答と同じく秘密値を含まない。
- 備考: `gcp_vertex` はApplication Default Credentialsを使う。`service_account_json` を送っても利用または保存しない。

## POST /llm/settings/test

- 概要: LLM接続の疎通テストを行う。管理画面では保存時に自動実行されるが、個別に呼び出すこともできる。
- 認証: 管理者JWTが必要。
- レスポンス:
  - `status` (str): 疎通状態。`ok` で成功。

## GET /llm/providers

- 概要: 管理画面を構成するプロバイダ情報を返す。
- 認証: 管理者JWTが必要。
- 備考: GCPプロバイダはJSONキーファイル入力を公開せず、ADC利用を案内する。

## POST /llm/list-models

- 概要: 指定したプロバイダのモデル候補を取得する。
- 認証: 管理者JWTが必要。

## GET /system/llm-status

- 概要: 直近のLLM通信結果、更新契機、確認時刻を返す。
- 認証: 管理者JWTが必要。

## GET /system/llm-availability

- 概要: 患者画面に必要な `status` だけを返す。
- 認証: 不要。
- 備考: 設定値、エラー詳細、更新契機、確認時刻は返さない。

## 管理者認証API（旧契約との互換性なし）

- `GET /admin/auth/status`: 公開用の状態投影。初期登録可能性、認証済み状態等のみ。旧 `/admin/password/status` は使用しない。
- `POST /admin/login` `{password}`: MFA有効時は `{status:"totp_required",challenge_token,expires_in:300}`。MFA登録が未完了なら `{status:"enrollment_required",enrollment_token,expires_in:600}`。`MONSHINMATE_ADMIN_REQUIRE_MFA=0` かつMFA未登録・必須登録途中でない場合は、`{status:"ok",access_token,token_type:"bearer",expires_in:900}` を直接返す。未指定の本番／明示 `1` はMFA必須。不正設定値は拒否し、既存MFA・必須登録途中・ロック・由来不明pendingは `0` でも迂回しない。
- `POST /admin/login/totp` `{challenge_token,totp_code}`: パスワード検証に結び付いた単回challengeを消費し、`access_token`、`token_type:"bearer"`、`expires_in:900` を返す。TOTPだけのログインは不可。同一30秒ステップのコード再使用は、登録・ログイン・再認証間でも拒否する。
- `POST /admin/bootstrap` / `POST /admin/recovery` `{credential,new_password}`: オフラインCLIで作成した用途別・短命・単回資格情報を使用。明示 `MONSHINMATE_ADMIN_REQUIRE_MFA=0` なら通常のaccess応答、それ以外はMFA登録用トークンを返す。後者は管理APIへの権限をまだ与えない。既定/固定の初期・非常用パスワードはない。
- `POST /admin/totp/setup` / `POST /admin/totp/regenerate`: 登録用Bearer、または管理者Bearer＋`X-Admin-Reauth` が必要。`enrollment_id`、`provisioning_uri`、`qr_code_data_url`、`expires_in:600` を一度だけ返す。既存MFAは新しいコード検証成功まで維持。
- `POST /admin/totp/verify` `{enrollment_id,totp_code}`: 同じ所有者・用途のBearer（再登録時は再認証も）を検証。成功でMFA有効化、新しい管理JWTを発行し旧トークンを失効。
- `POST /admin/reauth` `{password,totp_code?}`: 管理Bearer必須。MFA有効アカウントだけ `totp_code` も必要。現在のJWT識別子に結び付いた `reauth_token`（300秒）を返す。
- `POST /admin/password/change` `{current_password,new_password}`: 管理Bearer＋`X-Admin-Reauth: <reauth_token>` 必須。MFAは維持、全旧アクセストークンを失効する。新パスワードは12文字以上、UTF-8で72バイト以下。
- `POST /admin/totp/disable`: 管理Bearer＋再認証が必要。MFA必須ポリシーでは禁止。
- 旧 `POST /admin/password`、旧 `/admin/password/reset/*`、`GET /admin/totp/setup`、`PUT /admin/totp/mode` は410。

現パスワードの継承は承認済みオフライン `migrate-legacy` に限定し、HTTPや起動時に旧アカウントを自動信頼しない。手順・移行時のバックアップ・適用条件は [セットアップ手順](../internal_docs/admin_system_setup.md) を参照。秘密鍵はアプリimport前に供給し、紛失したTOTP鍵を新規キーで黙って置換してはならない。

## GET /admin/sessions
- 概要: 保存済みセッションの一覧を取得する。
- クエリパラメータ:
  - `patient_name` (str, 任意): 患者名（部分一致。前後の空白や半角/全角スペースを除いた比較でも一致判定）
  - `dob` (str, 任意): 生年月日 (YYYY-MM-DD)
  - `start_date` (str, 任意): 問診日の開始日 (YYYY-MM-DD)
  - `end_date` (str, 任意): 問診日の終了日 (YYYY-MM-DD)
- レスポンス:
  - `Array<{ id: string, patient_name: string, dob: string, visit_type: string, finalized_at: string | null }>`

## GET /admin/sessions/{session_id}
- 概要: 指定セッションの詳細を取得する。
- レスポンス:
  - `id` (str)
  - `patient_name` (str)
  - `dob` (str)
  - `visit_type` (str)
  - `questionnaire_id` (str)
  - `answers` (object)
  - `question_texts` (object, 任意): 保存時点の問診項目IDと質問文のマップ（テンプレ変更後も元の文言を保持）
  - `llm_question_texts` (object, 任意): 追加質問ID（`llm_1` など）と提示した質問文のマップ
  - `summary` (str|null)
  - `finalized_at` (str|null)

## GET /questionnaires/{id}/template?visit_type=initial|followup[&gender=male|female][&age=30]
- 概要: 指定テンプレート（id, visit_type）の問診テンプレートを返す。未登録時は既定テンプレを返す。
  `gender` を指定した場合は該当性別の項目のみを返し、`age` を指定した場合は年齢条件を満たす項目のみを返す。
- レスポンス:
  - `Questionnaire`: `{ id: string, items: QuestionnaireItem[], llm_followup_enabled: bool, llm_followup_max_questions: int }`

## GET /questionnaires
- 概要: 登録済みテンプレートの一覧（id と visit_type）を返す。
- レスポンス:
  - `Array<{ id: string, visit_type: string }>`

## POST /questionnaires
- 概要: テンプレートの作成・更新。
- リクエストボディ:
  - `id` (str): テンプレートID
  - `visit_type` (str): `initial` | `followup`
  - `items` (QuestionnaireItem[]): 項目配列
  - `QuestionnaireItem` = `{ id, label, type, required?, options?, allow_freetext?, when?, description?, gender_enabled?, gender?, age_enabled?, min_age?, max_age?, image?, min?, max? }`
    - `type`: `"string"` | `"multi"` | `"yesno"` | `"date"` | `"slider"`
    - `gender_enabled`: 性別による表示制限を行うか
    - `gender`: `"male"` | `"female"`（`gender_enabled` が `true` のとき対象性別を指定）
    - `age_enabled`: 年齢による表示制限を行うか
    - `min_age`/`max_age`: 年齢下限・上限（`age_enabled` が `true` のとき使用）
    - `image`: 画像のデータURL文字列（任意）。削除する場合は `null` を送信するかフィールドを省略してください。
    - `min`/`max`: `type` が `"slider"` の場合に範囲を指定。省略時は `0` 〜 `10`。
  - `llm_followup_enabled` (bool): 固定フォーム終了後にLLMによる追加質問を行うか（LLM設定が有効な場合のみ有効）
  - `llm_followup_max_questions` (int): 生成する追加質問の最大個数
- レスポンス:
  - `{ status: "ok" }`

## GET /questionnaires/{id}/summary-prompt?visit_type=initial|followup
- 概要: サマリー生成に使用するシステムプロンプトと有効フラグを取得する。
- レスポンス:
  - `{ id: string, visit_type: string, prompt: string, enabled: bool }`
  - 設定が存在しない場合、医療記録向けの既定プロンプトと `enabled: false` を返す。

## POST /questionnaires/{id}/summary-prompt
- 概要: サマリー生成用プロンプトを保存する。
- リクエストボディ:
  - `visit_type` (str): `initial` | `followup`
  - `prompt` (str): サマリー生成に用いるシステムプロンプト。
  - `enabled` (bool): サマリー生成を有効にするか。
- レスポンス:
  - `{ status: "ok" }`

## GET /questionnaires/{id}/followup-prompt?visit_type=initial|followup
- 概要: 追加質問生成に使用するプロンプトと有効フラグを取得する。
- レスポンス:
  - `{ id: string, visit_type: string, prompt: string, enabled: bool }`

## POST /questionnaires/{id}/followup-prompt
- 概要: 追加質問生成用プロンプトを保存する。
- リクエストボディ:
  - `visit_type` (str): `initial` | `followup`
  - `prompt` (str): プロンプト文字列。`{max_questions}` が上限値に置換される。
  - `enabled` (bool): アドバンストモードでのプロンプト使用を有効にするか。
- レスポンス:
  - `{ status: "ok" }`

## DELETE /questionnaires/{id}?visit_type=...
- 概要: 指定テンプレートを削除。
- レスポンス:
  - `{ status: "ok" }`

## POST /questionnaires/{id}/duplicate
- 概要: 指定テンプレートを新しいIDで複製する。
- リクエストボディ:
  - `new_id` (str): 複製先のテンプレートID
- レスポンス:
  - `{ status: "ok" }`

## POST /questionnaires/{id}/rename
- 概要: 指定テンプレートのIDを変更する。
- リクエストボディ:
  - `new_id` (str): 新しいテンプレートID。既存IDと重複不可、`default` への変更は不可。
- 制約:
  - `default` テンプレートはリネームできません。
  - 変更後はテンプレート本体・サマリープロンプト・追加質問プロンプト・デフォルトテンプレート設定・セッション参照が新IDへ更新されます。
- レスポンス:
  - `{ status: "ok", id: string }`

## GET /health
- 概要: 死活監視用の簡易エンドポイント。`{"status":"ok"}` を返す。

## GET /readyz
- 概要: 依存サービス（DB・LLM）の疎通確認を行う。利用可能な場合は `{"status":"ready"}` を返す。

## GET /metrics
- 概要: 管理者Bearer必須。OpenMetrics形式の最小メトリクスを返す。

## 入出力の安全境界

- エクスポート/ダウンロード/画像登録/インポートは管理者Bearer必須。CSVの数式開始文字は無害化する。
- 画像登録はPNG/JPEG/WebP、512KiB以下、400万画素以下、単一フレームを再エンコード。SVG/HTML等は不可。旧保存画像も配信時検証。
- インポートは5MiB以下、セッション100件以下。暗号化形式のKDFは固定パラメータを検証し、受信側で任意反復回数を実行しない。認証状態/患者トークン/秘密APIキーをポータブルエクスポートに含めない。
- SQLiteのmerge/replaceは設定・画像・セッションごとの原子トランザクション。セッションの対象に未完了能力トークンまたは操作中ロックがあれば409（期限切れでも自動消去しない）。成功時に対象患者能力を失効する。
- 原子的インポート契約を満たさないアダプタは501で変更前に拒否する。CouchDBの横断インポートは非対応、非公開Firestore実装は未検証。
- インポートしたLLM設定は次回起動時に反映し、インポートを契機に過去の問診の外部再送やLLM疎通を実行しない。
