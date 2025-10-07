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
  - [x] 年齢制限と性別制限を個別のチェックボックスで設定できるようUIを改修

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
  - [x] 既定テンプレートのサマリープロンプトは初診・再診ともに同一の既定文をシード（初診が空欄にならないよう修正）

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
  - [x] `provider=lm_studio` / `provider=openai` 時は OpenAI互換 `POST {base_url}/v1/chat/completions` を使用
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
   - [x] `/`：受診種別の選択（初診/再診ボタン）。選択後に基本情報入力画面へ遷移。
   - [x] `/basic-info`：氏名・生年月日・性別と（初診時のみ）患者基本情報を入力し、セッション作成後に`/questionnaire`へ遷移。
   - [x] `/questionnaire`：テンプレに基づくフォーム（軽量条件表示、ドラフト保存）
   - [x] 性別に応じた問診項目の出し分け
   - [x] `/questions`：LLM追加質問（モーダル or カード列）と進行インジケータ
   - [x] `/done`：完了メッセージと要約（印刷/コピー任意）
   - [x] 初診/再診の選択を大型ボタンで切り替え、初診フォームでは「よみがな→氏名→住所・連絡先」を一体化して入力＆回答データへ自動反映（2025-09-24）
3) **管理向け**
  - [x] `/admin/login`：管理者ログイン
  - [x] `/admin/main`：メインダッシュボード（問診最新10件〈初診/再診〉、システム情報サマリーバー＋詳細アコーディオン〈2025-09-22 改修〉）
 - [x] `/admin/templates`：一覧/新規/編集/複製/削除
  - [x] `/admin/templates/:id`：項目ごとに初診/再診の使用可否や対象性別を設定する表とプレビュー
  - [x] `/admin/sessions`：問診結果の一覧
  - [x] `/admin/sessions/:id`：質問と回答の詳細表示
  - [x] `/admin/appearance`：外観設定（表示名・メッセージ・ブランドカラー・ロゴ）
  - [x] `/admin/timezone`：タイムゾーン設定（JST既定・変更可）
  - [x] `/admin/llm`：接続設定（エンドポイント/モデル/上限N/ターン/タイムアウト）と保存時の自動疎通テスト
4) **状態管理/永続化**
 - [x] sessionStorageドラフト、画面遷移ガード
  - [x] 再試行キュー（ネットワークエラー時に未送信の回答をsessionStorageに蓄積し再送）
5) **通知・ダイアログ基盤（2025-03-01 統一）**
  - [x] `NotificationProvider`＋`useNotify()` を全画面に適用し、Chakra UI のトーストに統一。
    - 患者向け通知はフッター寄り（`channel: 'patient'`）で8秒表示、管理向けは右上（`channel: 'admin'`）。
    - 再試行ボタン等のアクションは `actionLabel` と `onAction` で実装し、ブラウザ標準の `alert`/`prompt`/`confirm` は使用しない。
  - [x] 持続表示が必要なステータスは `StatusBanner` コンポーネントで表現し、自動保存やモデル一覧取得時の結果を集約。疎通テストの手動実行結果はトースト通知のみで扱う。
  - [x] `useDialog()` を追加し、確認ダイアログ（削除/リセット）と入力ダイアログ（テンプレート複製など）を Promise で扱う。

---

## 3. フロント—バックエンド I/F（契約）
- `GET /questionnaires?visitType=initial|followup` → `QuestionItem[]`
- `POST /sessions` → `{ sessionId }`
- `POST /sessions/:id/answers` → `{ ok }`
- `POST /sessions/:id/llm-questions` → `LlmQuestion[]`
- `POST /sessions/:id/llm-answers` → `{ ok, remaining }`
- `POST /sessions/:id/finalize` → `{ summaryText, allAnswers, finalizedAt, status }`
- 管理系：`GET /questionnaires`, `POST /questionnaires`, `DELETE /questionnaires/{id}`, `POST /questionnaires/{id}/duplicate`, `GET/PUT /admin/llm`, `GET/PUT /system/timezone`, `POST /admin/login`
- バックアップ系：`POST /admin/questionnaires/export`, `POST /admin/questionnaires/import`, `POST /admin/sessions/export`, `POST /admin/sessions/import`
- 管理系結果閲覧：`GET /admin/sessions`, `GET /admin/sessions/{id}`

> API 名称は最終的にバックエンド設計に合わせて微調整して良い。

---

## 4. 画面/ルーティング仕様（要点）
- **ヘッダー**：左ロゴ、右上「管理画面」ボタン（常時）。
- **フッター**：`本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。`

---

## 付録：実施メモ（2025-10-06）

- [x] dermatology_intake.json を更新（問診テンプレート）
  - 初診（`visit_type=initial`）と再診（`visit_type=followup`）の順序を最適化。
  - 「気になる部位」の左右指定を廃止し、部位のみの選択肢に統一。
  - 各 `label` を患者に自然な問いかけ文へ統一し、`description` は補足説明に整理。
  - 「局所麻酔のトラブル」＝`yesno` に対し、`followups.yes` で自由記述の追質問（詳細）を追加。
  - スキーマは既存の読み込み仕様（`QuestionnaireItem.followups` / `visit_type` / `multi` / `yesno`）に準拠。
- 追加調整（統合方針）：初診/再診で共通化できる文面・説明・並びを極力統一
    - `consult_topics`/`target_areas`/`symptom_note`/`allergies`/`current_conditions`/`medications`/`hospitals`/`local_anesthesia_history` の `label` と `description` を共通表現へ寄せた。
    - 再診テンプレートの並びを初診と同一順序に揃えた。

  - エクスポート（questionnaire-settings-20251006-234610.json）からの補完
    - 初診に `onset`、`symptom_course`、`symptom_trigger`、`prior_treatments`、`daily_impact`、`food_metal_allergies`、`supplements_otc` を追加。
    - 再診に `contact_update`、`symptom_progress`、`treatment_effect`、`medication_adherence`、`medication_changes`、`side_effects`、`daily_impact`、`supplements_otc` を追加。
    - 妊娠/授乳（`pregnancy`/`breastfeeding`）を初診・再診の両方に追加（女性のみ表示）。

