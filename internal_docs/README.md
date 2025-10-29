非公開ドキュメント（internal_docs）について

このフォルダは GitHub で公開する必要のない社内・開発者向けドキュメントを集約するために作成しました。公開用ドキュメントは引き続き `docs/` 配下に置き、設計・運用・LLM連携の詳細や作業ログなど秘匿性の高い情報は本フォルダに移動しています。

移動した主なファイル一覧（2025-08-31 時点）
- AGENTS.md（開発エージェント向け運用指針）
- plannedSystem.md（システム全体設計）
- PlannedDesign.md（UI設計ガイド）
- LLMcommunication.md（LLM入出力契約/プロンプト設計）
- implementation.md（実装状況チェックリスト／更新ログ）
- implementation_cloud_run_firebase.md（Cloud Run + Firebase 実装計画：詳細は private サブモジュールへ移管済み）
- admin_system_setup.md（管理/運用向けセットアップ）
- docker_setup.md（開発/運用向け Docker 手順）

注意事項
- 本フォルダは原則として非公開リポジトリでのみ管理してください。
- 公開リポジトリへ反映する場合は、内容の公開可否を再確認し、必要に応じて要約版のみを `docs/` 側に配置してください。
- `docs/` に残したプレースホルダ（移動案内）から、本フォルダ内の同名ファイルに誘導しています。

---

公開用スナップショット作成（任意作業）

リポジトリ自体は現在公開運用ですが、配布物を最小構成でまとめたい場合は `tools/export_public.sh` を使ってスナップショットを生成できます。生成したディレクトリは一時的なものなので、利用後は削除してください（Git には含めない）。

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
- 指定した出力先（例: `public_export/`）が生成され、以下を含みます:
  - ルート: `LICENSE`, `README.md`, `Makefile`, `docker-compose.yml`, `dev.sh`, `dev.ps1`
  - プロダクト: `backend/`, `frontend/`
  - 公開用ドキュメント: `docs/admin_user_manual.md`, `docs/session_api.md`
- 含まれないもの（自動で除外）:
  - `internal_docs/`, `wrapper/`, `.pytest_cache/`, `venv/`, `.git/` など

4) 公開レポジトリへの初回 push（必要な場合のみ）
- `cd public_export`
- `git remote add origin <public-repo-url>`
- `git branch -M main && git push -u origin main`

5) 運用ノート
- 公開対象の調整は `tools/export_public.sh` を編集して行います。
- スクリプトで生成したディレクトリは Git の管理対象にしないでください（必要なタイミングで再生成する）。
- 非公開情報を誤って公開しないため、サブモジュール `private/cloud-run-adapter` や `internal_docs/` はスナップショットから除外されます。
