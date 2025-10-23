# GCP Cloud Run + Firebase 実装計画書（Draft v0）

> 対象ブランチ: `feature/cloud-run-plan`  
> 作成日: 2025-10-23  
> 目的: 既存ローカル/オンプレ環境を維持しつつ、GCP（Cloud Run + Firebase + Cloud Storage）上で MonshinMate を運用できるようにする。

---

## 0. 目的・スコープ
- **目的**
  - Cloud Run 上にバックエンド（FastAPI）・フロントエンド（静的配信）をデプロイし、Firebase（Firestore）を主データストアとして利用する。
  - ローカル開発（Docker Compose + SQLite/CouchDB）と本番（Cloud Run + Firebase）を単一リポジトリで共存させる。
- **スコープ**
  - バックエンドの永続層抽象化と Firestore 実装追加。
  - ファイル保存基盤のクラウド化（Cloud Storage 連携）。
  - フロントエンド構成の Cloud Run 対応（API エンドポイント切替）。
  - IaC/CI/CD の整備（Terraform + Cloud Build or GitHub Actions）。
- **非スコープ（本ドキュメントでは扱わない）**
  - LLM プロンプト仕様そのものの改修。
  - Firestore データの高度なアーカイブ/バックアップ自動化（別途検討）。
  - モバイルアプリや複数リージョン冗長化。

---

## 1. 現状整理と課題
- **現行構成**
  - バックエンド: FastAPI + SQLite（オプションで CouchDB）、ローカルファイルへログ／添付保存。
  - フロントエンド: Vite + Nginx（Docker Compose で backend:8001 にリバースプロキシ）。
  - 永続化: SQLite (テンプレート/回答)/CouchDB (セッション)。
- **課題**
  - Cloud Run ではコンテナファイルシステムが揮発性のため、SQLite / ローカル保存が利用できない。
  - 現行 Dockerfile は `PORT` 変数非対応、ストレージの抽象化が不足。
  - CI/CD や Cloud リソース管理が手動運用。
- **対応方針**
  - 永続層を「LocalAdapter(SQLite/CouchDB)」「FirebaseAdapter(Firestore)」に分離し、環境変数で切替。
  - ファイル保存を「LocalFileStorage」「GcsFileStorage」に抽象化。
  - Cloud Run 用の Docker stage を追加し、環境変数ベースで API エンドポイント/設定を注入。
  - Firebase（Firestore + Authentication + Storage Security Rules）の IaC 化。

---

## 2. 全体アーキテクチャ（案）
- **コンポーネント**
  1. `monshin-backend`（Cloud Run）: FastAPI。Firestore/Storage/Secret Manager へ接続。
  2. `monshin-frontend`（Cloud Run）: Nginx（Vite ビルド成果物を配信）。API エンドポイントを環境変数で指定。
  3. Firebase Firestore: 質問テンプレート、セッション、サマリなどをコレクション管理。
  4. Cloud Storage: ロゴ画像、PDF/CSV/ZIP エクスポートを保存。署名付き URL を通じてダウンロード。
  5. Secret Manager: LLM API キー、管理者初期パスワード、Firebase サービスアカウント情報。
  6. Cloud Build（もしくは GitHub Actions + gcloud）: CI/CD。テスト→ビルド→デプロイ。
  7. Firebase Authentication（任意検討）: 管理者ログインを Google OIDC へ統合する検討余地（本計画では MVP 後回し）。
- **通信フロー概要**
  - フロントエンド → Cloud Run backend: HTTPS (IAP optional)。
  - バックエンド → Firestore/Storage: Service Account + Workload Identity。
  - バックエンド → Secret Manager: 認証トークンを要求時に取得。
- **ローカル共存**
  - `.env` の `PERSISTENCE_BACKEND=sqlite` or `firestore` で切替。
  - `make dev` は既存 SQLite/CouchDB を使用、`make dev-cloud` などの新コマンドで Firestore エミュレータを起動可能にする。

---

## 3. Firestore 設計方針
- **コレクション構造（案）**
  - `questionnaireTemplates/{templateId}`: visitType 別サブコレクション `variants/{visitType}` を持ち、items / prompts / metadata を格納。
  - `sessions/{sessionId}`: 基本情報、回答、進行状態、LLM 質問、履歴をドキュメントへ集約。LLM ログは `sessions/{sessionId}/logs/{logId}` として分離。
  - `systemConfigs/{configId}`: LLM 接続や通知設定など管理画面の設定値。
  - `auditLogs/{logId}`: 監査ログ。Cloud Logging との重複を避け、長期保管が必要なイベントのみ Firestore に記録。