- **Entry**：初診/再診の選択のみを行い、「問診を始める」で基本情報画面へ遷移。
- **BasicInfo**：氏名（必須）・生年月日（必須、過去日付のみ）・性別、初診時は住所等の基本情報を入力。
  - 初診の固定UIで全項目が必須となっており、保存時に `personal_info` 回答としてセッションへ登録されるため、問診フォーム側で同項目を再入力するケースは発生しないことを 2025-09-24 時点で自動テストにより確認済み。
- **管理ログイン**：/admin/login でID/メール + パスワード。成功で /admin/main へ。
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
...

---

## 付録：ドキュメント整理（非公開化）
- [x] `docs/` 配下のうち、公開不要な文書を `internal_docs/` に移動（2025-08-31）。
  - 対象: `AGENTS.md`, `GEMINI.md`, `plannedSystem.md`, `PlannedDesign.md`, `LLMcommunication.md`, `implementation.md`, `admin_system_setup.md`, `docker_setup.md`, `UI_Redesign_Plan.md`, `Accessibility_And_Typography_Verification.md`
  - `docs/` 側には移動案内のプレースホルダを設置し、既存リンクの断絶を最小化。
  - `docs/` に残す公開想定ドキュメント: `session_api.md`, `admin_user_manual.md`
2) 管理画面で `llm_settings` と初診/再診テンプレ投入

---

## 変更履歴（運用メモ）
- [fix] 管理画面テンプレ設定のLLM有効判定を調整（疎通OKのみで有効化）。
  - これまで base_url が未設定だと UI のトグルが無効化されていたが、スタブ（ローカル）運用では base_url なしでも `/llm/settings/test` が OK を返すため、UI 側の可否判定を疎通テスト結果のみに変更。
  - 対象: `frontend/src/pages/AdminTemplates.tsx` の `llmAvailable` 判定。
- [fix] 外観設定のロゴアップロードでファイル名を自動サニタイズし、失敗時のトースト表示を追加。日本語や空白を含むファイルでも保存でき、アップロード後にクロップUIが確実に表示されるよう改善。
  - 対象: `backend/app/main.py`, `frontend/src/pages/AdminAppearance.tsx`
- [ui] ヘッダーのシステム表示名が長い場合でも一行表示を維持できるよう自動フォント縮小ロジックを追加。
  - 対象: `frontend/src/App.tsx`, `frontend/src/hooks/useAutoFontSize.ts`
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

## 14. メインダッシュボード再整備（2025-08-30）
- [x] `/admin` を `/admin/main` へリダイレクトし、メインダッシュボードを再導入。
- [x] ログイン後の遷移先を `/admin/main` に変更（問診最新10件＋システム状態カードを表示）。

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
  - 変更: `frontend/src/App.tsx` にログイン用モーダルを実装。ヘッダーの「管理画面」クリックでモーダルを開き、成功後に `/admin/main` へ遷移。
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

## 34. 患者側のフォントサイズ調整フローティングを追加（2025-08-31）
- [x] 画面右下に小さなホバーアイコンを常時表示（患者側のみ）。
- [x] クリックでスライダーを展開し、連続的にフォントサイズを調整可能。
- [x] スライダー以外の領域クリックで折りたたみ（アイコン表示へ戻る）。
- [x] 設定は `localStorage` に保存し、次回以降も適用（既定16px、14–22px、0.5刻み）。
  - 追加: `frontend/src/components/FontSizeControl.tsx`
  - 変更: `frontend/src/App.tsx`（管理画面以外でコンポーネントを常時マウント）

## 35. 住所・電話番号のブラウザ自動入力を抑止（2025-08-31）
- [x] 患者フォームのテキスト入力でオートフィル/補正系を明示的に無効化。
  - `autoComplete="off"`, `autoCorrect="off"`, `autoCapitalize="off"`, `spellCheck={false}` を付与。
  - 既知のヒューリスティクス回避として、`name` 属性に意味を持たない値（`qi-<id>` 等）を付与。
  - 対象: `frontend/src/pages/QuestionnaireForm.tsx`（通常入力・自由記述）, `frontend/src/pages/Questions.tsx`（LLM 追質問入力）, `frontend/src/pages/Entry.tsx`（氏名入力）。

## 36. 管理セッション出力の404改善（2025-08-31）
- [x] 管理の単一出力リンクで稀に `{"detail":"session not found"}` が表示される問題に対処。
  - `href` の `id` を `encodeURIComponent` でエスケープし、`target="_blank"` を付与してルーター干渉を回避。
  - Nginx 設定に `/admin` のバックエンドプロキシを追加（本番配信時に API がフロントへ吸われるのを防止）。
  - 変更: `frontend/src/pages/AdminSessions.tsx`, `frontend/nginx.conf`

## 37. テンプレート管理のUI配置調整（2025-08-31）
- [x] 保存済みテンプレート一覧を上部へ、その下に「新規テンプレート作成」欄を配置。
  - 変更: `frontend/src/pages/AdminTemplates.tsx`（セクションの順序入れ替え）

## 38. 管理メニューとマニュアル表記の刷新（2025-08-31）
- [x] 左ナビの「使い方」を「システム説明」に変更。
  - 変更: `frontend/src/components/AdminLayout.tsx`
- [x] マニュアルのタイトルを「システム説明」に変更し、最下部に GNU GPL v3 へのリンクを追加。
  - 変更: `docs/admin_user_manual.md`

## 39. GPLライセンス本文の同梱と表示（2025-08-31）
- [x] GNU GPL v3 のライセンス本文をレポジトリに同梱し、フロント配信に含めた。
  - 追加: `frontend/public/docs/LICENSE_GPL-3.0.md`
