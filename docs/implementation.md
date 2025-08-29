# 実装手順書（Minimal 版 / v1）

> 重要な注意（更新）：既定ではローカルLLMのみを使用しますが、管理画面の設定で任意に「リモートの Ollama / LM Studio サーバー」を指定可能です。リモート設定を有効にした場合は当該サーバーへプロンプト・入力が送信されます。院内運用ポリシーに従い、必要な場合のみ有効化してください。フッターの注意書きは「既定はローカル運用で外部送信なし。リモートを有効にした場合は送信あり」に読み替えてください。

本書は、これまで合意した **「実装計画書（Minimal 版）」** と **「フロントエンドUI構築設計書」** に整合する形で、段取り（マイルストーン・WBS）と実施手順を示します。禁忌/赤旗・辞書正規化・緊急分岐・同意画面・重複照合/ID発行・ハードガード追質問はスコープ外です。

---

## 0. 目的 / スコープ
- 目的：
  - 患者名・生年月日の入力 → 初診/再診分岐 → テンプレートに基づくベース問診 → LLMによる最小追加質問 → 完了、までを **細い導線** で実装する。
- スコープ：
  - 患者向けフローと管理画面（テンプレート管理、LLM接続設定）
  - バックエンドAPI（セッション、テンプレートCRUD、LLM質問生成、最終化）
- 非スコープ：
  - 禁忌/赤旗、辞書・正規化、緊急時分岐、ルールベース追質問、同意画面、重複照合/ID発行

---

## 1. マイルストーン（MS）と完了条件

### MS1：管理UI/テンプレ整備
- 目的：初診/再診テンプレートのCRUDとプレビューを提供
- **完了条件**
  - [x] テンプレート一覧/新規/編集/削除が動作
  - [x] 新規テンプレートの既定問診項目ラベルを「質問文形式」に統一（例："主訴は何ですか？"、"発症時期はいつからですか？"）
- [x] 項目ごとに「初診」「再診」への適用可否をチェックボックスで設定
  - [x] 条件表示（軽量 when）の保存/反映
  - [x] プレビューで患者側画面の疑似レンダリング
    - `when` は `{ "item_id": 参照項目ID, "equals": 値 }` 形式で、条件が満たされた場合にのみ対象項目を表示する。

### MS2：セッション基盤
- 目的：セッション生成と状態遷移（Entry→種別→問診→追加質問→確認→完了）
- **完了条件**
  - [x] `POST /sessions` でセッション作成
  - [x] 進行状態（remaining_items / completion_status / attempt_counts）の保持
  - [x] 画面遷移ガード（未入力時の差し戻し）

### MS3：LLM追加質問ループ
- 目的：不足項目のみを**上限N件**で質問し、ターン制御で補完
- **完了条件**
  - [x] `POST /sessions/{id}/llm-questions` が `questions[]` を返す
  - [x] 優先度順に提示し、回答送信→再計算→終了条件（0件/上限/手動終了）
  - [x] 項目ごとの再質問は最大3回、セッション合計の上限Nはテンプレートで設定可能
  - [x] 回答をまとめてLLMへ送信し、追加質問を一括生成する

### MS4：要約と保存
- 目的：全回答の一覧確認→確定→保存/要約出力
- **完了条件**
  - [x] 追加質問終了後、自動的にセッションを確定して要約を生成
  - [x] `POST /sessions/{id}/finalize` が `summaryText` と `allAnswers` を返す
  - [x] 完了ステータスとタイムスタンプ保存
  - [x] LLM 設定が有効かつ疎通OKの場合、バックグラウンドでカスタムプロンプトを用いたサマリー生成を実行（UIは非ブロッキング）
  - [x] サマリープロンプトはテンプレート管理画面から「初診」「再診」それぞれ編集/保存可能

### MS5：フロント実装（患者/管理）
- 目的：UI導線と状態管理の実装
- **完了条件**
  - [x] **患者**：Entry（氏名/生年月日＋受診種別）→ Questionnaire → Questions → Done
    - [x] Entry で氏名・生年月日を入力
    - [x] Entry で「当院の受診は初めてですか？」を選択（「初めて」= initial / 「受診したことがある」= followup）しセッション作成
    - [x] Questionnaire で text/multi/yesno/date に応じた入力フォームを表示
    - [x] Questions で追加質問を順次表示
    - [x] 追加質問終了後は自動的に完了画面へ遷移
  - [x] Done で要約を表示
  - [x] **共通**：ヘッダー右上「管理画面」ボタン、フッター注意文の常時表示
- [x] **管理**：ログイン→テンプレート→問診結果→LLM設定
  - [x] 問診結果一覧と詳細表示

### MS6：ログ/観測性（最小）
- 目的：障害時の原因追跡と操作把握
- **完了条件**
  - [x] セッション遷移、APIエラー、LLM I/Oメタ（所要時間）の記録
- [x] /readyz, /health の簡易エンドポイント

### MS7：リモートLLM接続（任意）
- 目的：Ollama / LM Studio の遠隔サーバーへ接続可能にする
- 完了条件
  - [x] `LLMSettings` に `base_url`/`api_key` を追加（任意項目）
  - [x] `provider=ollama` 時は `POST {base_url}/api/chat` を使用
  - [x] `provider=lm_studio` 時は OpenAI互換 `POST {base_url}/v1/chat/completions` を使用
  - [x] `/llm/settings/test` は `base_url` 未設定時は常に OK、設定時は疎通を確認
  - [x] 失敗時はログ出力の上、スタブ応答にフォールバック
  - [x] 追加質問生成で構造化出力を強制（LLMcommunication.md 準拠）
    - Ollama: `/api/chat` の `format` に JSON Schema（`array<string>`、maxItems=上限）を指定
    - LM Studio: `/v1/chat/completions` の `response_format.json_schema` に同スキーマを指定
    - 返却は文字列JSONのため受信後に `json.loads()` でパースして配列に変換
    - プロンプト側でも「JSON配列で返答」を明記（冗長対策）

