# 実装手順書（Minimal 版 / v1）

> **重要な注意**：本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。すべての主要画面のフッターに本注意書きを表示します。

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
  - [ ] テンプレート一覧/新規/編集/削除が動作
  - [ ] 初診/再診タブ切替、項目の型（single/multi/number/date/text）と選択肢設定
  - [ ] 条件表示（軽量 when）の保存/反映
  - [ ] プレビューで患者側画面の疑似レンダリング

### MS2：セッション基盤
- 目的：セッション生成と状態遷移（Entry→種別→問診→追加質問→確認→完了）
- **完了条件**
  - [ ] `POST /sessions` でセッション作成
  - [ ] 進行状態（remaining_items / completion_status / attempt_counts）の保持
  - [ ] 画面遷移ガード（未入力時の差し戻し）

### MS3：LLM追加質問ループ
- 目的：不足項目のみを**上限N件**で質問し、ターン制御で補完
- **完了条件**
  - [ ] `POST /sessions/{id}/llm-questions` が `questions[]` を返す
  - [ ] 優先度順に提示し、回答送信→再計算→終了条件（0件/上限/手動終了）
  - [ ] 項目ごとの再質問は最大3回、セッション合計の上限Nは設定で制御

### MS4：要約と保存
- 目的：全回答の一覧確認→確定→保存/要約出力
- **完了条件**
  - [ ] `/review` で全回答を一望しインライン編集可能
  - [ ] `POST /sessions/{id}/finalize` が `summaryText` と `allAnswers` を返す
  - [ ] 完了ステータスとタイムスタンプ保存

### MS5：フロント実装（患者/管理）
- 目的：UI導線と状態管理の実装
- **完了条件**
  - [ ] **患者**：Entry（氏名/生年月日）→ VisitType → Questionnaire → Questions → Review → Done
  - [ ] **共通**：ヘッダー右上「管理画面」ボタン、フッター注意文の常時表示
  - [ ] **管理**：ログイン→Dashboard→Templates→LLM設定

### MS6：ログ/観測性（最小）
- 目的：障害時の原因追跡と操作把握
- **完了条件**
  - [ ] セッション遷移、APIエラー、LLM I/Oメタ（所要時間）の記録
  - [ ] /readyz, /health の簡易エンドポイント

### MS7：UAT / 受け入れ
- 目的：エンドツーエンド検証
- **完了条件**
  - [ ] 初診/再診の代表テンプレで入力→追加質問→確定が成功
  - [ ] LLM無効時でもベース問診のみで完了
  - [ ] 受け入れ基準（§10）を満たす

---

## 2. 作業手順（WBS）

### 2.1 バックエンド
1) **モデル/スキーマ**
   - [ ] `questionnaires`（テンプレメタ + items[]）
   - [ ] `sessions`（進行状態・完了フラグ・timestamps）
   - [ ] `session_responses`（全回答・追加質問の履歴）
2) **サービス**
   - [ ] `SessionFSM`：`step("answer")`、`_finalize_item`、attempt/turn/questions 上限管理
   - [ ] `LLMGateway`：`generate_question`、`decide_or_ask`、`summarize`（タイムアウト/再試行）
   - [ ] `Validator`：必須・型・範囲のみ
   - [ ] `StructuredContextManager`：`update_structured_context`
3) **API**
   - [ ] `POST /sessions`（患者名・生年月日・visitType・questionnaireId）
   - [ ] `POST /sessions/{id}/answers`（ベース問診保存）
   - [ ] `POST /sessions/{id}/llm-questions`（不足の抽出）
   - [ ] `POST /sessions/{id}/llm-answers`（追加質問への回答の保存）
   - [ ] `POST /sessions/{id}/finalize`（要約生成と確定）
   - [ ] 管理系：`GET/POST /questionnaires`, `GET /questionnaires/{id}/template`, `DELETE /questionnaires/{id}`
4) **観測性**
   - [ ] /readyz, /health, /metrics（簡易）

### 2.2 フロントエンド
1) **共通**
   - [ ] ルーティング骨格、ヘッダー/フッター（注意文常時表示）
2) **患者向け**
   - [ ] `/`：氏名・生年月日フォーム（次へで `/visit-type`）
   - [ ] `/visit-type`：初診/再診選択（未選択は次へ非活性）
   - [ ] `/questionnaire`：テンプレに基づくフォーム（軽量条件表示、ドラフト保存）
   - [ ] `/questions`：LLM追加質問（モーダル or カード列）と進行インジケータ
   - [ ] `/review`：全回答の一覧・インライン編集・確定
   - [ ] `/done`：完了メッセージと要約（印刷/コピー任意）
3) **管理向け**
   - [ ] `/admin/login`：管理者ログイン
   - [ ] `/admin`：ダッシュボード
   - [ ] `/admin/templates`：一覧/新規/編集/複製/削除
   - [ ] `/admin/templates/:id`：初診/再診タブと項目CRUD、プレビュー
   - [ ] `/admin/llm`：接続設定（エンドポイント/モデル/上限N/ターン/タイムアウト）と疎通テスト
4) **状態管理/永続化**
   - [ ] sessionStorageドラフト、再試行キュー、画面遷移ガード

---

## 3. フロント—バックエンド I/F（契約）
- `GET /questionnaires?visitType=initial|followup` → `QuestionItem[]`
- `POST /sessions` → `{ sessionId }`
- `POST /sessions/:id/answers` → `{ ok }`
- `POST /sessions/:id/llm-questions` → `LlmQuestion[]`
- `POST /sessions/:id/llm-answers` → `{ ok, remaining }`
- `POST /sessions/:id/finalize` → `{ summaryText, allAnswers }`
- 管理系：`GET/POST /questionnaires`, `GET/PUT /questionnaires/:id`, `DELETE /questionnaires/:id`, `GET/PUT /admin/llm`

> API 名称は最終的にバックエンド設計に合わせて微調整して良い。

---

## 4. 画面/ルーティング仕様（要点）
- **ヘッダー**：左ロゴ、右上「管理画面」ボタン（常時）。
- **フッター**：`本システムはローカルLLMを使用しており、外部へ情報が送信されることはありません。`
- **Entry**：氏名（必須）・生年月日（必須、過去日付のみ）
- **管理ログイン**：/admin/login でID/メール + パスワード。成功で /admin へ。
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
