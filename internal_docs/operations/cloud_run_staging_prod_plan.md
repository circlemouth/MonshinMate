# Cloud Run Staging / Production Validation Plan

## 1. 事前準備
- Terraform で `stg` プロジェクトへ Firestore / Secret Manager / Storage / Cloud Run (backend, frontend) をデプロイ。
- Secret Manager に以下シークレットを投入: `monshinmate-admin-password`, `monshinmate-secret-key`, `monshinmate-totp-enc-key`, `monshinmate-llm-api-key`。
- Artifact Registry へ backend/frontend イメージを push (`gcr.io/<project>/monshin-backend:<tag>` 等)。
- Cloud Run サービスに環境変数を設定:
  - backend: `PERSISTENCE_BACKEND=firestore`, `SECRET_MANAGER_ENABLED=1`, `SECRET_MANAGER_PREFIX=monshinmate`, `FIRESTORE_PROJECT_ID=<project>`, `LLM_PROVIDER=ollama` etc。
  - frontend: `BACKEND_ORIGIN=https://<backend-run-url>`, `API_BASE_URL=https://<backend-run-url>`。

## 2. ステージング検証 (stg)
1. `gcloud run services describe` で最新リビジョンと環境変数を確認。
2. `curl https://<backend-run-url>/healthz` が `{"status":"ok"}` を返すこと。
3. フロント（`https://<frontend-run-url>`）にアクセスし、下記ユーザーフローを実施:
   - 患者フロー: Entry → BasicInfo → Questionnaire → Questions → Done。PDF/CSV エクスポートを実行し、Cloud Storage バケットにファイルが作成されること。
   - 管理フロー: `/admin/login` → テンプレート編集 → LLM 設定変更 → セッション一覧ダウンロード。
4. Firestore コンソールで `sessions` コレクションにデータが保存されていること、`auditLogs` へイベントが記録されていることを確認。
5. Cloud Monitoring Dashboards: エラー率とレイテンシのメトリクスが取得・可視化されているか。
6. ログフィルタ: `resource.type="cloud_run_revision"` で backend/frontend のログが出力されているか。

## 3. 本番切替テスト (prod)
1. 本番用プロジェクトで Secret Manager / Firestore / Storage を Terraform 適用。
2. `gcloud run services update-traffic monshin-backend --region=<region> --to-latest` をカナリア比率 10% で実施し、15分間メトリクスを監視。
3. エラーがない場合、100% へ切替。問題があれば `--to-revisions` で旧リビジョンへロールバック。
4. frontend も同様に段階的トラフィック移行。
5. 切替後、エクスポート・監査ログ・Secret Manager 取得の smoke test を実施。

## 4. 監視とアラート
- アラート条件
  - HTTP 5xx 比率 5% 超過 (5分 window) → PagerDuty。
  - レイテンシ p95 > 2s (10分 window) → Slack 通知。
  - Firestore 書き込み失敗（`monitored_resource="firestore_instance" error_rate > 0`）。
- Runbook: エラー時は Cloud Run リビジョンログを確認 → Firestore ステータス → Secret Manager アクセス権を確認。

## 5. 手戻り手順
- backend/frontend いずれも `gcloud run services update-traffic <service> --to-revisions <prev-rev>=100` でロールバック。
- データ移行中断時は Firestore の `sessions` をバックアップ（`gcloud firestore export gs://<bucket>/rollback-<timestamp>`）。