> 実装メモ（2025-08-27）：`backend/app/llm_gateway.py::generate_followups` を更新し、
> LM Studio / Ollama 双方に対して JSON Schema による構造化出力を強制するよう変更。
> これにより不正な文字列混入を防ぎ、配列パースの安定性を向上。

### MS7：UAT / 受け入れ
- 目的：エンドツーエンド検証
- **完了条件**
  - [x] 初診/再診の代表テンプレで入力→追加質問→確定が成功
  - [x] LLM無効時でもベース問診のみで完了
  - [x] 受け入れ基準（§10）を満たす

---

## 2. 作業手順（WBS）

### 2.1 バックエンド
1) **モデル/スキーマ**
   - [x] `questionnaires`（テンプレメタ + items[]）
   - [x] `sessions`（進行状態・完了フラグ・timestamps）
   - [x] `session_responses`（全回答・追加質問の履歴）
   - [x] 問診項目に対象性別を追加し、テンプレート取得時にフィルタできるようにした（未設定時は男女ともに表示）
2) **サービス**
   - [x] `SessionFSM`：`step("answer")`、`_finalize_item`、attempt/turn/questions 上限管理
   - [x] `LLMGateway`：`generate_question`、`decide_or_ask`、`summarize`（タイムアウト/再試行）
   - [x] `Validator`：必須・型・範囲のみ
   - [x] `StructuredContextManager`：`update_structured_context`
3) **API**
   - [x] `POST /sessions`（患者名・生年月日・visitType・questionnaireId）
   - [x] `POST /sessions/{id}/answers`（ベース問診保存）
  - [x] `POST /sessions/{id}/llm-questions`（不足の抽出）
   - [x] `POST /sessions/{id}/llm-answers`（追加質問への回答の保存）
   - [x] `POST /sessions/{id}/finalize`（要約生成と確定）
   - [x] 管理系：`GET/POST /questionnaires`, `GET /questionnaires/{id}/template`, `DELETE /questionnaires/{id}`
   - [x] 管理系（サマリープロンプト）：`GET /questionnaires/{id}/summary-prompt?visit_type=...`, `POST /questionnaires/{id}/summary-prompt`
4) **観測性**
   - [x] /readyz, /health, /metrics（簡易）

### 2.2 フロントエンド
1) **共通**
   - [x] ルーティング骨格、ヘッダー/フッター（注意文常時表示）
   - [x] 管理画面ルートではヘッダー右上ボタンを「戻る」に切替（元の画面へ戻れるよう改善）
2) **患者向け**
   - [x] `/`：氏名・生年月日＋受診種別の入力（選択後にセッション作成→`/questionnaire` へ）
   - [x] `/questionnaire`：テンプレに基づくフォーム（軽量条件表示、ドラフト保存）
   - [x] 性別に応じた問診項目の出し分け
   - [x] `/questions`：LLM追加質問（モーダル or カード列）と進行インジケータ
   - [x] `/done`：完了メッセージと要約（印刷/コピー任意）
3) **管理向け**
   - [x] `/admin/login`：管理者ログイン
   - [ ] `/admin`：ダッシュボード（廃止）
 - [x] `/admin/templates`：一覧/新規/編集/複製/削除
  - [x] `/admin/templates/:id`：項目ごとに初診/再診の使用可否や対象性別を設定する表とプレビュー
  - [x] `/admin/sessions`：問診結果の一覧
  - [x] `/admin/sessions/:id`：質問と回答の詳細表示
  - [x] `/admin/llm`：接続設定（エンドポイント/モデル/上限N/ターン/タイムアウト）と保存時の自動疎通テスト
4) **状態管理/永続化**
 - [x] sessionStorageドラフト、画面遷移ガード
  - [x] 再試行キュー（ネットワークエラー時に未送信の回答をsessionStorageに蓄積し再送）

---

## 3. フロント—バックエンド I/F（契約）
- `GET /questionnaires?visitType=initial|followup` → `QuestionItem[]`
- `POST /sessions` → `{ sessionId }`
- `POST /sessions/:id/answers` → `{ ok }`
- `POST /sessions/:id/llm-questions` → `LlmQuestion[]`
- `POST /sessions/:id/llm-answers` → `{ ok, remaining }`
- `POST /sessions/:id/finalize` → `{ summaryText, allAnswers, finalizedAt, status }`
- 管理系：`GET /questionnaires`, `POST /questionnaires`, `DELETE /questionnaires/{id}`, `POST /questionnaires/{id}/duplicate`, `GET/PUT /admin/llm`, `POST /admin/login`
- 管理系結果閲覧：`GET /admin/sessions`, `GET /admin/sessions/{id}`

> API 名称は最終的にバックエンド設計に合わせて微調整して良い。

---

## 4. 画面/ルーティング仕様（要点）
- **ヘッダー**：左ロゴ、右上「管理画面」ボタン（常時）。
- **フッター**：`本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。`
- **Entry**：氏名（必須）・生年月日（必須、過去日付のみ）
- **管理ログイン**：/admin/login でID/メール + パスワード。成功で /admin/templates へ。
- **管理**：テンプレCRUD、LLM接続設定（テストボタン）。

---

## 5. バリデーション / エラー（最小）
- 必須：未入力はフィールド直下にエラー。
- 型/範囲：数値/日付の基本チェックのみ。
- API失敗：トースト表示＋再試行ボタン。LLM応答なし時は追加質問ステップをスキップ。

---

## 6. データ保存 / 状態
- `session`：id、questionnaireId、visitType、進捗、作成/更新、完了フラグ。
- `collected_data`：ベース問診 `{項目ID: 値}` と追加質問 `[{id, text, answer, ts}]`。
- `SessionResponse`：表示文・回答の履歴。

---

