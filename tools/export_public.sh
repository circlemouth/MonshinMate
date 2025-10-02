#!/usr/bin/env bash
# 公開用エクスポートスクリプト
# - private リポジトリから "公開可能なファイルだけ" を抽出して新しい Git リポジトリを作る
# - 履歴は持ち越さず、単一の初回コミット（必要に応じて手動で push）
#
# 使い方:
#   bash tools/export_public.sh [出力ディレクトリ名]
# 例:
#   bash tools/export_public.sh public_export

set -euo pipefail

TARGET_DIR=${1:-public_export}

echo "[export_public] 出力先: ${TARGET_DIR}"
if [ -e "${TARGET_DIR}" ]; then
  echo "[export_public] 既存の ${TARGET_DIR} を削除します" >&2
  rm -rf "${TARGET_DIR}"
fi
mkdir -p "${TARGET_DIR}"

# 1) ルート直下の公開ファイル
cp -a LICENSE "${TARGET_DIR}/" 2>/dev/null || true
cp -a README.md "${TARGET_DIR}/" 2>/dev/null || true
cp -a Makefile "${TARGET_DIR}/" 2>/dev/null || true
cp -a docker-compose.yml "${TARGET_DIR}/" 2>/dev/null || true
cp -a dev.sh "${TARGET_DIR}/" 2>/dev/null || true
cp -a dev.ps1 "${TARGET_DIR}/" 2>/dev/null || true

# 2) backend と frontend（そのまま公開）
cp -a backend "${TARGET_DIR}/backend"
cp -a frontend "${TARGET_DIR}/frontend"

# 3) docs は公開対象のみ個別コピー
mkdir -p "${TARGET_DIR}/docs"
for f in admin_user_manual.md session_api.md; do
  if [ -f "docs/${f}" ]; then
    cp -a "docs/${f}" "${TARGET_DIR}/docs/${f}"
  fi
done

# 4) 不要・内部向けの痕跡を除去（保守用: 念のため）
rm -rf "${TARGET_DIR}/internal_docs" 2>/dev/null || true
rm -rf "${TARGET_DIR}/wrapper" 2>/dev/null || true
rm -rf "${TARGET_DIR}/.git" 2>/dev/null || true
rm -rf "${TARGET_DIR}/.pytest_cache" 2>/dev/null || true
rm -rf "${TARGET_DIR}/venv" 2>/dev/null || true

# 5) 新規 Git 初期化（履歴を持ち込まない）
(
  cd "${TARGET_DIR}"
  git init -q
  git add .
  git commit -q -m "Initial public export"
  echo
  echo "[export_public] 公開用リポジトリを初期化しました。"
  echo "  - ディレクトリ: ${TARGET_DIR}"
  echo "  - 例: cd ${TARGET_DIR} && git remote add origin <public-repo> && git push -u origin main"
)

echo "[export_public] 完了"

