#!/usr/bin/env bash
# システム全体を一括起動するスクリプト
# - バックエンド: FastAPI(Uvicorn)
# - フロントエンド: Vite(React)

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)
VENV_DIR="$ROOT_DIR/venv"

cleanup() {
  # バックグラウンド起動したプロセスを終了
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" || true
  fi
}
trap cleanup EXIT INT TERM

# venv と最小依存確認（存在しなければ作成）
if [[ ! -x "$VENV_DIR/bin/uvicorn" ]]; then
  echo "[setup] venv が未作成のため作成します"
  python3 -m venv "$VENV_DIR"
  source "$VENV_DIR/bin/activate"
  python -m pip install --upgrade pip
  # 最小限の依存をインストール（必要に応じて拡張）
  pip install fastapi uvicorn httpx
else
  source "$VENV_DIR/bin/activate"
fi

echo "[start] backend: http://localhost:8001"
(
  cd "$ROOT_DIR/backend"
  exec uvicorn app.main:app --reload --port 8001 &
BACKEND_PID=$!

echo "[start] frontend: http://localhost:5173"
(
  cd "$ROOT_DIR/frontend"
  # npm/pnpm/yarn のいずれかが使える前提。
  if command -v pnpm >/dev/null 2>&1; then
    echo "[setup] frontend の依存関係をインストールします (pnpm)"
    pnpm install
    exec pnpm run dev
  elif command -v yarn >/dev/null 2>&1; then
    echo "[setup] frontend の依存関係をインストールします (yarn)"
    yarn install
    exec yarn dev
  else
    echo "[setup] frontend の依存関係をインストールします (npm)"
    npm install
    exec npm run dev
  fi
) &
FRONTEND_PID=$!

echo "[ready] Ctrl-C で両方のプロセスを終了します"

# どちらかのプロセスが終了するまで待機
while kill -0 "$BACKEND_PID" >/dev/null 2>&1 && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; do
  sleep 1
done