## 7. テスト手順
- **ユニット**：`LLMGateway`（モック）、`Validator.is_complete`、`SessionFSM`。
- **結合/E2E**：初診/再診テンプレで入力→追加質問→確定。
- **UI**：モバイル操作、未入力・型エラー、ネット断（ドラフト復帰）。
- 実行例：
  - バックエンド：`cd backend && pytest`（`pytest-asyncio` が必要な場合は追加）
  - フロント：E2E は Playwright/Cypress いずれかで用意

---

## 8. リリース手順
1) DBマイグレーション（テンプレ・セッション関連）
2) 管理画面で `llm_settings` と初診/再診テンプレ投入

---

## 変更履歴（運用メモ）
- [fix] 管理画面テンプレ設定のLLM有効判定を調整（疎通OKのみで有効化）。
  - これまで base_url が未設定だと UI のトグルが無効化されていたが、スタブ（ローカル）運用では base_url なしでも `/llm/settings/test` が OK を返すため、UI 側の可否判定を疎通テスト結果のみに変更。
  - 対象: `frontend/src/pages/AdminTemplates.tsx` の `llmAvailable` 判定。
3) ステージングでUAT→本番ロールアウト

---

## 9. 受け入れ基準（抜粋）
- ベース問診のみでもセッションを完了できる
- 追加質問は上限N件を超えない / 項目ごとの再質問は最大3回
- 完了画面では回答一覧の編集は行わない
- スタッフ向け要約が生成され、印刷/EMR貼付に足る簡潔さ
- UI上に **「ローカルLLM利用・外部送信なし」** が恒常表示

---

## 10. 運用メモ（最小）
- LLM障害時は追加質問フェーズを自動スキップ（ベース問診で完了）
- テンプレ変更はドラフト→公開で反映。公開中のセッションには影響しない（新規のみ）

---

## 11. UIデザイン改修（医療問診向け）チェックリスト
> 詳細方針は `docs/UI_Redesign_Plan.md` を参照。plannedSystem.md と整合。

- [ ] デザイン原則と情報設計の合意（患者/管理フロー）
- [x] デザイントークン定義（色・タイポ・間隔・ブレークポイント）
- [x] カラーパレット AA コントラスト検証（主要画面）
- [x] タイポグラフィ設定（日本語/英数字/等幅数字）
- [ ] コンポーネント実装（Button/Input/Radio/Checkbox/Select/DatePicker）
- [x] 進行表示（Stepper/Progress）、通知（Alert/Toast）、確認（Modal）
- [x] フォームUX（バリデーション、エラー表示、入力補助）
- [ ] レイアウト/レスポンシブ最適化（iPad/1080p/デスクトップ）
- [x] アクセシビリティ対応（フォーカス・aria・キーボード操作）
- [x] フッター安心表示の統一（ローカルLLM/外部送信なし）
- [x] 印刷スタイル（医師向け要約の体裁）
- [x] UIイベント計測（匿名メトリクス、離脱/滞留）
- [ ] 受け入れテスト（看護/事務レビュー、UAT 合格）

---

## 12. バグ修正履歴（フロントエンド）
- [x] Entry.tsx の重複 import を解消（`useState` が二重宣言）。ビルド時の `Identifier 'useState' has already been declared` エラーを修正。（2025-08-20）
- [x] 管理画面の問診結果詳細で受診種別が英語表記となる問題を修正し「初診/再診」と表示。テンプレート管理画面の項目タイプ「YES/NO」も「はい/いいえ」に変更し、削除ボタンの aria-label を日本語化。（2025-08-22）
- [x] 問診結果詳細のサマリー表示に改行を挿入し、各項目が見やすくなるよう改善。（2025-08-22）
- [x] 管理画面のパスワードリセットで、ローディングダイアログと二段階認証コード入力が高速で切り替わり操作不能になる不具合を修正。原因は `AuthContext` の `checkAuthStatus` が毎レンダで再生成され、依存している画面の `useEffect` が連続発火していたこと。`useCallback` により参照を安定化し、`App.tsx` の全画面ローディングとの競合を解消。（2025-08-27）
- [x] `checkAuthStatus` にローディング抑制フラグを追加し、パスワードリセット画面などで無限リクエストが再発しないよう修正。コンテキスト更新時の全画面ローディングを回避。（2025-08-29）

---

## 13. 管理画面ナビゲーション改善（2025-08-22）
- [x] 管理画面に左サイドバー（`AdminLayout`）を追加し、テンプレート/問診結果/LLM設定へワンクリック移動を実装。
- [x] 右上ヘッダーボタンの文言を「戻る」→「問診画面に戻る」に変更（`App.tsx`）。

## 14. ダッシュボード廃止（2025-08-30）
- [x] `/admin` を廃止し `/admin/templates` へリダイレクト。
- [x] ログイン後の遷移先を `/admin/templates` に変更。

## 15. テンプレート管理UIの可読性改善（2025-08-22）
- [x] テンプレート管理画面の表を `TableContainer` でラップし、横スクロールを許可。
- [x] 問診内容・入力方法・選択肢の各列に最小幅を設定し、`tableLayout="fixed"` と `minWidth` により内容が見切れないよう調整。
- [x] 既存テンプレート一覧テーブルにも `minWidth` を設定し、小画面での可視性を改善。

## 16. テンプレート管理UIのカード表示（レスポンシブ）（2025-08-22）
- [x] 画面幅 `lg` 未満では、問診項目一覧をカード形式で表示（`Card`/`CardHeader`/`CardBody`）。
- [x] カード上段に「問診内容」、中段に「入力方法＋削除ボタン」、下段に「選択肢（multi時のみ）」と「必須/初診/再診」のチェックを配置。
- [x] `useBreakpointValue({ base: true, lg: false })` でカード/テーブルを自動切替。`lg` 以上の画面では従来の表（幅改善版）を保持。