- **ドキュメント形式**
  - JSON 互換のスキーマに再整理し、現行 SQLite テーブルとのマッピング表を作成（別途付録予定）。
  - 日時は `Timestamp` で保存、タイムゾーンは UTC を基準にする。
- **インデックス**
  - sessions: `status`, `visitType`, `createdAt` で複合インデックスを作成。
  - auditLogs: `sessionId`, `createdAt`。
  - templates: `isDefault`, `updatedAt`。
- **Security Rules（概要）**
  - クライアント SDK から直接 Firestore にアクセスしない（バックエンドのみ）。
  - バックエンド Service Account のみ読み書き許可。手動操作用に Firebase コンソール/Emulator を使用。

---

## 4. バックエンド改修タスク
1. **設定抽象化**
   - `backend/app/config.py`（新設）で環境変数・Secret Manager から設定をロードする仕組みを追加。
   - `PERSISTENCE_BACKEND`（例: `sqlite`, `firestore`）と `FILE_STORAGE_BACKEND`（例: `local`, `gcs`）を導入。
2. **永続層インターフェース**
   - `backend/app/db/interfaces.py`（新設）で Repository/Unit of Work インターフェースを定義。
   - 現行 SQLite 実装を `backend/app/db/sqlite_adapter.py` へ切り出し。
   - Firestore 実装を `backend/app/db/firestore_adapter.py` として実装（google-cloud-firestore を使用、非同期クライアントは必要に応じ検討）。
3. **ファイルストレージ**
   - `backend/app/storage/interfaces.py` を新設し、`LocalFileStorage`（既存コード移植）と `GcsFileStorage` を実装。
   - エクスポート API は一時ファイルに書かず、GCS へのストリームアップロード→署名付き URL を返す。
4. **依存パッケージ**
   - `pyproject.toml` に `google-cloud-firestore`, `google-cloud-storage`, `google-cloud-secret-manager` を追加。
   - マルチ環境対応のため必要に応じ `firebase-admin` を追加（Service Account 認証）。
5. **起動時初期化**
   - Firestore 利用時に必要なコレクション/デフォルトテンプレートを初期投入するスクリプトを `backend/tools/init_firestore.py` として用意。
6. **ログ出力**
   - Cloud Logging 互換の JSON ログハンドラを追加し `logging` 設定を `stdout` へ統一。
7. **テスト**
   - Firestore Emulator を使った単体テストを `pytest` タグで分岐（例: `pytest -m firestore`）。
   - CI ではエミュレータを Docker サービスとして起動。

---

## 5. フロントエンド改修タスク
1. **API エンドポイント切替**
   - `frontend/src/config/api.ts`（新設）で `window.__MONSHIN_CONFIG__` の値から API Base URL を取得。
   - Vite ビルド時に `public/config.template.js` を生成し、Cloud Run 起動時に環境変数を注入して `config.js` を配信する仕組みを Nginx エントリポイントに追加。
2. **Nginx 調整**
   - `frontend/Dockerfile` をマルチステージ化し、最終ステージで `PORT` 環境変数を listen する `entrypoint.sh` を追加。
   - Cloud Run 用に API プロキシをフルパス（例: `https://backend.example.com`) へ転送。ローカル Compose 時は既存設定を維持。
3. **Firebase に依存しない UI**
   - フロント側は Firestore を直接叩かない方針のためコード変更は最小。必要に応じて「Cloud 環境専用の注意書き」を `Admin` UI に追加。
4. **CI 時のビルド検証**
   - Cloud Run 用設定で `npm run build` → `nginx -t` の lint を CI に追加。

---

## 6. インフラ・CI/CD 設計
- **IaC**
  - `infra/gcp/terraform/` を新設し、以下を管理：
    - Cloud Run サービス（backend/frontend）
    - VPC Connector（必要なら）
    - Firebase プロジェクト設定（Terraform 連携モジュール）
    - Firestore（ネイティブモード）
    - Cloud Storage バケット（`monshinmate-assets`, `monshinmate-exports`）
    - Secret Manager（LLM API キー等）
    - IAM ロール（Cloud Run SA, Cloud Build SA）
    - Cloud Monitoring アラート（エラー率、レイテンシ）