- [x] 管理画面にライセンス表示ページを追加し、ナビに「ライセンス」を追加。
  - 追加: `frontend/src/pages/AdminLicense.tsx`
  - 変更: `frontend/src/App.tsx`（ルート追加）, `frontend/src/components/AdminLayout.tsx`（ナビ項目追加）
- [x] システム説明ページ（マニュアル）から内部ライセンスページへの導線を追記。
  - 変更: `docs/admin_user_manual.md`

## 40. サブページ再読込時のトップリダイレクト（2025-08-31）
- [x] `/admin/*` を含むサブパスでのブラウザ再読込時にトップへリダイレクト。
  - 初回マウント時に NavigationTiming を確認し、`type=reload` か判定して `/` へ遷移。
  - 変更: `frontend/src/App.tsx`
  - 併せて開発/本番の配信設定を修正し、`/admin/*` のうち API を除くフロントルートは SPA の `index.html` を返すように調整。
    - 変更: `frontend/vite.config.ts`（`/admin` の包括プロキシを廃止し、APIサブパスのみプロキシ）
    - 変更: `frontend/nginx.conf`（`/admin/*` のAPIサブパスのみプロキシ＋それ以外は `try_files`）
    - 変更: `frontend/vite.config.ts` に開発時専用のミドルウェア（`spa-admin-fallback`）を追加し、`/admin/*` リロード時にも `index.html` を返すようにした。

## 41. 問診テンプレート取込時の405エラー解消（2025-10-03）
- [x] Nginx 本番設定に `/admin/questionnaires` のプロキシ定義を追加し、インポート/エクスポート API への `POST` リクエストがバックエンドへ到達するよう修正。
  - 変更: `frontend/nginx.conf`
  - 変更: `frontend/vite.config.ts`
- [x] UTF-8 BOM 付きのエクスポートファイルを許容するようバックエンドの読込処理を調整。
  - 変更: `backend/app/main.py`
- [x] 既存 DB にテンプレート関連テーブルが無い場合でも自動再初期化してインポートを継続するよう防御コードを追加。
  - 変更: `backend/app/main.py`
- [x] `dermatology_intake.json` の構造（`type=questionnaire_settings`、テンプレート配列等）が既存インポート仕様と整合することを確認。

## 33. システム表示名の設定機能（2025-08-23）
- [x] 管理画面から「システム表示名」を編集可能にし、患者画面のヘッダーに反映（管理画面のヘッダーは固定文言「管理画面」とし設定の影響を受けない）。
  - 変更（バックエンド）: `backend/app/db.py` に `app_settings` テーブルと `save_app_settings` / `load_app_settings` を追加。
  - 変更（バックエンド）: `backend/app/main.py` に `GET/PUT /system/display-name` を追加（既定値は「問診メイト」）。
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
- [x] 管理画面ヘッダーの「問診画面に戻る」ボタンの左側に小さなバッジで LLM 接続状態を表示（接続OK=緑、確認待ち/無効=黄、エラー=赤）。
- [x] 患者側ヘッダーでも「管理画面」ボタンの左側に同バッジを表示。
- [x] バックエンドの `LLMGateway` で最新の通信結果（成功/失敗/確認待ち）と更新時刻を保持し、`/system/llm-status` で取得できるようにした。状態は管理者ログイン、疎通テスト、追加質問生成・サマリー生成・チャットなど実際の呼び出し完了時に更新される。
- [x] フロント実装: `frontend/src/utils/llmStatus.ts` がスナップショットを取得して `llmStatusUpdated` イベントを発火し、`LlmStatusBadge`/`AdminLayout`/`AdminTemplates`/`AdminMain` が購読して表示を更新。

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
- [x] 患者画面の「管理画面」ボタン押下時に、別ウィンドウではなくモーダルでログインフォームを表示し、成功後に `/admin/main` へ遷移。
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

## 77. 単一選択入力の廃止（2025-12-10）
- [x] 単一選択入力方式を廃止し、既存の単一選択項目を複数選択に統一。
- [x] 変更（バックエンド）: `backend/app/main.py`, `backend/app/db.py`, `backend/app/validator.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx`, `frontend/src/pages/QuestionnaireForm.tsx`
- [x] テスト更新: `backend/tests/test_api.py`
- [x] ドキュメント更新: `docs/PlannedDesign.md`, `docs/implementation.md`

## 78. LLMステータス表示の明確化（2025-12-10）
- [x] ステータスバッジの表示文言を調整し、`status === 'ok'` でも `base_url` が未設定の場合は「LLM有効(ローカル)」と表示するように変更（従来は「LLM接続済」と表示され紛らわしかった）。
- [x] 変更（フロントエンド）: `frontend/src/components/LlmStatusBadge.tsx`

## 79. LLM設定保存後にステータス更新（2025-12-10）
- [x] LLM設定画面で保存成功時に `refreshLlmStatus()` を呼び出し、右上のステータスバッジへ最新状態を即時反映。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminLlm.tsx`

## 80. LLM疎通テストの厳格化（2025-12-10）
- [x] `/llm/settings/test` で、`enabled` かつ `base_url` と `model` が指定されていない場合は `ng` を返すように変更。
- [x] `test_connection()` はまずモデル一覧の取得を行い、選択モデルが含まれる場合に `ok` と判定（Ollama: `/api/tags`、LM Studio: `/v1/models`）。
- [x] チャットによる疎通確認は廃止し、タイムアウトの影響を避けた。
- [x] `/llm/settings` 保存時の疎通テストは `base_url` 指定時のみ実行（空の場合は保存可能だが、ステータスは `ng`）。
- [x] 変更（バックエンド）: `backend/app/llm_gateway.py`, `backend/app/main.py`

## 81. LLM設定の必須項目とUI制御（2025-12-10）
- [x] LLM有効時はモデル名が必須（未入力で保存不可、400）。
- [x] 管理画面に「LLMを使用する」チェックボックスを追加し、オフ時は各設定を一括で非活性化。
- [x] 変更（バックエンド）: `backend/app/main.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminLlm.tsx`

## 82. LLM未使用時のUIとバッジ文言（2025-12-10）
- [x] 「LLMを使用する」チェックボックスをフォーム最上部へ移動。
- [x] LLM未使用時はプロバイダ選択欄（Ollama/LM Studio）を非表示。
- [x] 右上のステータスバッジの無効ラベルを「LLM未使用」に変更。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminLlm.tsx`, `frontend/src/components/LlmStatusBadge.tsx`