## 17. テンプレ項目一覧の常時カード化（2025-08-22）
- [x] レスポンシブ切替を廃止し、常にカード表示へ統一（一覧性より可読性を優先）。
- [x] 不要となったテーブル版UIと関連インポートを整理（既存テンプレ一覧テーブルは維持）。

## 18. テンプレ一覧の表記とプレビューの挙動変更（2025-08-22）
- [x] 見出し「既存テンプレート一覧」→「保存済みテンプレート一覧」に改称。
- [x] テーブル列名「ID」→「テンプレート名」に変更。`default` の表示は「デフォルト」に置換。
- [x] 画面下部の常設プレビューを廃止し、「プレビュー」ボタンからモーダル表示に変更。
- [x] プレースホルダー「新しいテンプレートのID」→「新しいテンプレート名」に変更。
- [x] 問診結果一覧は行クリックで詳細（問診内容）をモーダル表示するよう変更（画面遷移を置換）。

## 19. 複数選択項目の自由記述対応（2025-08-22）
- [x] 管理画面で複数選択項目に「自由記述を許可」設定を追加。
- [x] 設定有効時、患者画面とプレビューで自由入力欄を表示し回答に含める。
- [x] バリデーションで選択肢外の文字列を許可。

## 20. デフォルト問診項目の拡充（2025-08-22）
- [x] 初診テンプレートに氏名・生年月日・性別・住所などの基本情報と症状関連項目を追加。
- [x] 再診テンプレートを主訴・症状部位・発症時期に限定した内容で初期化。

## 21. Windows 向け一括起動スクリプト追加（2025-09-27）
- [x] PowerShell スクリプト `dev.ps1` を追加し、バックエンドとフロントエンドを同時起動できるようにした。
- [x] README に `dev.ps1` の使い方を追記。

## 22. LLM フォローアップ質問のテンプレート設定（2025-10-30）
- [x] 固定フォーム終了後に LLM による追加質問を行うかどうかをテンプレートで設定可能にした。
- [x] 設定値は DB に保存され、セッション作成時に反映される。
- [x] LLM 設定が無効または疎通テストに失敗している場合は、管理画面で追質問の設定をオンにできないようにした。

## 23. LLM フォローアップ判定待機画面の追加（2025-10-31）
 - [x] 固定フォーム回答後、追質問の有無を判定する間に待機画面を表示するようにした。
 - [x] 判定結果に応じて追加質問画面または完了画面へ自動遷移する。

## 24. 管理/チャット画面の左右余白を削減（2025-08-23）
- [x] 管理画面のコンテナを全幅化し、左右パディングを縮小。
  - 変更: `frontend/src/App.tsx`（`isAdminPage` 時の `Container` を `maxW="100%"`, `px={2}`）
  - 変更: `frontend/src/components/AdminLayout.tsx`（`gap` を `6→4`、ナビ幅を `180/220px→160/200px`、全体に `px` 追加）
- [x] チャット画面の内側パディングを縮小。
  - 変更: `frontend/src/pages/LLMChat.tsx`（`p={4}` を `px={{ base: 2, md: 3 }}` に変更。入力バーも同様）
- [x] 回帰確認としてバックエンド `pytest` 実行（23 passed, warnings のみ）。

## 25. 管理テンプレ画面の初期ロード時の自動保存抑止（2025-08-23）
- [x] 初回ロード/テンプレ切替直後に保存UIが動作せず、実保存もしないよう制御。
  - 変更: `frontend/src/pages/AdminTemplates.tsx` に `isDirtyRef` を追加し、ユーザー操作時のみ自動保存を起動。
  - ユーザー操作（項目追加・編集・削除、プロンプト/フラグ変更）時に `markDirty()` を呼ぶようイベントハンドラを調整。
  - ロード完了時/保存完了時に dirty をリセット。

## 26. LLM 設定が保存されない問題の修正（2025-08-23）
- [x] 取得APIをDB優先に変更し、保存後の再取得でUIへ反映。
  - 変更: `backend/app/main.py` の `GET /llm/settings` は DB を読み、あればメモリへ反映して返す。
  - 変更: `frontend/src/pages/AdminLlm.tsx` は `PUT` 後に `GET /llm/settings` を再実行して設定を再描画。

## 27. デフォルトテンプレートから氏名・生年月日を削除（2025-08-23）
- [x] 初診・再診の「デフォルト問診項目」から `name`/`dob` を除外（それらはセッション作成時に別途入力）
  - 変更: `backend/app/main.py` の `on_startup()` 内 `initial_items` から `name`/`dob` を削除。
  - テスト更新: `backend/tests/test_api.py` の既定項目アサーションから `name`/`dob` を除外。

## 28. 管理ログアウトフローの簡素化（2025-08-23）
- [x] 管理画面の「ログアウト」ボタンを削除。
- [x] 管理ルート以外へ遷移したタイミングで自動ログアウト（`sessionStorage.adminLoggedIn` を削除）。
  - 変更: `frontend/src/components/AdminLayout.tsx`（ログアウトボタン削除）
  - 変更: `frontend/src/App.tsx`（非管理ルート遷移で自動ログアウト＋「問診画面に戻る」クリック時にも明示削除）

## 29. 管理ナビをスクロール固定（sticky）に変更（2025-08-23）
- [x] 左側メニューを `position: sticky; top: 0` とし、常にウィンドウ内に表示。
  - 変更: `frontend/src/components/AdminLayout.tsx`（`position="sticky"`, `top={0}`, `maxH="100vh"`, `overflowY="auto"` をナビに付与）
  - 変更: `frontend/src/App.tsx`（管理ルートでは `overflowY` を親ボックスで作らず、ウィンドウスクロールに切替）

## 30. 管理画面からフッター注意文を非表示（2025-08-23）
- [x] 管理画面では「本システムはローカルLLMを使用しており…」の注意文を非表示。
  - 変更: `frontend/src/App.tsx` のフッター表示条件を `!isChatPage && !isAdminPage` に変更。

