# AGENTS

## 1. 文書の目的
- MonshinMate（問診メイト）の開発作業を複数エージェントで安全かつ効率的に進めるための運用指針をまとめる。
- 依頼者からの要望に揺らぎがある場合でも、ここに定義した手順と品質基準を基に判断し、作業ログやドキュメントを一貫して更新する。

## 2. コミュニケーションと対応方針
- 依頼者・ユーザーへの回答や報告は必ず日本語で行う。英語等での回答が必要な場合は事前に明示的な指示を受ける。
- 要件が不明瞭な場合は作業を進める前に確認する。確認事項は可能な限り箇条書きで整理し、前提条件も併記する。
- 仕様の根拠は `internal_docs/` や `docs/` の最新内容を優先し、過去の会話ログに依存しない。矛盾が発見された場合は `internal_docs/implementation.md` にメモを残して判断材料を共有する。

## 3. システム全体概要
- バックエンド: FastAPI（`backend/app/main.py`）。依存は `pyproject.toml` を参照。SQLite を既定とし、`COUCHDB_URL` を設定すると CouchDB にセッションデータを保存する。
- フロントエンド: React 18 + Vite + Chakra UI（`frontend/`）。TypeScript による実装。
- LLM ゲートウェイ: `backend/app/llm_gateway.py` で OpenAI 互換 API／ollama／LM Studio を扱う。プロンプト設定はテンプレート単位で保存可能。
- エクスポート: PDF/CSV/Markdown 出力、ZIP 一括出力。`backend/app/pdf_renderer.py` でレイアウトを組み立てる。
- 運用補助: `/healthz` `/readyz` `/metrics`、監査ログ、`tools/` 配下の管理スクリプト。Docker Compose で CouchDB・バックエンド・フロントエンドを同時に起動できる。

## 4. リポジトリ構成の要点
- `backend/`: FastAPI アプリケーション、DB/LLM ラッパー、`tests/` に pytest 一式。
- `frontend/`: Vite プロジェクト。`src/` に患者向け・管理向け UI。ビルド成果物は `dist/`。
- `docs/`: 公開向け仕様書（例: `session_api.md`）。
- `internal_docs/`: 社内向け詳細ドキュメント。本ファイル、`plannedSystem.md`、`implementation.md` などを常に参照・更新する。
- `tools/`: `export_public.sh` などの補助スクリプト。
- `dev.sh` / `dev.ps1` / `Makefile`: ローカル開発用の起動・テストコマンド集。
- `docker-compose.yml`: CouchDB + backend + frontend の統合環境。

## 5. 開発環境の準備と起動
### 5.1 共通前提
- 必須バージョン: Python 3.11 以上、Node.js 18 以上、npm または pnpm/yarn。Docker Compose はオプション。
- Python の依存関係は必ず仮想環境（`python -m venv venv`）にインストールする。共有環境にグローバルインストールしない。
- `.env` は `backend/.env` を基点に作成し、機密情報はコミットしない。

### 5.2 バックエンド
```bash
cd backend
python -m venv ../venv
source ../venv/bin/activate  # Windows は venv\Scripts\activate
pip install --upgrade pip
pip install -e .
uvicorn app.main:app --reload --port 8001
```
- 初期起動後、`curl http://localhost:8001/healthz` で正常応答 (`{"status":"ok"}`) を確認する。
- 環境変数の主な項目: `ADMIN_PASSWORD`, `SECRET_KEY`, `TOTP_ENC_KEY`, `COUCHDB_URL`, `COUCHDB_USER`, `COUCHDB_PASSWORD`。本番想定では必ず強度の高い値を設定する。

### 5.3 フロントエンド
```bash
cd frontend
npm install
npm run dev
```
- Vite の開発サーバは `http://localhost:5173`。バックエンドへの API プロキシは `vite.config.ts` で定義済み。
- ビルド確認は `npm run build`、静的確認は `npm run preview`。

### 5.4 Docker Compose
```bash
docker compose up -d
```
- `backend` はポート 8001、`frontend` は 5173、`couchdb` は 5984 を公開する。
- 管理画面（Fauxton）は `http://localhost:5984/_utils`。既定ユーザーは compose で `admin/admin` をセット。