## 83. 問診結果ダウンロード機能追加（2025-12-11）
- [x] 管理画面の問診結果一覧にPDF/Markdown/CSVダウンロード用アイコンを追加。
- [x] 変更（バックエンド）: `backend/app/main.py`, `backend/pyproject.toml`
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSessions.tsx`
- [x] テスト追加: `backend/tests/test_api.py`
- [x] ドキュメント更新: `docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`, `docs/implementation.md`

## 84. 管理画面使い方ドキュメントの差し替え（2025-12-12）
- [x] 日常操作向けの `docs/admin_user_manual.md` を追加し、管理メニューの「使い方」ページで表示するよう変更。
- [x] `docs/admin_system_setup.md` から「使い方ページ」に関する記述を修正。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminManual.tsx`
- [x] ドキュメント追加: `frontend/public/docs/admin_user_manual.md`

## 85. 問診結果一覧の出力ボタンにホバー説明を追加（2025-12-12）
- [x] PDF/Markdown/CSV 各アイコンにツールチップを追加し、ホバー時に出力形式が小さく表示されるように改善。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSessions.tsx`
- [x] バックエンド自動テスト実行: `cd backend && .venv/Scripts/pytest -q`（36件成功）

## 86. 問診結果の一括出力（複数選択/表示全件）対応（2025-12-12）
- [x] 一覧にチェックボックスを追加し、複数選択をサポート。選択が無い場合は表示中の全件を対象として一括出力。
- [x] 一括出力ボタン（PDF/Markdown/CSV）を検索フォーム下に追加。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSessions.tsx`
- [x] 変更（バックエンド）: `GET /admin/sessions/bulk/download/{fmt}` を追加。`ids` クエリで複数 ID を受け取り、`md/pdf` は ZIP で返却、`csv` は「全件を1枚の集計CSV」で返却（共通列＋「回答一覧」列に個別問診をまとめる）。
- [x] バックエンド自動テスト実行: `cd backend && .venv/Scripts/pytest -q`（36件成功）

## 87. 管理画面のLLM既定値を「未使用」に変更（2025-12-12）
- [x] 管理UIの初期状態で「LLMを使用しない」を既定とするよう変更。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminLlm.tsx` の初期ステートおよびロード時の既定（null時）を `enabled: false` に変更。
- [x] バックエンドのデフォルトは既に `enabled: false`（`default_llm_settings`）のため整合。
- [x] バックエンド自動テスト実行: `cd backend && .venv/Scripts/pytest -q`（36件成功）

## 88. Docker による起動対応（2025-12-13）
- [x] バックエンド用 `backend/Dockerfile` を追加。
- [x] フロントエンド用 `frontend/Dockerfile` と `frontend/nginx.conf` を追加。
- [x] `docker-compose.yml` で両コンテナを一括起動可能にした。
- [x] ドキュメント追加: `docs/docker_setup.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`（36件成功）

## 89. 非常用パスワードによる管理者パスワードリセット（2025-12-13）
- [x] 環境変数 `ADMIN_EMERGENCY_RESET_PASSWORD` を導入（TOTP 無効時のみ有効）。
- [x] バックエンド: `POST /admin/password/reset/emergency` を実装。成功時に TOTP を無効化（シークレット消去）。
- [x] フロント: `AdminPasswordReset.tsx` に非常用リセットフォーム、`AdminSecurity.tsx` に案内を追加。
- [x] ドキュメント: `backend/.env.example` を追加し、`docs/admin_system_setup.md` と `frontend/public/docs/admin_system_setup.md` を更新。
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`（36件成功）

## 90. 一括ダウンロードの404不具合修正（2025-08-31）
- [x] 事象: `/admin/sessions/bulk/download/{fmt}` で `{"detail":"session not found"}` が返る（PDF/CSV/MD 全て）。
- [x] 原因: ルーティング競合により `/admin/sessions/{session_id}/download/{fmt}` が優先マッチしていた。
- [x] 対応: バルク用エンドポイント（`/admin/sessions/bulk/download/{fmt}`）を定義順で先に評価される位置へ移動（`backend/app/main.py`）。
- [x] テスト追加: `tests/test_api.py::test_admin_bulk_download` を追加し、CSVは単一CSV、MD/PDFはZIP返却を検証。
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`（37件成功）

## 91. セッションデータの CouchDB 移行（2025-12-13）
- [x] セッション保存・取得処理を CouchDB 対応にし、`COUCHDB_URL` と `COUCHDB_DB` で有効化可能にした（未設定時は SQLite を使用）。
- [x] `docker-compose.yml` に CouchDB サービスを追加し、環境変数でバックエンドと連携。
- [x] ドキュメント更新: `docs/session_api.md`, `internal_docs/docker_setup.md`, `backend/.env copy.example`。
- [x] 認証情報を `COUCHDB_USER` / `COUCHDB_PASSWORD` で指定可能にし、URLから分離。
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`（37件成功）。