## 31. 管理ログインをモーダル化（2025-08-23）
- [x] 患者画面から管理画面へ遷移する際、画面内モーダルでパスワード入力。
  - 変更: `frontend/src/App.tsx` にログイン用モーダルを実装。ヘッダーの「管理画面」クリックでモーダルを開き、成功後に `/admin/templates` へ遷移。
  - 直接URLでのアクセス時は従来通り `/admin/login` へ誘導（ガード継続）。

## 33. LLM 追加質問の質問文と回答ペアの永続化（2025-08-27）
- [x] DB スキーマ拡張：`session_responses` に `question_text` 列を追加し、LLM 生成の追加質問に限り提示した質問文を保存。
- [x] 保存ロジック：`SessionFSM` が `pending_llm_questions` 生成時に `session.llm_question_texts` にマッピングを保持し、`save_session` が `llm_*` 回答と紐付けて保存するよう変更。
- [x] 取得ロジック：`db.get_session` で `llm_question_texts` を復元し、管理詳細 `GET /admin/sessions/{id}` のレスポンスに含める。
- [x] ドキュメント更新：`docs/session_api.md` に保存仕様とレスポンス項目を追記。

## 32. アプリのロゴ文言を変更（2025-08-23）
- [x] ロゴ表示を「MonshinMate」→「問診メイト」に変更。
  - 変更: `frontend/src/App.tsx` のヘッダーロゴ文言。
  - 変更: `frontend/index.html` の `<title>`。

## 33. システム表示名の設定機能（2025-08-23）
- [x] 管理画面から「システム表示名」を編集可能にし、患者画面のヘッダーに反映（管理画面のヘッダーは固定文言「管理画面」とし設定の影響を受けない）。
  - 変更（バックエンド）: `backend/app/db.py` に `app_settings` テーブルと `save_app_settings` / `load_app_settings` を追加。
  - 変更（バックエンド）: `backend/app/main.py` に `GET/PUT /system/display-name` を追加（既定値は「Monshinクリニック」）。
  - 変更（フロント）: `frontend/src/pages/AdminSystemName.tsx` を追加（入力+保存UI）。
  - 変更（フロント）: `frontend/src/components/AdminLayout.tsx` のメニューに「システム表示名」を追加。
  - 変更（フロント）: `frontend/src/App.tsx` で表示名を取得・購読し、患者画面のヘッダーに表示。設定保存時はカスタムイベントで即時反映。
  - 変更（開発プロキシ）: `frontend/vite.config.ts` に `/system` を追加し、開発時のAPI疎通404を解消。

## 34. フッターに小さく「問診メイト」を表示（2025-08-23）
- [x] 管理画面含め、フッター左に小さくブランド名「問診メイト」を表示。患者画面のみ従来の注意文も併記。
  - 変更: `frontend/src/App.tsx` フッター構造を調整（`Text fontSize="xs"` で表示）。

## 35. 管理画面に使い方ページを追加（2025-10-31）
- [x] 管理メニューに「使い方」を追加し、基本的な利用方法を画面上で確認できるようにした。

## 36. 管理画面セットアップ手順書の追加（2025-11-01）
- [x] 管理画面でのシステム全体のセットアップ方法を説明するドキュメント `docs/admin_system_setup.md` を追加。
- [x] 管理メニューの「使い方」ページが `docs/admin_system_setup.md` を参照するように変更。

## 37. 初回アクセス時のパスワード設定UI（2025-11-02）
- [x] 管理パスワードが初期値のままの場合、ログイン前に新規パスワード設定モーダルを表示するようにした。
- [x] フロント: `frontend/src/App.tsx` に初回パスワード設定ロジックとUIを追加。
- [x] バックエンド: `GET /admin/password/status` と `POST /admin/password` を追加し、DB にパスワードを保存するよう変更。

## 38. チャット画面での初期パスワード強制と TOTP 対応（2025-11-02）
- [x] 患者との対話画面（`/chat`）アクセス時、管理パスワードが初期設定のままなら全画面でパスワード設定モーダルを強制表示（`frontend/src/App.tsx`）。
- [x] パスワード設定直後に Google Authenticator による TOTP 秘密鍵作成を推奨（QR 表示→6桁コード入力→有効化）。
- [x] 管理ログイン：TOTP 必須時の二段階目認証UIを追加（`/admin/login`→`/admin/login/totp`）。
- [x] 「パスワードをお忘れですか？」から TOTP を用いたリセット（トークン発行→新PW確定）を実装。
- [x] 参照エンドポイントを `/admin/auth/status` に統一（旧 `/admin/password/status` は廃止）。

## 39. パスワード設定後の Authenticator 有効化確認（2025-11-02）
- [x] パスワードの設定または変更直後に、Authenticator を有効にするかどうか確認するダイアログを追加。
- [x] Authenticator を有効化しない場合はパスワードのリセットができない旨を警告。

## 40. 管理/患者ヘッダーでの LLM 接続状態表示（2025-11-03）
- [x] 管理画面ヘッダーの「問診画面に戻る」ボタンの左側に小さなバッジで LLM 接続状態を表示（接続OK=緑、エラー=赤、無効=灰）。
- [x] 患者側ヘッダーでも「管理画面」ボタンの左側に同バッジを表示。
- [x] 疎通チェックは「患者氏名等の初期入力画面（Entry）」に戻ったときのみ実施し、結果は `llmStatusUpdated` イベントで各画面へ伝播（不要な頻度の疎通を抑制）。
- [x] 実装: `frontend/src/utils/llmStatus.ts` 追加、`Entry.tsx` で `refreshLlmStatus()` を発火、`LlmStatusBadge`/`AdminLayout`/`AdminTemplates` はイベント購読に統一。