## 6. 作業プロセス
- 作業を始める前に関連ドキュメント（`internal_docs/plannedSystem.md`, `internal_docs/implementation.md`, `docs/`）を確認し、既存仕様と整合性があるかを把握する。
- 新規作業ではブランチを分け、Issue/Ticket 番号をブランチ名・コミットメッセージに含める（例: `feature/123-add-session-filter`).
- 実装内容が決まったら `internal_docs/implementation.md` にチェックボックス形式で進捗を追記し、判断経緯や未解決事項を残す。
- 仕様変更・デザイン変更が発生した場合は `plannedSystem.md` または該当する設計書を更新し、差分箇所を依頼者に報告する。
- Python/TypeScript のコードでは可読性を優先し、複雑な処理には短いコメントを添える。不要なコメントは追加しない。

## 7. コーディングおよび品質基準
- Python: 型ヒントを維持し、共通処理はユーティリティ化する。ログは `logging` を使い、PII（個人情報）は平文で出力しない。
- TypeScript: 既存の Chakra UI コンポーネント構成を踏襲し、`src` 以下の状態管理（React Query 等）に大きな変更を加える際は事前相談する。
- テンプレートや LLM プロンプトを変更する場合は、UI だけでなくバックエンドの保存ロジックへの影響を確認する。
- 例外処理や API レスポンスは FastAPI/Pydantic のバリデーション結果を尊重して実装し、400/422/500 系のエラーを明確に区別する。

## 8. テスト・動作確認
- バックエンド単体テスト: `make test` または `source venv/bin/activate && cd backend && pytest -q`。
- 静的検証: `cd frontend && npm run build`（TypeScript コンパイルを兼ねる）。必要に応じて `npx tsc --noEmit` で追加チェックを行う。
- API 動作確認: `curl` あるいは `httpie` 等で `/healthz`, `/admin/login`, `/sessions` をスポットチェックする。
- Playwright MCP: 利用可能な環境では UI 回帰テストは MCP 経由で必ず実施する。
  - 手順例: `make dev` でバックエンド・フロントエンドを起動 → Playwright MCP で `http://localhost:5173` に接続 → 患者フロー（初診登録→問診回答→完了画面）と管理フロー（`/admin/login` → テンプレート編集 → セッション詳細参照）を自動化シナリオとして実行する。
  - Playwright MCP のシナリオが未整備な場合は、まずシナリオを作成してリポジトリに保存し、次回以降再利用できるようにする。
- Playwright MCP を利用できない場合は、ブラウザでの手動確認または `curl`/`httpx` を用いた一連の API テストを実施し、実施内容と結果をレポートに明記する。
- 重大な修正時は CouchDB が有効な構成でも疎通確認を行う（`docker compose up couchdb` → `COUCHDB_URL` 設定 → `pytest`）。

## 9. セキュリティとデータ取り扱い
- デフォルト管理者パスワード (`ADMIN_PASSWORD`) は初回起動後ただちに変更する。非常用リセット (`ADMIN_EMERGENCY_RESET_PASSWORD`) を設定する場合も扱いには注意する。
- `TOTP_ENC_KEY` を設定し、`backend/tools/encrypt_totp_secrets.py` を用いて既存シークレットを暗号化する場合は作業前に DB をバックアップする。
- 開発中に得た患者データは原則モックデータを使用する。実データを扱う場合は社内規定に従い、作業完了後は速やかに消去する。
- ログ出力 (`backend/app/logs/`) と監査テーブルを併せて確認し、異常があれば対応を記録する。

## 10. ドキュメント更新
- `docs/`（公開向け）と `internal_docs/`（社内向け）で内容が二重管理されているため、更新時は両方の整合性を必ず確認する。
- 公開用に成果物をまとめるときは `make export-public` あるいは `bash tools/export_public.sh public_export` を使用し、内部資料が混入しないようにする。
- UI やワークフローを変更した場合は `docs/admin_user_manual.md` と `docs/session_api.md` の該当箇所を更新する。

## 11. 納品前チェックリスト
- [ ] コード・設定の変更内容を説明できるか（Why/How を整理済みか）。
- [ ] バックエンドの pytest が成功しているか（ログを添えて報告）。
- [ ] フロントエンドのビルドが成功し、必要に応じて Playwright MCP で UI 動作確認を完了したか。
- [ ] 必要なドキュメント（`implementation.md` ほか）が最新化されているか。
- [ ] 環境変数やシークレットの扱いについて注意喚起を行ったか。
- [ ] 依頼者への報告内容が日本語で、確認事項・既知の制約・今後のTODOを明示しているか。