## 92. PDF出力の見やすさ改善（2025-12-14）
- [x] PDF出力をMarkdownベースのセクション・太字・箇条書きで整形し、視認性を向上。
- [x] 変更（バックエンド）: `backend/app/main.py`
- [x] ドキュメント更新: `docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `ADMIN_PASSWORD=admin .venv/bin/pytest -q`（37件成功）

## 93. `_users` データベース自動作成（2025-12-15）
- [x] CouchDB 起動時に `_users` が存在しない場合、バックエンドが自動作成するよう修正。
- [x] ドキュメント更新: `internal_docs/docker_setup.md`
- [x] バックエンド自動テスト実行: `cd backend && .venv/bin/pytest -q`

## 94. CouchDB保存失敗時のSQLiteフォールバック廃止（2025-09-02）
- [x] CouchDB 設定時に保存に失敗した場合、SQLite へフォールバックせず例外を送出。
  - 変更: `backend/app/db.py`
- [x] ドキュメント更新: `docs/session_api.md`

## 95. CouchDB稼働状況アイコンを追加（2025-09-02）
- [x] 管理画面ヘッダーに CouchDB の稼働状況アイコンを表示。
  - 追加: `frontend/src/components/CouchDbStatusIcon.tsx`
  - 変更: `frontend/src/App.tsx`, `docs/admin_user_manual.md`
- [x] バックエンド API を追加: `/system/couchdb-status`（後に削除）
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 96. モデル一覧取得時の自動疎通テスト（2025-09-03）
- [x] `POST /llm/settings/test` を実装し、リクエストの設定でLLM疎通テストを実行可能にした。
- [x] モデル一覧取得ボタン押下時に選択中モデルで疎通テストを実施し、結果をステータスバッジへ反映。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminLlm.tsx`
- [x] 変更（バックエンド）: `backend/app/main.py`, `backend/tests/test_api.py`, `backend/tests/test_admin.py`
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`

## 97. セッション保存時の更新競合対処（2025-09-03）
- [x] CouchDB へのセッション保存時に `_rev` を付与し、`ResourceConflict` 発生時は最新リビジョンを取得して再試行するよう修正。
  - 変更: `backend/app/db.py`
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`（39件成功）

## 98. CouchDB用環境変数の既定値設定（2025-12-20）
- [x] `backend/.env copy.example` の CouchDB 関連変数をデフォルト値に設定し、リポジトリ同梱の CouchDB に接続できるようにした。
- [x] ドキュメント更新: `internal_docs/docker_setup.md`, `docs/session_api.md`。
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`。

## 99. 依存ライブラリのライセンス一覧表示機能（2025-09-04）
- [x] 依存ライブラリのライセンス情報と本文を取得するスクリプトを追加。
  - 追加: `backend/tools/collect_licenses.py`
- [x] 管理画面ライセンスページに外部ライブラリ一覧ページへのボタンを追加。
  - 追加: `frontend/src/pages/AdminLicenseDeps.tsx`
  - 変更: `frontend/src/App.tsx`, `frontend/src/pages/AdminLicense.tsx`
- [x] ドキュメント更新: `frontend/public/docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 100. CouchDB稼働状況表示をバッジに統一（2025-09-05）
- [x] CouchDB の状態表示を LLM ステータスと同形式のバッジに変更。
  - 変更: `frontend/src/components/CouchDbStatusBadge.tsx`, `frontend/src/App.tsx`