- **CI/CD**
  - Cloud Build 構成案：
    1. `pytest`（SQLite/Firestore エミュレータ両方）
    2. `npm run build`
    3. `docker buildx build`（backend / frontend）
    4. `gcloud run deploy`
  - GitHub Actions を使う場合は `workload identity federation` で GCP 認証。
- **環境管理**
  - `stg` / `prod` の Firestore プロジェクト分離。
  - Feature Flag（例: `.env.stg`, Secret Manager バージョン）で LLM 接続先や GCS バケットを分岐。

---

## 7. 移行・共存ステップ
1. **PoC フェーズ**
   - Firestore Adapter の実装と単体テスト（ローカルエミュレータ）。
   - Cloud Run backend をデプロイし `/healthz` / `/sessions` を疎通確認。
2. **ステージング構築**
   - Terraform で `stg` 環境を作成し、データ初期化スクリプトを検証。
   - GCS にテンプレートデフォルトロゴ等を事前配置。
3. **データ移行**
   - SQLite/CouchDB → Firestore への一括移行スクリプト `tools/migrate_to_firestore.py` を開発。
   - テンプレートと過去セッションのサンプリングを Firestore へ流し、整合性を確認。
4. **本番切替手順書**
   - Cutover 当日に行う手順（LLM キー設定、DNS 更新、ロールバック手順）を `internal_docs/operations/cloud_run_cutover.md` として別途作成する。
5. **ローカル環境維持**
   - `Makefile` に `make dev-firebase` と `make dev-local` のターゲット追加。
   - Cloud Run で必要な設定値は `.env.example.cloud` を新設して共有。

---

## 8. テスト戦略
- **自動テスト**
  - Unit: Firestore Adapter, GCS Storage Adapter、設定ローダ、Nginx エントリスクリプト。
  - Integration: `pytest` で Firestore Emulator + Storage Emulator を起動し、セッション登録～完了までの E2E API テストを追加。
  - Frontend: `npm run build` と `npx playwright test`（Cloud Run base URL を Stub 化）。
- **手動確認**
  - Cloud Run (stg) で患者フロー/管理フローの動作確認。
  - GCS からのエクスポートダウンロード、リンク期限確認。
- **監視検証**
  - サービスリクエストエラー率（Cloud Monitoring）のアラート動作。
  - Firestore 書き込み制限に達した際の挙動（Quota 監視）。

---

## 9. リスク・課題
- Firestore 書き込み制限やコストに対する評価不足 → 事前に想定データ量を試算する。
- 署名付き URL の有効期限管理 → フロント側で期限切れ時の再リクエストハンドリングが必要。
- LLM API キーを Secret Manager で運用する際の権限付け → 誤設定によるアクセス拒否リスク。
- Emulator と本番 Firestore の挙動差異 → TTL インデックスやセキュリティルールの検証を二重で行う。
- バックエンドの抽象化に伴うパフォーマンス影響 → キャッシュ戦略（例: Cloud Memorystore）を次フェーズで検討。

---

## 10. TODO チェックリスト（進捗管理用）
- [ ] Firestore Adapter の設計ドキュメント（API、データマッピング）を別紙にまとめる。
- [ ] `backend/app/config.py` + 抽象化層の実装。
- [ ] Google Cloud クライアントライブラリの導入と初期化処理の追加。
- [ ] Cloud Run 対応の Dockerfile 改修（backend/frontend）。
- [ ] Nginx エントリポイントでの `config.js` 動的生成。
- [ ] Terraform ひな型と CI/CD パイプラインのドラフト作成。
- [ ] Firestore / Storage Emulator を使った自動テスト整備。
- [ ] データ移行スクリプトの PoC。
- [ ] ドキュメント（README, internal_docs/implementation.md など）更新。
- [ ] Cloud Run 本番環境への試験デプロイと監視設定の確認。

---

## 付録（今後追記予定）
- SQLite ⇔ Firestore スキーママッピング表
- Cloud Run サービス別環境変数一覧
- Secret Manager に格納するキーとローテーション手順
- エラーハンドリングポリシー（Firestore 書き込み失敗時のリトライ戦略）

