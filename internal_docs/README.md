非公開ドキュメント（internal_docs）について

このフォルダは GitHub で公開する必要のない社内・開発者向けドキュメントを集約するために作成しました。公開用ドキュメントは引き続き `docs/` 配下に置き、設計・運用・LLM連携の詳細や作業ログなど秘匿性の高い情報は本フォルダに移動しています。

移動した主なファイル一覧（2025-08-31 時点）
- AGENTS.md（開発エージェント向け運用指針）
- plannedSystem.md（システム全体設計）
- PlannedDesign.md（UI設計ガイド）
- LLMcommunication.md（LLM入出力契約/プロンプト設計）
- implementation.md（実装状況チェックリスト／更新ログ）
- implementation_cloud_run_firebase.md（Cloud Run + Firebase 実装計画）
- admin_system_setup.md（管理/運用向けセットアップ）
- docker_setup.md（開発/運用向け Docker 手順）

注意事項
- 本フォルダは原則として非公開リポジトリでのみ管理してください。
- 公開リポジトリへ反映する場合は、内容の公開可否を再確認し、必要に応じて要約版のみを `docs/` 側に配置してください。
- `docs/` に残したプレースホルダ（移動案内）から、本フォルダ内の同名ファイルに誘導しています。

---

公開用エクスポートの使い方（公開レポ作成手順）

この非公開リポジトリから、公開してよい成果物のみを抽出して新規の公開用レポジトリを作る手順です。履歴は持ち込みません（スナップショット公開）。

1) 依存関係と前提
- 本リポジトリは private を維持します（`internal_docs/` はこのまま Git 管理対象）。
- 公開には `tools/export_public.sh` を使用します。
- Makefile のターゲット `export-public` からも実行できます。

2) 実行コマンド例
- 直接スクリプト実行:
  - `bash tools/export_public.sh public_export`
- Makefile 経由:
  - `make export-public`

3) 出力
- `public_export/` ディレクトリが生成され、以下を含みます:
  - ルート: `LICENSE`, `README.md`, `Makefile`, `docker-compose.yml`, `dev.sh`, `dev.ps1`
  - プロダクト: `backend/`, `frontend/`
  - 公開用ドキュメント: `docs/admin_user_manual.md`, `docs/session_api.md`
- 含まれないもの（自動で除外）:
  - `internal_docs/`, `wrapper/`, `.pytest_cache/`, `venv/`, `.git/` など

4) 公開レポジトリへの初回 push
- `cd public_export`
- `git remote add origin <public-repo-url>`
- `git branch -M main && git push -u origin main`

5) 運用ノート
- 公開対象の調整は `tools/export_public.sh` を編集して行います。
- 非公開情報を誤って公開しないため、`internal_docs/` は「非公開リポでは Git 管理するが、公開物には含めない」方針です。
- 公開側 README に非公開ドキュメントへのリンクを張る場合、社内ポータルや別 private リポへの導線を用いてください（直接のファイル参照は不可）。