- [x] ドキュメント更新: `docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 101. 選択肢に紐づく追加質問の追加（2025-09-05）
- [x] `QuestionnaireItem` に `followups` フィールドを追加し、選択肢ごとに追質問を定義可能にした。
- [x] 患者画面で条件を満たした際に通常の質問として間に挿入される表示処理を実装。
- [x] 問診テンプレート一覧で追加質問の有無が分かるよう表示を追加。
- [x] 管理画面から追加質問を編集できるモーダル UI を実装（最大2階層）。
- [x] 変更（バックエンド）: `backend/app/main.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/QuestionnaireForm.tsx`, `frontend/src/pages/AdminTemplates.tsx`
- [x] ドキュメント更新: `docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 102. 年齢・性別による表示制御の追加（2025-09-06）
- [x] 各問診項目に「年齢・性別で表示を制限」フラグを追加し、対象年齢範囲と性別を設定できるようにした。
- [x] 患者画面およびテンプレートプレビューで年齢・性別をもとに項目を出し分ける処理を実装。
- [x] 変更（バックエンド）: `backend/app/main.py`, `backend/tests/test_api.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/QuestionnaireForm.tsx`, `frontend/src/pages/AdminTemplates.tsx`
- [x] ドキュメント更新: `docs/admin_user_manual.md`, `internal_docs/implementation.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 103. スライドバー形式の問診項目追加（2025-09-07）
- [x] 問診項目にスライドバー型を追加し、最小値・最大値を設定可能にした（既定0〜10）。
- [x] 変更（バックエンド）: `backend/app/main.py`, `backend/app/validator.py`, `backend/tests/test_api.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/QuestionnaireForm.tsx`, `frontend/src/pages/AdminTemplates.tsx`
- [x] ドキュメント更新: `docs/session_api.md`, `docs/admin_user_manual.md`, `frontend/public/docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`

## 104. 問診項目への画像添付機能追加（2025-09-08）
- [x] 各問診項目に画像ファイルをアップロードし、プレビューおよび削除ができるようにした。
- [x] 変更（バックエンド）: `backend/app/main.py`, `backend/tests/test_api.py`
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx`
- [x] ドキュメント更新: `docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 105. Docker 環境の CouchDB 接続設定の明確化（2025-09-11）
- [x] `backend/.env` の `COUCHDB_URL` を Docker Compose の CouchDB コンテナに接続する既定値 `http://couchdb:5984/` に修正。
- [x] 変更: `backend/.env`, `internal_docs/docker_setup.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 106. 同梱SQLite DBの除去（2025-09-07）
- [x] リポジトリから `backend/app/app.sqlite3` を削除し、`.gitignore` / `.dockerignore` に `backend/app/*.sqlite3` を追加。
- [x] ドキュメント更新: `internal_docs/docker_setup.md`, `internal_docs/admin_system_setup.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 107. 項目編集UIと追加質問一覧表示の改善（2025-09-12）
- [x] 「フリーテキスト入力を許可」チェックボックスを左寄せに統一。
- [x] 「年齢・性別で表示を制限」を編集エリアの末尾に配置し、選択肢追加ボタンの下でも最下部に表示。
- [x] 追加質問追加ボタンを「？」アイコンとし、ホバー時に案内を表示。
- [x] 問診項目一覧で追加質問を一段下げて表示。
- [x] ドキュメント更新: `docs/admin_user_manual.md`, `frontend/public/docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 108. 追加質問編集動線の簡略化（2025-09-13）
- [x] 追加質問追加モーダルを開いた際に即座に入力欄を表示するよう変更し、初回の「質問を追加」操作を省略。
- [x] 問診項目一覧の追加質問をクリックすると、その追加質問の編集モーダルが開くようにした。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx`
- [x] ドキュメント更新: `docs/admin_user_manual.md`, `frontend/public/docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 109. 画像アイコン表示と用語変更（2025-09-14）
- [x] 問診項目一覧で画像付き項目に画像アイコンを表示。
- [x] UI 上の「ネスト質問」を「追加質問」に統一。
- [x] 補足説明の直下に画像設定欄を移動（項目編集・追加・追加質問編集）。
- [x] ドキュメント更新: `docs/admin_user_manual.md`, `frontend/public/docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 110. データベース種別バッジの拡張（2025-09-15）
- [x] 管理画面ヘッダーのデータベースバッジを CouchDB/SQLite/DB接続エラーの3種表示に変更。
  - 変更: `backend/app/main.py`, `backend/tests/test_database_status.py`, `frontend/src/components/DbStatusBadge.tsx`, `frontend/src/App.tsx`
- [x] ドキュメント更新: `README.md`, `docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 111. 旧CouchDBステータスAPIの削除（2025-09-15）
- [x] 後方互換のため残していた `/system/couchdb-status` エンドポイントを削除。
- [x] バックエンド自動テスト実行: `cd backend && pytest`



## 112. デフォルト問診テンプレートの自然言語ブラッシュアップ（2025-11-20）
- [x] デフォルト問診テンプレート定義を `make_default_initial_items` / `make_default_followup_items` として関数化し、起動時・リセット時・フォールバック取得時の内容を一元管理。
- [x] 初診テンプレートの質問文を実運用に沿った丁寧な表現へ更新し、症状の変化・きっかけ・生活への影響・家族歴などの補足項目を追加。
- [x] 再診テンプレートを「連絡先変更」「前回からの症状の変化」「服薬状況」「副作用の有無」など再診時に確認したい内容へ刷新。
- [x] 選択肢に含まれていた「その他」をすべて廃止し、自由記入欄で補足できるよう `allow_freetext` を併用する形に統一。
- [x] 既定テンプレートを再投入する `/questionnaires/{id}/reset` と `/questionnaires/default/reset` も新関数を利用するよう調整。
## 113. 画像削除確認とプレビュー拡大対応（2025-09-16）
- [x] 問診項目編集画面で画像削除時に確認ダイアログを表示し、プレビュー画像をモーダルで拡大表示できるようにした。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx`
- [x] ドキュメント更新: `docs/admin_user_manual.md`, `frontend/public/docs/admin_user_manual.md`
- [x] バックエンド自動テスト実行: `cd backend && pytest`

## 114. ボタン配色のコントラスト改善（2025-09-22）
- [x] Chakra UI テーマで `accent.solid` に対する `accent.onFilled` を再計算し、ブランドカラーが明るい場合でも文字色が適切に切り替わるよう改修。
- [x] 変更（フロントエンド）: `frontend/src/theme/index.ts`
- [x] フロントエンドビルド確認: `cd frontend && npm run build`

## 115. PDF出力レイアウト刷新と切り替え設定（2026-01-15）
- [x] MarkdownベースのPDF変換を廃止し、`backend/app/pdf_renderer.py` でReportLab Platypusを用いたフォーム型レイアウトを実装。
- [x] `/admin/sessions/*/download` および一括出力が新レイアウトを利用するよう `backend/app/main.py` を改修し、`PDFLayoutMode` によるレガシー切り替えを追加。
- [x] `/system/pdf-layout` API を追加し、`backend/tests/test_api.py::test_pdf_layout_setting_toggle` で設定反映を検証。
- [x] ドキュメント更新: `docs/admin_user_manual.md`, `internal_docs/implementation.md`。
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`

## 116. LLM設定画面の再構成とプロバイダ別設定保持（2025-09-22）
- [x] 管理画面の LLM 設定 UI をカード分割＋グレートーンベースで再構成し、ベースURL・モデル名などをプロバイダ単位で保持しつつ LLM有効化スイッチはプロバイダ切替と独立させるよう `frontend/src/pages/AdminLlm.tsx` を全面改修。モデル名は API から取得した候補一覧のみを選択可能とし、既存の設定値は一覧未取得でも表示されるように保持。モデル一覧取得ボタンを同セクションへ移動。
- [x] `backend/app/llm_gateway.py` と `backend/app/main.py` に `provider_profiles` を追加し、選択プロバイダごとの設定を永続化／復元できるよう API を拡張。
- [x] `backend/tests/test_api.py::test_llm_settings_get_and_update` を更新し、プロバイダ切り替え時に個別設定が保持されることを確認。
- [ ] バックエンド自動テスト実行: `cd backend && pytest -q`（`couchdb` モジュール未導入のため失敗）（`couchdb` モジュール未導入のため失敗）
- [x] フロントエンドビルド確認: `cd frontend && npm run build`

