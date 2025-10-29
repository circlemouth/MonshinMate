# Firestore Adapter Design

この文書の詳細版は Cloud Run/Firestore 用の非公開サブモジュールに移動しました。

- Firestore 向けの永続化アダプタ実装、データマッピング、テスト手順は `private/` サブモジュール側の `docs/firestore_adapter_design.md` を参照してください。
- 本リポジトリではローカル（SQLite/CouchDB）向けの説明のみを維持します。Firestore バックエンドを利用する場合は、プライベートモジュールを追加し、`MONSHINMATE_FIRESTORE_ADAPTER` 環境変数を適切に設定してください。
