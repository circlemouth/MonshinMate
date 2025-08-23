# 問診メイト

問診メイト は、問診票のテンプレート管理・患者回答の収集・LLM を使った追質問と要約を行う、最小構成のローカル実行システムです。バックエンドは FastAPI、フロントエンドは React (Vite + Chakra UI) で構成されています。

## できること
- 問診テンプレートの CRUD（ID と受診種別ごとに管理）
- 患者回答のセッション管理（追質問の提示、最終要約の生成）
- LLM 設定の取得・更新・疎通テスト（現状はスタブ実装）

## 前提環境
- Python 3.11 以上（バックエンド）
- Node.js 18 以上（フロントエンド開発用）。パッケージマネージャは npm/yarn/pnpm いずれか

## クイックスタート（バックエンド）
1) 仮想環境を作成・有効化し依存をインストール
- macOS/Linux: `python3 -m venv venv && source venv/bin/activate`
- Windows (PowerShell): `py -3 -m venv venv; venv\Scripts\Activate.ps1`
- 依存インストール: `pip install -r <(cd backend && python - <<'PY'\nimport tomllib,sys;print('\n'.join(tomllib.load(open('backend/pyproject.toml','rb'))['project']['dependencies']))\nPY)`
  - もしくは単純に `pip install fastapi uvicorn httpx pytest` を実行

2) API を起動
- `cd backend`
- `uvicorn app.main:app --reload`（デフォルトで `http://localhost:8001`）
  - 初回アクセス時に `backend/app/app.sqlite3` が作成されます（テンプレートテーブルを自動初期化）

3) 動作確認
- `curl http://localhost:8001/healthz` → `{ "status": "ok" }`
- `curl 'http://localhost:8001/questionnaires/default/template?visit_type=initial'`

4) テスト実行
- `cd backend && pytest`
- 非同期テストが必要な場合は `pip install pytest-asyncio` を追加してください

## クイックスタート（フロントエンド）
1) 依存インストール
- `cd frontend && npm install`（または `pnpm install` / `yarn`）

2) バックエンドへのプロキシ設定（推奨）
- Dev サーバーから API を叩くため、以下のように `frontend/vite.config.ts` を調整します。

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/questionnaires': 'http://localhost:8001',
      '/sessions': 'http://localhost:8001',
      '/llm': 'http://localhost:8001',
      '/healthz': 'http://localhost:8001',
      '/readyz': 'http://localhost:8001',
      '/metrics': 'http://localhost:8001',
    },
  },
});
```

3) 開発サーバー起動
- 別ターミナルでバックエンドを起動した状態で、`cd frontend && npm run dev`
- ブラウザで `http://localhost:5173` を開きます
  - 「問診フォーム」「管理画面」「LLM チャット」から各機能を確認できます

## 一括起動（バックエンド+フロントエンド）
- ルートの `dev.sh` (Unix系) または `dev.ps1` (Windows) で両方を同時起動できます
- Unix系環境では `make dev` も利用できます

```bash
# Unix系
chmod +x dev.sh && ./dev.sh
# Windows
powershell -File dev.ps1
# もしくは Make を使用 (Unix系)
make dev
```

- バックエンド: `http://localhost:8001`
- フロントエンド: `http://localhost:5173`
- 停止は Ctrl-C（両プロセスをまとめて終了）

## 主要エンドポイント（抜粋）
- `GET /healthz`: 死活監視
- `GET /readyz`: 依存疎通の簡易チェック（DB/LLM）
- `GET /questionnaires/{id}/template?visit_type=initial|followup`: テンプレ取得（未登録時は既定テンプレを返却）
- `POST /questionnaires` (body: `{ id, visit_type, items[] }`): テンプレ作成/更新
- `GET /questionnaires`: テンプレ id と visit_type の一覧
- `DELETE /questionnaires/{id}?visit_type=...`: テンプレ削除
- `POST /sessions` (body: `{ patient_name, dob, visit_type, answers{} }`): セッション作成
- `POST /sessions/{session_id}/answer` (body: `{ item_id, answer }`): 回答を保存し、追質問を返却
- `POST /sessions/{session_id}/finalize`: 要約を生成して返却
- `GET /llm/settings` / `PUT /llm/settings` / `POST /llm/settings/test`: LLM 設定の取得・更新・疎通

## データベース
- SQLite を使用（ファイル: `backend/app/app.sqlite3`）。環境変数 `MONSHINMATE_DB` でパス上書き可能
- アプリ起動時（FastAPI startup）にテンプレート用テーブルを自動作成
- テスト環境など startup が走らない場合でも、テンプレ取得時にフォールバックを実装済み

## 開発の流れと参考資料
- 設計や仕様の背景は `docs/` を参照
  - 実装状況は `docs/implementation.md` のチェックリストを更新
- 作業時の方針
  - コードやドキュメントは原則日本語で記述
  - 変更後は `cd backend && pytest` でテストを通す

## よくある質問
- フロントから API に届かない: Vite のプロキシ設定が未設定の可能性。上記の `vite.config.ts` を設定してください
- 既定テンプレはどこから来る？: アプリ起動時に `default/initial` と `default/followup` を投入します（不足時は固定の最小テンプレでフォールバック）
- LLM は本当に使われる？: 現状はスタブ実装で、固定応答・簡易な追質問/要約を返します

## ライセンス
- 本リポジトリには明示ライセンス記載がないため、私的開発用途を想定しています（必要に応じて追加してください）
