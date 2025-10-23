# Firestore Adapter Design

## 1. 目的
- MonshinMate を Cloud Run + Firebase Firestore 上で運用することを想定し、既存の SQLite/CouchDB ベース永続化レイヤーを Firestore へ切り替えられるようにする。
- `backend/app/db/firestore_adapter.py` の役割、API 対応表、データマッピング、環境変数・エミュレータ利用手順をまとめる。

## 2. コレクション構成
| Collection | ドキュメント ID | 主なフィールド | 備考 |
| --- | --- | --- | --- |
| `questionnaireTemplates` | `templateId` | `id`, `createdAt`, `updatedAt` | 基本メタ。variants サブコレクションを保持。 |
| `questionnaireTemplates/{templateId}/variants` | `visitType` | `visitType`, `items`, `llmFollowupEnabled`, `llmFollowupMaxQuestions`, `summaryPrompt`, `followupPrompt`, `createdAt`, `updatedAt` | テンプレート種別ごとの実体。items は JSON 構造のまま保存。 |
| `sessions` | `sessionId` | `patient_name`, `dob`, `gender`, `visit_type`, `questionnaire_id`, `answers`, `summary`, `remaining_items`, `completion_status`, `attempt_counts`, `started_at`, `finalized_at`, `question_texts`, `llm_question_texts`, `pending_llm_questions`, `updated_at` | 既存 SQLite/CouchDB のフィールドを一括保存。`started_at` 等は ISO 8601 文字列化。 |
| `systemConfigs` | `configId` | `payload`, `updatedAt` | `llmSettings`, `appSettings` など設定系。 |
| `users` | `username` | `hashed_password`, `is_initial_password`, `password_updated_at`, `totp_secret` (Fernet 暗号化), `totp_mode`, `is_totp_enabled`, `totp_changed_at`, `updatedAt` | 管理者認証情報。TOTP シークレットは暗号化して保存。 |
| `auditLogs` | 自動採番 | `event`, `username`, `note`, `sessionId`, `createdAt` | パスワード更新等の監査記録（実装予定）。 |
| `sessions/{sessionId}/logs` | `logId` | `logType`, `payload`, `createdAt` | LLM やエクスポート関連のログ（今後の拡張）。 |

## 3. API 対応表
| 区分 | SQLite 実装 | Firestore 実装 | 備考 |
| --- | --- | --- | --- |
| テンプレート CRUD | `upsert_template`, `get_template`, `list_templates`, `delete_template` | 同名メソッドを実装済み。transactions を用いて variant とtemplate を更新。 |
| テンプレート ID リネーム | `rename_template` | 2025-10-23 実装済み。新 ID へコピー後 sessions / appSettings を更新。 |
| プロンプト設定 | `upsert_summary_prompt`, `get_summary_config`, `upsert_followup_prompt`, `get_followup_config` | variant ドキュメントのフィールドとして保存。 |
| セッション CRUD | `save_session`, `list_sessions`, `list_sessions_finalized_after`, `get_session`, `delete_session`, `delete_sessions` | Firestore ドキュメント `sessions/{sessionId}` に保存。質問文マップや LLM 質問も格納。 |
| 設定保存 | `save_llm_settings`, `load_llm_settings`, `save_app_settings`, `load_app_settings` | `systemConfigs/{configId}` を利用。 |
| ユーザー管理 | `get_user_by_username`, `update_password`, `verify_password`, `update_totp_secret`, `set_totp_status`, `get_totp_mode`, `set_totp_mode` | `users/{username}` ドキュメントを利用。Fernet（同一鍵）で TOTP シークレット暗号化。 |
| 監査ログ | `list_audit_logs` | `auditLogs` コレクションから保存/取得できるよう実装済み。 |
| セッション Export/Import | `export_sessions_data`, `import_sessions_data` | **TODO**: Firestore からの一括取得/書き戻しを実装し、Cloud Storage 連携も検討。 |

## 4. 環境変数・初期化
- 主要変数: `PERSISTENCE_BACKEND=firestore`, `FIRESTORE_PROJECT_ID`, `FIRESTORE_NAMESPACE`, `FIRESTORE_USE_EMULATOR`, `FIRESTORE_EMULATOR_HOST`, `GOOGLE_APPLICATION_CREDENTIALS`。
- `backend/app/config.py` で設定を読み取り、`FirestoreAdapter.init()` 内でクライアントを生成。
- エミュレータ利用時は `FIRESTORE_USE_EMULATOR=1` と `FIRESTORE_EMULATOR_HOST=localhost:8081` を指定。プロジェクト ID が未指定の場合は `monshinmate-emulator` をデフォルト使用。

## 5. Firestore Emulator 手順
1. 別ターミナルで `gcloud beta emulators firestore start --host-port=localhost:8081` を実行。
2. プロジェクトルートで:
   ```bash
   export FIRESTORE_EMULATOR_HOST=localhost:8081
   export FIRESTORE_USE_EMULATOR=1
   export PERSISTENCE_BACKEND=firestore
   PYTHONPATH=backend uvicorn app.main:app --reload --port 8001
   ```
3. API スモークテスト例:
   ```bash
   curl -X GET http://localhost:8001/questionnaires
   curl -X POST http://localhost:8001/questionnaires/default/initial/import -H 'Content-Type: application/json' -d '{"items": []}'
   ```

## 6. テスト戦略
- ユニット: `pytest` から Firestore Emulator を起動し、テンプレート CRUD / セッション保存 / ユーザー管理 / 監査ログをモックなしで検証。
- `backend/tests/test_firestore_adapter.py` を追加し、`FIRESTORE_EMULATOR_HOST` 設定時に主要 API をまとめて疎通確認できるようにした。
- 統合: 既存 API テストで `PERSISTENCE_BACKEND=firestore` を指定し、SQLite/CouchDB との差分を吸収する。
- 将来的に `pytest` マーカー（例: `@pytest.mark.firestore`) を導入し、CI でエミュレータを起動可能にする。

## 7. 移行ポリシー
- 既存データの移行は `tools/migrate_to_firestore.py`（PoC 版）で SQLite / CouchDB から Firestore への一括投入を行う。`--dry-run` で件数のみ確認可能。
- Cutover 時は、`PERSISTENCE_BACKEND` の切替と Secret Manager 設定（LLM キー等）を実施し、ロールバックとしては再度 SQLite に戻せるよう export を取っておく。

## 8. 残タスク
- セッション Export/Import の Firestore 対応。
- Secret Manager 連携と Credential Rotation 手順の記載。
- Cloud Storage ベースのファイルエクスポート導線。