## 117. 患者名検索の部分一致強化（2025-09-23）
- [x] SQLite/CouchDB の患者名フィルタで前後空白および全角・半角スペースを除いた比較を追加。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSessions.tsx` で検索条件送信時に `trim()` を適用。
- [x] ドキュメント更新: `docs/session_api.md`
- [ ] バックエンド自動テスト実行: `cd backend && pytest -q`（`couchdb` モジュール未導入のため失敗）

## 118. 管理画面設定の自動保存統一（2026-02-05）
- [x] 外観設定（表示名・各種メッセージ・ブランドカラー・ロゴ）の入力内容を `useAutoSave` で即時保存するよう変更。保存ボタンを廃止し、ステータス表示を追加。
- [x] タイムゾーン設定も選択直後に自動保存し、`TimezoneContext` へ即座に反映。
- [x] 共通部品: `AutoSaveStatusText` と `readErrorMessage` ユーティリティを新設し、フロントエンドから利用。
- [x] ドキュメント更新: `docs/admin_user_manual.md` と `internal_docs/admin_system_setup.md` を自動保存仕様に更新。


## 119. ロゴプレビューとトリミングロック改善（2025-09-23）
- [x] 外観設定のロゴプレビューをヘッダー実サイズ（28px）の表示に合わせ、クロップ結果をそのまま確認できるよう `AdminAppearance` を調整。
- [x] 「表示範囲を調整」ボタンでトリミングUIをオンにし、「調整を完了」で枠を固定できるロック機能を追加。数値入力やプリセットボタンは編集中のみ操作可能に変更。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminAppearance.tsx`。
- [x] ドキュメント更新: `docs/admin_user_manual.md`, `frontend/public/docs/admin_user_manual.md`, `frontend/dist/docs/admin_user_manual.md`。
- [x] フロントエンドビルド確認: `cd frontend && npm run build`.

## 120. 問診テンプレート画像エクスポートの正規化（2025-09-23）
- [x] 変更（バックエンド）: `backend/app/main.py` に画像URL正規化ヘルパーを追加し、テンプレートのエクスポート時に絶対パスやクエリ付きURLでも `/questionnaire-item-images/files/<filename>` へ揃えて添付画像を含めるよう修正。インポート時も同じロジックで復元。
- [x] テスト追加: `backend/tests/test_export_import.py::test_questionnaire_export_normalizes_absolute_image_url` を追加し、絶対URLを含むテンプレートが画像ごと再現できることを検証。
- [x] バックエンド自動テスト実行: `../venv/bin/python -m pytest tests/test_export_import.py`（3件成功）。

- [x] 外観設定の「表示範囲を調整」操作をモーダル上で行うように変更し、通常表示エリアではプレビューのみを表示。編集操作はモーダル内に集約してドラッグと数値入力を常時有効化。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminAppearance.tsx`。
- [x] ドキュメント更新: `docs/admin_user_manual.md`, `frontend/public/docs/admin_user_manual.md`, `frontend/dist/docs/admin_user_manual.md`。
- [x] フロントエンドビルド確認: `cd frontend && npm run build`。

## 121. PDF出力の基本情報欄統合と回答表示の簡素化（2026-02-06）
- [x] 変更（バックエンド）: `backend/app/pdf_renderer.py` で個人情報項目をヘッダへ統合し、よみがな・郵便番号・住所・電話番号を患者基本情報として個別表示。問診表の設問一覧から `personal_info` 項目を除外し、回答欄では複数選択／はい・いいえ設問が選択済み項目のみを表示するよう調整。自由記述も同一レイアウトで表示。
- [x] 変更（バックエンド）: `backend/app/pdf_renderer.py` の初診問診票ヘッダで患者基本情報（氏名・よみがな・生年月日・性別・郵便番号・住所・電話番号）を二段組レイアウト化し、氏名上に小サイズの「よみがな」を併記するよう調整（2025-09-24 改修）。
- [x] ドキュメント更新: 本ファイル。
- [x] バックエンド自動テスト実行: `cd backend && pytest -q`

## 122. ライセンス画面のUI刷新と依存ライブラリエクスポート拡張（2025-09-24）
- [x] 変更（バックエンド）: `backend/tools/collect_licenses.py` に Node.js 依存収集ロジックとメタ情報（component/category/homepage/license_url など）を追加。未インストールの Python ライブラリは既存JSONから補完するフォールバックを実装。
- [x] 既存 JSON: `frontend/public/docs/dependency_licenses.json` を再生成し、`source`・`component`・`category` を含む32件へ更新。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminLicense.tsx` をカード＋タブ構成へ刷新し、GPL要約カード・遵守チェックリスト・依存ライブラリ統計を追加。全文表示タブにコピー導線を実装。
- [x] 変更（フロントエンド）: `frontend/src/components/license/LicenseDependencyList.tsx`（新規）、`frontend/src/pages/AdminLicenseDeps.tsx` を導入し、検索・フィルタ・Accordion 展開・コピー/外部リンク導線を実装。
- [x] ユーティリティ追加: `frontend/src/types/license.ts`, `frontend/src/utils/license.ts` を新設（ライセンス種別判定・取得ヘルパー）。
- [x] フロントエンドビルド確認: `cd frontend && npm run build`（警告のみ、ビルド成功）。

