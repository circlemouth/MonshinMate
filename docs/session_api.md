# セッションAPI仕様

本ドキュメントはセッション関連エンドポイントの仕様を示す。

## POST /sessions
- **概要**: 新しい問診セッションを作成する。
- **リクエストボディ**:
  - `patient_name` (str): 患者氏名
  - `dob` (str): 生年月日 (YYYY-MM-DD)
  - `visit_type` (str): 初診/再診などの種別
  - `answers` (object): 既知の回答
- **レスポンス**:
  - `status` (str): 作成結果。固定値 `created`
  - `id` (str): セッションID
  - `answers` (object): 現在までの回答

## POST /sessions/{session_id}/answer
- **概要**: 指定セッションに回答を追加し、追質問を返す。
- **リクエストボディ**:
  - `item_id` (str): 質問項目ID
  - `answer` (any): 回答内容
- **レスポンス**:
  - `questions` (array): 追質問リスト。各要素は `id`, `text`, `expected_input_type`, `priority` を含む。

## POST /sessions/{session_id}/finalize
- **概要**: セッションを確定し要約を生成する。
- **レスポンス**:
  - `summary` (str): 生成された要約
  - `answers` (object): 確定した回答

※ 現段階ではセッションはメモリ上にのみ保持される。

## POST /llm/settings/test
- **概要**: LLM 接続の疎通テストを行う（現状はスタブで常に `{"status":"ok"}` を返す）。
- **レスポンス**:
  - `status` (str): 疎通状態。`ok` で成功。

## GET /questionnaires/{id}/template?visit_type=initial|followup
- **概要**: 指定テンプレート（id, visit_type）の問診テンプレートを返す。未登録時は既定テンプレを返す。
- **レスポンス**:
  - `Questionnaire`: `{ id: string, items: QuestionnaireItem[] }`

## GET /questionnaires
- **概要**: 登録済みテンプレートの一覧（id と visit_type）を返す。
- **レスポンス**:
  - `Array<{ id: string, visit_type: string }>`

## POST /questionnaires
- **概要**: テンプレートの作成・更新。
- **リクエストボディ**:
  - `id` (str): テンプレートID
  - `visit_type` (str): `initial` | `followup`
  - `items` (QuestionnaireItem[]): 項目配列
- **レスポンス**:
  - `{ status: "ok" }`

## DELETE /questionnaires/{id}?visit_type=...
- **概要**: 指定テンプレートを削除。
- **レスポンス**:
  - `{ status: "ok" }`
