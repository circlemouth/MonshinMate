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
