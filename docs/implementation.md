# 実装手順書（Minimal 版 / v1）

> 重要な注意（更新）：既定ではローカルLLMのみを使用しますが、管理画面の設定で任意に「リモートの Ollama / LM Studio サーバー」を指定可能です。リモート設定を有効にした場合は当該サーバーへプロンプト・入力が送信されます。院内運用ポリシーに従い、必要な場合のみ有効化してください。フッターの注意書きは「既定はローカル運用で外部送信なし。リモートを有効にした場合は送信あり」に読み替えてください。

本書は、これまで合意した **「実装計画書（Minimal 版）」** と **「フロントエンドUI構築設計書」** に整合する形で、段取り（マイルストーン・WBS）と実施手順を示します。禁忌/赤旗・辞書正規化・緊急分岐・同意画面・重複照合/ID発行・ハードガード追質問はスコープ外です。

---

## 0. 目的 / スコープ
- 目的：
  - 患者名・生年月日の入力 → 初診/再診分岐 → テンプレートに基づくベース問診 → LLMによる最小追加質問 → 最終確認 → 完了、までを **細い導線** で実装する。
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
  - [x] 項目ごとの再質問は最大3回、セッション合計の上限Nは設定で制御

### MS4：要約と保存
- 目的：全回答の一覧確認→確定→保存/要約出力
- **完了条件**
  - [x] `/review` で全回答を一望しインライン編集可能
  - [x] `POST /sessions/{id}/finalize` が `summaryText` と `allAnswers` を返す
  - [x] 完了ステータスとタイムスタンプ保存
  - [x] LLM 設定が有効かつ疎通OKの場合、バックグラウンドでカスタムプロンプトを用いたサマリー生成を実行（UIは非ブロッキング）
  - [x] サマリープロンプトはテンプレート管理画面から「初診」「再診」それぞれ編集/保存可能

### MS5：フロント実装（患者/管理）
- 目的：UI導線と状態管理の実装
- **完了条件**
  - [x] **患者**：Entry（氏名/生年月日＋受診種別）→ Questionnaire → Questions → Review → Done
    - [x] Entry で氏名・生年月日を入力
    - [x] Entry で「当院の受診は初めてですか？」を選択（「初めて」= initial / 「受診したことがある」= followup）しセッション作成
    - [x] Questionnaire で text/multi/yesno に応じた入力フォームを表示
    - [x] Questions で追加質問を順次表示
    - [x] Review で回答一覧を表示しインライン編集後確定へ進む
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
   - [x] `/questions`：LLM追加質問（モーダル or カード列）と進行インジケータ
   - [x] `/review`：全回答の一覧・インライン編集・確定
   - [x] `/done`：完了メッセージと要約（印刷/コピー任意）
3) **管理向け**
   - [x] `/admin/login`：管理者ログイン
   - [ ] `/admin`：ダッシュボード（廃止）
 - [x] `/admin/templates`：一覧/新規/編集/複製/削除
  - [x] `/admin/templates/:id`：項目ごとに初診/再診の使用可否を設定する表とプレビュー
  - [x] `/admin/sessions`：問診結果の一覧
  - [x] `/admin/sessions/:id`：質問と回答の詳細表示
  - [x] `/admin/llm`：接続設定（エンドポイント/モデル/上限N/ターン/タイムアウト）と疎通テスト
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
- 管理系：`GET/POST /questionnaires`, `GET/PUT /questionnaires/:id`, `DELETE /questionnaires/:id`, `GET/PUT /admin/llm`, `POST /admin/login`
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
3) ステージングでUAT→本番ロールアウト

---

## 9. 受け入れ基準（抜粋）
- ベース問診のみでもセッションを完了できる
- 追加質問は上限N件を超えない / 項目ごとの再質問は最大3回
- 最終確認画面で全入力を一望し、その場編集後に確定できる
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
