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

# venvの確認と有効化
if [[ ! -d "$VENV_DIR" ]]; then
  echo "[setup] venv が未作成のため作成します"
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ROOT_DIR/.env"
  set +a
fi

# 依存関係のインストール
echo "[setup] backend の依存関係をインストールします"
"$VENV_DIR/bin/python" -m pip install --upgrade pip --break-system-packages
(
  cd "$ROOT_DIR/backend"
  "$VENV_DIR/bin/python" -m pip install -e . --break-system-packages
)
requires_firestore=false
if [[ "${PERSISTENCE_BACKEND:-}" == "firestore" ]]; then
  requires_firestore=true
fi
if [[ -n "${MONSHINMATE_FIRESTORE_ADAPTER:-}" ]]; then
  requires_firestore=true
fi
if [[ "$requires_firestore" == true ]]; then
  packages=(
    "google-cloud-firestore"
    "google-cloud-secret-manager"
    "google-cloud-storage"
    "firebase-admin"
  )
  missing=()
  for pkg in "${packages[@]}"; do
    if ! "$VENV_DIR/bin/python" -m pip show "$pkg" >/dev/null 2>&1; then
      missing+=("$pkg")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "[setup] Firestore 関連依存をインストールします: ${missing[*]}"
    "$VENV_DIR/bin/python" -m pip install "${missing[@]}" --break-system-packages
  else
    echo "[setup] Firestore 関連依存は既にインストール済みです。"
  fi
fi

echo "[start] backend: http://localhost:8001"
(
  cd "$ROOT_DIR/backend"
  # ルート/.env があれば読み込んで環境変数をエクスポート
  # 開発時の非常用リセットパスワードなどを反映させるため
  set -a
  if [[ -f "$ROOT_DIR/.env" ]]; then
    # shellcheck source=/dev/null
    . "$ROOT_DIR/.env"
  fi
  # CouchDB の設定が存在する場合、疎通できないときはローカル開発向けに SQLite へフォールバック
  if [[ -n "${COUCHDB_URL:-}" ]]; then
    if ! "$VENV_DIR/bin/python" - <<'PY'
import os, sys, socket, urllib.parse
url = os.environ.get('COUCHDB_URL')
if not url:
    sys.exit(0)
try:
    u = urllib.parse.urlparse(url)
    host = u.hostname
    port = u.port or (443 if u.scheme == 'https' else 80)
    with socket.create_connection((host, port), timeout=1):
        pass
    sys.exit(0)
except Exception:
    sys.exit(1)
PY
    then
      echo "[warn] COUCHDB_URL=$COUCHDB_URL に接続できません。SQLite にフォールバックします"
      # dotenv による上書きを防ぐため空文字を明示設定
      export COUCHDB_URL=""
      export COUCHDB_DB=""
      export COUCHDB_USER=""
      export COUCHDB_PASSWORD=""
    else
      echo "[info] CouchDB に接続可能: $COUCHDB_URL"
    fi
  fi
  set +a
  exec uvicorn app.main:app --reload --port 8001
) &
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