## 41. LLM通信エラー時の自動フォールバック（2025-11-03）
- [x] サマリ作成や追加質問生成で LLM 通信に失敗した場合、LLM を使わない処理へ自動的に切り替えるようにした。
- [x] 追加質問生成中に通信エラーが発生した場合は追質問ステップをスキップする。

## 42. 管理者用オフラインリセットスクリプトの整備（2025-08-24）
- [x] `backend/tools/reset_admin_password.py` を改修し、以下を確実に実施するよう統一:
  - [x] 管理者パスワードの上書き（bcryptでハッシュ保存）
  - [x] `is_initial_password=1` の設定
  - [x] 二段階認証の完全無効化（`is_totp_enabled=0`, `totp_mode='off'`, `totp_secret=NULL`）
  - [x] 既存DBに不足するカラム（`is_initial_password`, `totp_mode`）を自動追加（存在時は無視）
  - [x] 管理者が存在しない場合の自動作成
- [x] 運用ドキュメント（`docs/admin_system_setup.md`）にオフライン復旧手順を追記。

## 43. 監査ログ整備と確認手段（2025-08-24）
- [x] `security` ロガーでの主要イベント出力（`backend/app/logs/security.log`、ローテーションあり）
- [x] `audit_logs` テーブルと SQLite トリガで、`users` テーブルの重要列更新時に自動記録
- [x] パスワード更新・TOTP 状態/モード変更・初期admin作成・強制リセットを監査対象に追加
- [x] 監査ダンプツール `backend/tools/audit_dump.py` を追加（直近N件の表示）
- [x] 手順は `docs/admin_system_setup.md` に記載（開発向け）

## 44. デフォルトテンプレのフリー入力の一部を「選択肢＋自由記述」に変更（2025-08-24）
- [x] デフォルトテンプレート（初診・再診）のうち、適切な自由記述項目を複数選択＋自由記述に差し替え（主訴は自由記述のまま）。
  - 変更: `prior_treatments` を複数選択（なし/外用薬/内服薬/注射/手術/リハビリ/その他＋自由入力）。
  - 変更: `past_diseases` を複数選択（なし/高血圧/糖尿病/脂質異常症/喘息/アトピー性皮膚炎/花粉症/蕁麻疹/その他＋自由入力）。
  - 変更: `surgeries` を複数選択（なし/皮膚科関連手術/整形外科手術/腹部手術/心臓手術/その他＋自由入力）。
  - 変更: `current_medications` を複数選択（なし/ステロイド外用/抗菌薬/抗ヒスタミン薬/NSAIDs/免疫抑制薬/その他＋自由入力）。
  - 変更: `supplements_otc` を複数選択（なし/ビタミン剤/漢方/鎮痛解熱薬/かゆみ止め/保湿剤/その他＋自由入力）。
  - 変更: `drug_allergies` を複数選択（なし/ペニシリン系/セフェム系/マクロライド系/ニューキノロン系/NSAIDs/局所麻酔/その他/不明＋自由入力）。
  - 変更: `food_metal_allergies` を複数選択（なし/卵/乳/小麦/そば/落花生/えび/かに/金属（ニッケル等）/その他/不明＋自由入力）。
  - 備考: 郵便番号/住所/電話番号は引き続き自由記述のまま。
  - 実装: `backend/app/main.py` の `on_startup()` で投入する既定テンプレの項目定義を更新。

## 45. 問診テンプレ編集画面の「問診項目を追加」ボタンを一覧下部へ移動（2025-11-03）
- [x] 「問診項目を追加」ボタンを項目一覧表の直下に配置し、最終行の下から新規項目を追加しやすくした。
  - 変更: `frontend/src/pages/AdminTemplates.tsx` のボタン位置と文言を調整。
  - ドキュメント更新: `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`。

## 46. TOTPシークレット欠如時の自動無効化（2025-11-04）
- [x] シークレットが存在しないのに `is_totp_enabled=1` の場合、ログイン時に自動的に二段階認証を無効化するようにした。
  - 変更: `backend/app/db.py` の `get_totp_mode` はシークレット未設定時に常に `'off'` を返すよう修正。
  - 変更: `backend/app/main.py` の `admin_login` で不整合状態を検知し `set_totp_status` により無効化。
  - テスト: `backend/tests/test_admin.py` に再現テストを追加。
  - ドキュメント更新: `docs/admin_system_setup.md` に自動無効化の注意書きを追加。

## 47. 二段階認証無効時のパスワードリセット案内（2025-11-05）
- [x] TOTP が無効の状態でパスワードリセットページにアクセスすると、二段階認証入力ではなくシステム初期化スクリプトの実行を案内するメッセージを表示。
  - 変更: `frontend/src/pages/AdminPasswordReset.tsx`
  - 変更: `frontend/src/pages/AdminLogin.tsx`
  - ドキュメント更新: `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`

## 48. オフラインリセットスクリプトでのユーザーテーブル列保証（2025-11-06）
- [x] `backend/tools/reset_admin_password.py` の `ensure_users_table` が `password_updated_at` と `totp_changed_at` カラムを既存DBに追加するよう修正。
- [x] ドキュメント更新: `docs/admin_system_setup.md`

## 49. TOTPシークレット暗号化（2025-08-24）
- [x] 共通キーによる暗号化を導入し、`update_totp_secret` で暗号化保存。
- [x] `get_user_by_username` で復号処理を追加。
- [x] 既存レコード暗号化スクリプト `backend/tools/encrypt_totp_secrets.py` を追加。
- [x] ドキュメント更新: `docs/admin_system_setup.md`.
- [x] テスト: `backend/tests/test_admin.py` で暗号化後の動作を確認。

## 50. 管理者パスワード初期化処理の安全性向上（2025-11-07）
- [x] 旧 `app_settings.admin_password` を起動時に無視し削除するよう変更。
- [x] `POST /admin/password` は現パスワードが環境既定値と一致する場合のみ受け付けるよう修正。
- [x] テスト: `backend/tests/test_admin.py` にレガシー設定無視とフラグ不整合時の拒否を追加。
- [x] ドキュメント更新: `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`。