## 123. 患者基本情報入力方法の管理画面からの撤去（2025-09-24）
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx` で `personal_info` タイプを入力方法の選択肢から削除し、既存項目は読み取り専用表示に変更。
- [x] 変更（バックエンド）: `backend/app/main.py::make_default_initial_items` から患者基本情報項目を削除し、デフォルト初診テンプレートを更新。
- [x] テスト更新: `backend/tests/test_api.py::test_default_template_contains_items` の期待値を新テンプレートに合わせて修正。
- [x] バックエンド自動テスト実行: `../venv/bin/python -m pytest tests/test_api.py::test_default_template_contains_items -q`（1件成功、DeprecationWarning のみ）。
- [x] フロントエンドビルド確認: `cd frontend && npm run build`（チャンクサイズ警告のみ、ビルド成功）。

## 124. 初診基本情報の永続化修正（2025-09-24）
- [x] 変更（バックエンド）: `backend/app/main.py::make_default_initial_items` に `personal_info` 項目を再追加し、初診テンプレートで氏名・ふりがな・住所等を回答として保持できるよう復旧。
- [x] テスト更新: `backend/tests/test_api.py::test_default_template_contains_items` に `personal_info` を期待項目として追加。
- [ ] バックエンド自動テスト実行: `cd backend && pytest tests/test_api.py::test_default_template_contains_items -q`（FastAPI 未インストールのため実行不可）

## 125. 固定UI初診基本情報のテンプレ保存一元化（2025-09-24）
- [x] 変更（フロントエンド）: `frontend/src/pages/BasicInfo.tsx` で固定UI入力の個人情報をセッション作成時に `personal_info` 回答として送信し、初期回答をセッションストレージへ保存。
- [x] 変更（フロントエンド）: `frontend/src/pages/QuestionnaireForm.tsx` でサーバー保存済みの個人情報を尊重しつつ固定UI入力で欠落分のみ補完。
- [x] テスト更新: `backend/tests/test_api.py::test_create_session` に `personal_info` 回答の正規化検証を追加。
- [x] ドキュメント更新: `docs/session_api.md` に初診時の `personal_info` 送信要件を追記。
- [x] バックエンド自動テスト実行: `cd backend && pytest`
- [x] フロントエンドビルド確認: `cd frontend && npm run build`

## 126. 問診テンプレート設定から患者基本情報項目を不可視化（2025-09-24）
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx` で `personal_info` 項目をテンプレート編集UIから除外しつつ既存データは保持できるようにし、保存時に自動で元の位置へ復元するロジックを追加。
- [x] ドキュメント更新: `docs/admin_user_manual.md` に患者基本情報が固定UIで必須入力されテンプレート一覧には表示されない旨を追記。
- [x] フロントエンドビルド確認: `cd frontend && npm run build`

## 127. 管理画面問診結果の患者情報レイアウト整理（2025-09-26）
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSessionDetail.tsx` の患者情報カードを2段組の情報グリッドへ刷新し、患者名・問診日時・状態タグをヘッダーにまとめて視認性を向上。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminSessions.tsx` のダッシュボード詳細モーダルでも同様のグリッドレイアウトを適用し、個人情報項目を一目で確認できるよう整列。
- [x] フロントエンドビルド確認: `cd frontend && npm run build`（チャンクサイズ警告のみ、ビルド成功）。

## 128. 問診項目追加フォームの背景コントラスト改善（2025-10-06）
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx` の問診項目編集フォームと新規追加フォームの背景色を白へ統一し、グレーアウトして見えにくかった状態を解消。
- [x] 影響範囲: 既存テンプレート設定や入力内容は変更されず、表示コントラストのみ改善。移行作業は不要。
- [x] フロントエンドビルド確認: `cd frontend && npm run build`

## 129. データ永続化ディレクトリの統一（2025-12-XX）
- [x] Docker Compose で SQLite/CouchDB を `./data/sqlite`・`./data/couchdb` にマウントし、`MONSHINMATE_DB` の既定値を `/app/data/sqlite/app.sqlite3` に設定。
- [x] `.env.example` を新設して環境変数サンプルを一本化。`backend/app/main.py` はリポジトリルートの `.env` を優先読込。
- [x] ドキュメント更新: `README.md`, `internal_docs/docker_setup.md`, `internal_docs/admin_system_setup.md`, `frontend/public/docs/admin_system_setup.md`, `frontend/dist/docs/admin_system_setup.md`。

## 130. CouchDB 接続遅延時の再初期化処理追加（2025-10-01）
- [x] 変更（バックエンド）: `backend/app/db.py` に `get_couch_db` を導入し、初回接続失敗後でも要求時に再接続できるよう遅延初期化を実装。
- [x] 動作確認: `curl -X POST http://localhost:8001/sessions -H 'Content-Type: application/json' -d '{"patient_name":"テスト太郎","dob":"1990-01-01","gender":"male","visit_type":"general","answers":{"chief_complaint":"テスト"}}'` でセッション作成が成功することを確認。
- [ ] バックエンド自動テスト: `docker compose exec backend python -m pytest -q`（pytest 未インストールのため未実行）。

## 131. テンプレートIDリネームAPIと管理UI更新（2025-10-03）
- [x] 変更（バックエンド）: `backend/app/db.py` に `rename_template` を追加し、テンプレートID変更時に関連テーブルとデフォルト設定・CouchDBセッションを更新。`backend/app/main.py` に `/questionnaires/{id}/rename` API を追加。
- [x] テスト追加: `backend/tests/test_api.py::test_rename_questionnaire_updates_related_data` / `test_rename_questionnaire_validation` を新設。
- [x] 変更（フロントエンド）: `frontend/src/pages/AdminTemplates.tsx` で標準テンプレート以外に「名称変更」ボタンを追加し、リセットボタン表示を標準テンプレート限定に変更。
- [x] ドキュメント更新: `docs/session_api.md`, `docs/admin_user_manual.md` にリネームAPIとUI仕様を反映。
- [ ] バックエンド自動テスト実行: `cd backend && pytest tests/test_api.py::test_rename_questionnaire_updates_related_data -q`（`couchdb` モジュール未導入のため ImportError）
- [ ] フロントエンドビルド確認: `cd frontend && npm run build`

## 132. PDF header personal_info fallback (2025-10-06)
- [x] backend: backend/app/pdf_renderer.py now falls back to answers.personal_info when the template omits personal_info, keeping header fields filled.
- [x] backend: PDF header completion date now falls back to finalized_at (or started_at) so the displayed 記入日 matches管理画面.
- [x] backend: Removed the 'よみがな:' prefix from the patient header kana line in backend/app/pdf_renderer.py so the PDF shows only the kana text.
- [ ] backend tests: cd backend && pytest -q (failed: FastAPI not installed in current environment)
