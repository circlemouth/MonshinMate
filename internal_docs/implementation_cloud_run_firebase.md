# Cloud Run + Firebase 実装メモ

Cloud Run および Firestore を用いた実装記録は、非公開サブモジュール側に移行しました。本リポジトリには概要のみを残し、詳細手順・Terraform・CI/CD 設定は `private/` 配下のサブモジュールドキュメントを参照してください。

- 参照先例: `private/cloud-run-adapter/docs/implementation_cloud_run_firebase.md`
- ローカル環境では `PERSISTENCE_BACKEND=sqlite` を既定とし、Cloud Run 版を利用する場合はプラグインの導入後に `MONSHINMATE_FIRESTORE_ADAPTER` を設定してください。