## 51. 問診結果一覧の検索機能追加（2025-11-08）
- [x] 管理画面の問診結果一覧で患者名・生年月日・問診日範囲による検索を可能にした。
- [x] 変更（バックエンド）: `/admin/sessions` に検索用クエリパラメータを追加し、DBアクセス関数を拡張。
- [x] 変更（フロント）: `frontend/src/pages/AdminSessions.tsx` に検索フォームを追加。
- [x] ドキュメント更新: `docs/session_api.md`, `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`。

## 52. 空欄回答の「該当なし」保存（2025-11-09）
- [x] 空欄で送信された回答を「該当なし」として保存するように変更。
  - 変更（バックエンド）: `backend/app/structured_context.py` に回答正規化ロジックを追加。
  - 変更（バックエンド）: `backend/app/main.py` でセッション作成時にも正規化を適用。
  - テスト: `backend/tests/test_api.py` に空欄回答保存の確認テストを追加。
  - ドキュメント更新: `docs/session_api.md`。

## 53. 追加質問プロンプトのアドバンスト編集機能（2025-11-10）
- [x] 管理画面テンプレート設定にアドバンストモードを追加し、追加質問プロンプトを編集可能にした。
- [x] プロンプトは `{max_questions}` プレースホルダを含み、LLMはJSON配列で質問を返す仕様を説明。
- [x] 初期値に戻すボタンを設置し、既存テンプレートにはデフォルトプロンプトを適用済み。
- [x] エンドポイント追加: `GET/POST /questionnaires/{id}/followup-prompt`。
- [x] テスト: `backend/tests/test_api.py` に設定反映の確認テストを追加。

## 54. サマリー自動作成設定のプロンプト位置調整（2025-11-11）
- [x] 管理画面テンプレート設定で、初診・再診それぞれのサマリープロンプト編集欄が該当チェックボックスの直下に表示されるよう改善。

## 55. サマリー生成の有効設定反映（2025-11-12）
- [x] サマリー作成モードが無効な場合は `POST /sessions/{id}/finalize` が空文字の要約を返すよう修正。
- [x] サマリー作成モード有効時の要約生成を確認するテストを追加。
- [x] ドキュメント更新: `docs/session_api.md`。

## 56. 追加質問判定時のフェッチエラー処理改善（2025-11-13）
- [x] LLM 追質問の要否判定および質問取得の際、HTTP エラーやネットワーク例外が発生した場合にレビュー画面へフォールバックするようにした。
- [x] 変更: `frontend/src/pages/LlmWait.tsx`, `frontend/src/pages/Questions.tsx`。

## 57. テーマカラー設定機能（2025-11-14）
- [x] 管理画面でUIのテーマカラーを変更できるようにし、パステルカラー10種のサンプルと任意のカラーコード入力に対応。
- [x] 変更（バックエンド）: `backend/app/main.py` に `GET/PUT /system/theme-color` を追加。
- [x] 変更（フロント）: `frontend/src/contexts/ThemeColorContext.tsx`, `frontend/src/theme/index.ts`, `frontend/src/pages/AdminTheme.tsx`, `frontend/src/components/AdminLayout.tsx`, `frontend/src/main.tsx`, `frontend/src/App.tsx`。
- [x] ドキュメント更新: `docs/admin_system_setup.md`。

## 58. 管理ログイン失敗時のメッセージ簡略化（2025-11-15）
- [x] 管理画面へのログインでパスワードが誤っている場合の応答を「パスワードが間違っています」に変更。
- [x] 不要なパスワードリセット案内をログイン画面から削除。
- [x] 変更: `backend/app/main.py`, `frontend/src/pages/AdminLogin.tsx`。
- [x] テスト更新: `backend/tests/test_admin.py`。
- [x] ドキュメント更新: `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`。

## 59. 管理ログインを画面内モーダル化（2025-11-16）
- [x] 患者画面の「管理画面」ボタン押下時に、別ウィンドウではなくモーダルでログインフォームを表示し、成功後に `/admin/templates` へ遷移。
- [x] 変更: `frontend/src/App.tsx`。
- [x] ドキュメント更新: `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`。

## 60. 二段階認証画面を同モーダル内に表示（2025-11-16）
- [x] パスワード送信後の二段階認証コード入力も同じモーダル内で行えるようにした。
- [x] 変更: `frontend/src/pages/AdminLogin.tsx`。
- [x] ドキュメント更新: `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`。

## 61. 問診完了後の確認画面を廃止（2025-11-17）
- [x] Review 画面を削除し、質問終了後は直接完了画面へ遷移するよう変更。
- [x] フロントエンドおよびドキュメントを更新。

## 62. LLM通信失敗時のエラーモーダル表示（2025-11-18）
- [x] LLMとの通信エラー内容を画面上部のモーダルで表示しつつ既存のフォールバックを継続するよう変更。
- [x] 変更: `frontend/src/components/TopErrorModal.tsx`, `frontend/src/pages/LlmWait.tsx`, `frontend/src/pages/Questions.tsx`, `frontend/src/pages/Done.tsx`。

## 63. LLM通信エラー情報の自動表示とサマリー追記（2025-11-19）
- [x] エラーモーダルは10秒後に自動的に閉じるようにし、ユーザー操作が不要に。
- [x] LLM通信エラー内容をサマリー末尾に追記し、問診結果DBから参照できるようにした。
- [x] 変更: `frontend/src/components/TopErrorModal.tsx`, `frontend/src/pages/LlmWait.tsx`, `frontend/src/pages/Questions.tsx`, `backend/app/main.py`。

