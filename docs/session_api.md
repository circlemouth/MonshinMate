# セッションAPI仕様

本ドキュメントはセッション関連エンドポイントの仕様を示す。

## POST /sessions
- 概要: 新しい問診セッションを作成する。
- リクエストボディ:
  - `patient_name` (str): 患者氏名
  - `dob` (str): 生年月日 (YYYY-MM-DD)
  - `gender` (str): 性別 (`male` or `female`)
  - `visit_type` (str): 初診/再診などの種別
  - `answers` (object): 既知の回答
- レスポンス:
  - `status` (str): 作成結果。固定値 `created`
  - `id` (str): セッションID
  - `answers` (object): 現在までの回答
- 備考: 空欄で送信された回答は「該当なし」として保存される。

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

## POST /sessions/{session_id}/finalize
- 概要: セッションを確定し要約を生成する（回答送信後すぐに呼び出される）。
- リクエストボディ:
  - `llm_error` (str, 任意): LLM通信に失敗した場合のエラー内容。指定された場合、要約末尾に追記される。
- レスポンス:
  - `summary` (str): 生成された要約。サマリー作成モードが無効の場合は空文字
  - `answers` (object): 確定した回答
  - `finalized_at` (str): ISO8601形式の確定時刻
  - `status` (str): `finalized`

※ セッションと回答は既定で CouchDB に保存される。固定項目の回答に加え、LLM による追加質問で提示された「質問文」とその回答のペアも保存対象。環境変数 `COUCHDB_URL` を設定しない場合は従来通り SQLite に保存される。`COUCHDB_URL` に認証情報を含めない場合は、`COUCHDB_USER` と `COUCHDB_PASSWORD` を併せて設定する。CouchDB が設定されているにもかかわらず保存に失敗した場合、SQLite へは保存されずエラーとなる。サンプル `.env` では `COUCHDB_URL=http://couchdb:5984/` などが設定されており、Docker Compose で構築した CouchDB とそのまま連携できる。

## GET /llm/settings
- 概要: 現在の LLM 設定を取得する。
- レスポンス:
  - `provider` (str)
  - `model` (str)
  - `temperature` (float)
  - `system_prompt` (str)
  - `enabled` (bool): LLM を利用するかどうか

## PUT /llm/settings
- 概要: LLM 設定を更新し、保存時に疎通テストを行う。失敗時は 400 エラーを返す。
- リクエストボディ:
  - `provider` (str)
  - `model` (str)
  - `temperature` (float)
  - `system_prompt` (str)
  - `enabled` (bool)
- レスポンス:
  - 更新後の同項目

## POST /llm/settings/test
- 概要: LLM 接続の疎通テストを行う。管理画面では保存時に自動実行されるが、個別に呼び出すことも可能。
- レスポンス:
  - `status` (str): 疎通状態。`ok` で成功。

## POST /admin/login
- 概要: 管理画面へのログインを行う。
- リクエストボディ:
  - `password` (str): 管理者パスワード
- レスポンス:
  - `{ status: "ok" }`（成功時）

## GET /admin/password/status
- 概要: 管理者パスワードが初期状態かどうかを確認する。
- レスポンス:
  - `is_default` (bool): `true` の場合はパスワードが未設定（既定値）であり、フロントエンドで新規設定画面を表示する必要がある。

## POST /admin/password
- 概要: 管理者パスワードを新しく設定する。
- リクエストボディ:
  - `password` (str): 新しいパスワード
- レスポンス:
  - `{ status: "ok" }`（成功時）

## POST /admin/password/change
- 概要: 現在のパスワードを入力して新しいパスワードに変更する。変更時に二段階認証は無効化される。
- リクエストボディ:
  - `current_password` (str): 現在のパスワード
  - `new_password` (str): 新しいパスワード
- レスポンス:
  - `{ status: "ok" }`（成功時）

## GET /admin/sessions
- 概要: 保存済みセッションの一覧を取得する。
- クエリパラメータ:
  - `patient_name` (str, 任意): 患者名（部分一致）
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
  - `llm_question_texts` (object, 任意): 追加質問ID（`llm_1` など）と提示した質問文のマップ
  - `summary` (str|null)
  - `finalized_at` (str|null)

## GET /questionnaires/{id}/template?visit_type=initial|followup[&gender=male|female]
- 概要: 指定テンプレート（id, visit_type）の問診テンプレートを返す。未登録時は既定テンプレを返す。`gender` を指定した場合は該当性別の項目のみを返す。項目側の `gender` が未設定または `"both"` の場合は常に含まれる。
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
  - `QuestionnaireItem` = `{ id, label, type, required?, options?, allow_freetext?, when?, description?, gender?, image? }`
    - `gender`: `"male"` | `"female"` | `"both"`（省略または `"both"` の場合は男女共通）
    - `image`: 画像のデータURL文字列（任意）。削除する場合は `null` を送信するかフィールドを省略してください。
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

## GET /health
- 概要: 死活監視用の簡易エンドポイント。`{"status":"ok"}` を返す。

## GET /readyz
- 概要: 依存サービス（DB・LLM）の疎通確認を行う。利用可能な場合は `{"status":"ready"}` を返す。

## GET /metrics
- 概要: OpenMetrics 形式の最小メトリクスを返す。

