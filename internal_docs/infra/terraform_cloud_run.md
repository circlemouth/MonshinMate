# Cloud Run Terraform / CI/CD Draft

## 1. Terraform Modules (Plan)
- **Project Layout**
  - `infra/gcp/terraform/environments/{stg,prod}`: environment-specific variables.
  - `infra/gcp/terraform/modules/cloud_run_backend`: builds backend service, service account, IAM bindings, Secret Manager access.
  - `infra/gcp/terraform/modules/cloud_run_frontend`: builds frontend service, static env vars (BACKEND_ORIGIN), Cloud CDN (optional).
  - `infra/gcp/terraform/modules/firestore`: enables Firestore native mode, indexes (managed via `indexes.json`).
  - `infra/gcp/terraform/modules/storage`: provision buckets `monshinmate-assets`, `monshinmate-exports`。
  - `infra/gcp/terraform/modules/monitoring`: Cloud Monitoring alert policies (error rate, latency) + uptime checks.

- **Variables**
  - `project_id`, `region`, `backend_image`, `frontend_image`, `secret_prefix`, `llm_default_provider` 等を `tfvars` で管理。
  - `secrets` map で Secret Manager 連携（例: `admin_password_secret = "monshinmate-admin-password"`).

- **Outputs**
  - Cloud Run URLs, Firestore project info, bucket names, alert policy IDs。

## 2. Secrets Handling
- Terraform は Secret Manager のシークレット本体を管理せず、参照のみ行う。
- `google_secret_manager_secret` リソースで prefix + key を作成、`google_secret_manager_secret_version` はローカル `tfvars` から初期値を投入するか、手動登録を前提とする。
- IAM: backend サービスアカウントへ `roles/secretmanager.secretAccessor` を付与。

## 3. Cloud Build / GitHub Actions Draft
- **Trigger**: main ブランチ push, タグ push (prod), PR でプレビュー。
- **Stages**
  1. `pip install -e backend` + `npm ci`、`pytest -m "not e2e"`、Firestore エミュレータ付きで `pytest backend/tests/test_firestore_adapter.py`。
  2. `npm run build`（frontend）、`npm run lint` (optional)。
  3. `docker buildx build` backend/frontend イメージ（BuildKit + cache）、`docker push` to Artifact Registry。
  4. `gcloud run deploy` backend/frontend （`--image` 指定, `--set-env-vars` で `BACKEND_ORIGIN`, `SECRET_MANAGER_ENABLED=1`, etc）。
  5. `terraform apply` (manual approval step) for infrastructure drift correction。

- **Workload Identity Federation** で GitHub -> GCP 認証。
- Cloud Build trigger alternative: Cloud Build YAML with `substitutions` for environment, plus manual approval step before production deploy。

## 4. Pending Tasks
- Write actual Terraform manifests under `infra/gcp/terraform/`。
- Add GitHub Actions workflow (`.github/workflows/deploy.yml`) referencing this pipeline。
- Document manual rollback (`gcloud run services update-traffic` 等)。