## 64. セキュリティタブに「二段階認証を有効化」ボタンを追加（2025-08-27）
- [x] 管理画面のセキュリティタブで、未有効時に明示的な「二段階認証を有効化する」ボタンを表示。
- [x] ボタン直下に「パスワードをリセットするには二段階認証の有効化が必要であり推奨する」旨のメッセージを表示。
- [x] 二段階認証が有効になって初めて「QRコードを表示」ボタンや「パスワードをリセット」ボタンが表示されるよう条件分岐を整理。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSecurity.tsx`。

## 65. セッション開始時の旧データ初期化と自動入力抑止（2025-11-20）
- [x] Entry ページ表示時に旧セッション情報を `sessionStorage` から削除し、常に新しいセッションIDで問診を開始できるようにした。
- [x] 患者向け入力フォームの `autoComplete` を `off` に設定し、ブラウザの自動入力によるデータ混同を防止。
- 変更: `frontend/src/pages/Entry.tsx`, `frontend/src/pages/QuestionnaireForm.tsx`, `frontend/src/pages/Questions.tsx`, `frontend/src/components/DateSelect.tsx`。

## 66. TOTP有効化タイミングの修正（2025-11-21）
- [x] `set_totp_mode` で `is_totp_enabled` を自動的に更新しないようにし、QRコード発行後にコードを検証して初めて有効化されるよう変更。
- [x] モード変更のみでは有効化されないことを確認するテストを追加。
- [x] 変更: `backend/app/db.py`, `backend/tests/test_admin.py`, `docs/admin_system_setup.md`。

## 67. 二段階認証無効化時のシークレット削除（2025-11-22）
- [x] 無効化すると登録済みのTOTPシークレットを削除し、再有効化時に旧コードが利用されないようにした。
  - 変更: `backend/app/db.py`, `backend/app/main.py`
  - テスト: `backend/tests/test_admin.py`
  - ドキュメント更新: `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`

## 68. 追加質問の一括返却（2025-08-27）
- [x] LLM への問い合わせを1度だけ行い、生成された追加質問をまとめて返す `next_questions` を追加。
- [x] エンドポイント `/sessions/{id}/llm-questions` は全ての質問を一括で返却するよう変更。
- [x] ドキュメント更新: `docs/session_api.md`。
- [x] テスト更新: `backend/tests/test_api.py`。

## 69. セキュリティタブのTOTP無効化フロー見直し（2025-08-26）
- [x] 二段階認証が有効な状態では、QRコードの再表示および再設定（再生成）ボタンを非表示にした。
- [x] 「二段階認証を無効化する」実行時に画面内モーダルで6桁コードの入力を必須化。正しいコード入力時のみ無効化。
- [x] バックエンド `/admin/totp/disable` を TOTPコード必須に変更（検証ウィンドウ±1ステップ）。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSecurity.tsx`
- [x] 変更（バックエンド）: `backend/app/main.py`
- [x] テスト更新: `backend/tests/test_admin.py`

## 70. 問診項目の補足説明入力機能追加（2025-11-23）
- [x] 各問診項目に任意の補足説明を設定できるようにした。
- [x] 変更（バックエンド）: `backend/app/main.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/QuestionnaireForm.tsx`, `frontend/src/pages/AdminTemplates.tsx`
- [x] テスト追加: `backend/tests/test_api.py`
- [x] ドキュメント更新: `docs/session_api.md`, `docs/plannedSystem.md`, `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`

## 71. 管理画面からのパスワード変更とTOTP無効化（2025-11-24）
- [x] セキュリティ画面に現在のパスワードを入力して更新するモーダルを追加。
- [x] パスワード変更時に二段階認証を自動的に無効化するようにした。
- [x] 変更（バックエンド）: `backend/app/main.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSecurity.tsx`
- [x] テスト追加: `backend/tests/test_admin.py`
- [x] ドキュメント更新: `docs/session_api.md`, `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`

## 72. LLM追質問のセッションストレージ再利用（2025-11-25）
- [x] `LlmWait` で取得した追加質問を `pending_llm_questions` として保存し、`Questions` ページで再利用するようにした。
- [x] 質問を消費した際は `pending_llm_questions` を更新し、空になった場合のみ `/llm-questions` を再呼び出すよう変更。
- [x] ドキュメント更新: `docs/session_api.md`。

## 73. 複数選択項目の自由記述チェックボックス追加（2025-12-06）
- [x] 複数選択肢で自由入力を行う際、専用チェックボックスを新設し、チェック時のみテキスト入力欄が有効化されるよう変更。
- [x] 変更（フロントエンド）: `frontend/src/pages/QuestionnaireForm.tsx`
- [x] ドキュメント更新: `docs/PlannedDesign.md`

## 74. プロンプト文言の改良（2025-12-07）
- [x] 追加質問とサマリー生成の既定プロンプトを医療向けに詳細化。
- [x] LLM 設定のシステムプロンプトに医療問診支援向け文言を追加。
- [x] 変更（バックエンド）: `backend/app/llm_gateway.py`, `backend/app/main.py`, `backend/tests/test_api.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx`
- [x] ドキュメント更新: `docs/LLMcommunication.md`, `docs/session_api.md`, `docs/implementation.md`

## 75. デフォルトテンプレートの性別関連項目整理（2025-12-08）
- [x] 初診デフォルトテンプレートから性別質問を削除し、重複入力を解消。
- [x] 妊娠・授乳の質問に対象性別を設定し、女性のみ表示されるよう変更。
- [x] 喫煙・飲酒の質問に自由記述欄を追加し、選択肢以外の回答を許容。
- [x] 変更（バックエンド）: `backend/app/main.py`, `backend/build/lib/app/main.py`
- [x] テスト更新: `backend/tests/test_api.py`
- [x] ドキュメント更新: `docs/implementation.md`

## 76. ラッパーGUI録音エラーの修正（2025-12-09）
- [x] 例外変数がガーベジコレクトされてしまいエラーメッセージが表示できなかった不具合を修正。
- [x] 変更: `wrapper/app/gui.py`
