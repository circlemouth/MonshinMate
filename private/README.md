# Cloud Run / Firestore プライベートモジュール配置ガイド

この `private/` ディレクトリは、Google Cloud Run + Firestore 向けの非公開サブモジュールを配置するためのプレースホルダです。クラウド環境関連の実装は本リポジトリから切り離されているため、商用利用時は新しいプライベートリポジトリを作成し、以下の要領でサブモジュールとして組み込んでください。

## 推奨ディレクトリ構成

```text
MonshinMate/
├── private/
│   └── cloud-run-adapter/  # ← 非公開サブモジュール（例）
```

## サブモジュール登録例

```bash
git submodule add git@github.com:your-org/monshinmate-cloud-run-adapter.git private/cloud-run-adapter
git submodule update --init --recursive
```

> **補足**: リモート URL は各組織のプライベートリポジトリに置き換えてください。サブモジュールのブランチ管理や CI/CD は各自のポリシーに従って運用します。

## プラグイン実装の要件

サブモジュールには少なくとも次の Python 実装を含めてください。

- `monshinmate_cloud.firestore_adapter.FirestoreAdapter`
  - `backend/app/db/interfaces.PersistenceAdapter` プロトコルを満たすこと。
  - 旧 `FirestoreAdapter` と同じ API を提供すれば、既存コード側の変更は不要です。
- `monshinmate_cloud.secret_manager.load_secrets`
  - シグネチャ: `load_secrets(default_keys: list[str], extra_keys: list[str] | None) -> dict[str, str]`
  - 返り値は取得したシークレットの辞書。必要に応じて環境変数への反映も行ってください。

プラグインのモジュール名は環境変数で上書きできます。

```bash
# 例: サブモジュール内で monshinmate_cloud パッケージを提供する場合
echo 'MONSHINMATE_FIRESTORE_ADAPTER=monshinmate_cloud.firestore_adapter:FirestoreAdapter' >> backend/.env
echo 'MONSHINMATE_SECRET_MANAGER_ADAPTER=monshinmate_cloud.secret_manager:load_secrets' >> backend/.env
```

## ローカル開発との共存

- `.env` に `PERSISTENCE_BACKEND=sqlite` を設定すれば、プラグインが無くても従来通りのローカル開発が可能です。
- Cloud Run デプロイ用の設定や IaC はサブモジュール側に配置し、公開リポジトリには含めないでください。

## ドキュメント

Cloud Run/Firestore に関する手順書や設計資料もサブモジュール内に移し、本リポジトリでは概要のみを記載する方針としてください。
