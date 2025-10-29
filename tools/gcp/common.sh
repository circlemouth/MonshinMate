#!/usr/bin/env bash
set -Eeuo pipefail

MONSHINMATE_SYNCED_SECRETS=""
SECRET_VERSION_RETENTION=${SECRET_VERSION_RETENTION:-5}
SECRET_PRUNE_OLD_VERSIONS=${SECRET_PRUNE_OLD_VERSIONS:-1}

require() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    echo "[ERROR] env var $name is required" >&2
    exit 1
  fi
}

ensure_gcloud() {
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "[ERROR] gcloud not found. Install Google Cloud SDK and re-run." >&2
    exit 1
  fi
}

resolve_project() {
  if [[ -z "${PROJECT_ID:-}" ]]; then
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
  fi
  if [[ -z "${PROJECT_ID:-}" ]]; then
    echo "[ERROR] PROJECT_ID is not set and gcloud default project is empty." >&2
    exit 1
  fi
}

registry_repo() {
  # prints: <REGION>-docker.pkg.dev/<PROJECT_ID>/<REPO>
  echo "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"
}

monshinmate_repo_root() {
  if [[ -n "${MONSHINMATE_ROOT:-}" ]]; then
    printf '%s\n' "$MONSHINMATE_ROOT"
    return
  fi
  if [[ -n "${ROOT_DIR:-}" && -d "${ROOT_DIR}/backend" && -d "${ROOT_DIR}/frontend" ]]; then
    MONSHINMATE_ROOT="$ROOT_DIR"
    printf '%s\n' "$MONSHINMATE_ROOT"
    return
  fi
  if command -v git >/dev/null 2>&1; then
    local git_root
    git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
    if [[ -n "$git_root" ]]; then
      MONSHINMATE_ROOT="$git_root"
      printf '%s\n' "$git_root"
      return
    fi
  fi
  local dir
  dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
  while [[ "$dir" != "/" ]]; do
    if [[ -d "$dir/.git" || ( -d "$dir/backend" && -d "$dir/frontend" ) ]]; then
      MONSHINMATE_ROOT="$dir"
      printf '%s\n' "$dir"
      return
    fi
    dir=$(cd "$dir/.." && pwd)
  done
  MONSHINMATE_ROOT=$(pwd)
  printf '%s\n' "$MONSHINMATE_ROOT"
}

load_dotenv() {
  local env_path="${ENV_FILE:-}"
  if [[ -z "$env_path" ]]; then
    monshinmate_repo_root >/dev/null
    env_path="${MONSHINMATE_ROOT:-}/.env"
  fi
  if [[ -z "$env_path" || ! -f "$env_path" ]]; then
    return
  fi
  if [[ "${DOTENV_LOADED_PATH:-}" == "$env_path" ]]; then
    return
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_path"
  set +a
  DOTENV_LOADED_PATH="$env_path"
}

load_dotenv

_secret_id_for_key() {
  local key=$1
  local prefix=${SECRET_MANAGER_PREFIX:-monshinmate}
  local normalized
  normalized=$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')
  normalized=${normalized//_/-}
  if [[ -n "$prefix" ]]; then
    echo "${prefix}-${normalized}"
  else
    echo "$normalized"
  fi
}

_resolve_secret_project() {
  if [[ -n "${SECRET_MANAGER_PROJECT:-}" ]]; then
    SECRET_MANAGER_PROJECT_RESOLVED="$SECRET_MANAGER_PROJECT"
  elif [[ -n "${PROJECT_ID:-}" ]]; then
    SECRET_MANAGER_PROJECT_RESOLVED="$PROJECT_ID"
  fi
  if [[ -z "${SECRET_MANAGER_PROJECT_RESOLVED:-}" ]]; then
    echo "[ERROR] SECRET_MANAGER_PROJECT or PROJECT_ID must be set for secret synchronisation." >&2
    exit 1
  fi
}

sync_secret_from_env() {
  local key=$1
  local env_name=$2
  local default_value=${3:-}
  local value="${!env_name:-}"
  local using_default=0
  if [[ -z "$value" ]]; then
    value="$default_value"
    if [[ -n "$default_value" ]]; then
      using_default=1
    fi
  fi
  if [[ -z "$value" ]]; then
    echo "[WARN] Secret $key is not set and no default provided. Skipping." >&2
    return
  fi

  _resolve_secret_project
  ensure_gcloud
  local secret_id
  secret_id=$(_secret_id_for_key "$key")
  if [[ "$MONSHINMATE_SYNCED_SECRETS" == *"|$secret_id|"* ]]; then
    return
  fi

  if ! gcloud secrets describe "$secret_id" --project="$SECRET_MANAGER_PROJECT_RESOLVED" >/dev/null 2>&1; then
    echo "[INFO] Creating secret $secret_id in project $SECRET_MANAGER_PROJECT_RESOLVED"
    gcloud secrets create "$secret_id" --project="$SECRET_MANAGER_PROJECT_RESOLVED" --replication-policy=automatic >/dev/null
  fi

  if [[ $using_default -eq 1 ]]; then
    local existing_version
    existing_version=$(gcloud secrets versions list "$secret_id" --project="$SECRET_MANAGER_PROJECT_RESOLVED" --limit=1 --format="value(name)" 2>/dev/null || true)
    if [[ -n "$existing_version" ]]; then
      echo "[INFO] Secret $secret_id already has a version; skipping default override."
      MONSHINMATE_SYNCED_SECRETS="${MONSHINMATE_SYNCED_SECRETS}|$secret_id|"
      return
    fi
  fi

  printf '%s' "$value" | gcloud secrets versions add "$secret_id" --project="$SECRET_MANAGER_PROJECT_RESOLVED" --data-file=- >/dev/null
  echo "[INFO] Uploaded secret version for $secret_id"
  MONSHINMATE_SYNCED_SECRETS="${MONSHINMATE_SYNCED_SECRETS}|$secret_id|"
  if [[ "${SECRET_PRUNE_OLD_VERSIONS:-1}" == "1" ]]; then
    prune_secret_versions "$secret_id"
  fi
}

sync_default_secrets() {
  sync_secret_from_env "ADMIN_PASSWORD" "ADMIN_PASSWORD" "admin"
  sync_secret_from_env "SECRET_KEY" "SECRET_KEY"
  sync_secret_from_env "TOTP_ENC_KEY" "TOTP_ENC_KEY"
  sync_secret_from_env "LLM_API_KEY" "LLM_API_KEY" "change-me"
  sync_secret_from_env "ADMIN_EMERGENCY_RESET_PASSWORD" "ADMIN_EMERGENCY_RESET_PASSWORD"
}

prune_secret_versions() {
  local secret_id=$1
  if [[ -z "$secret_id" ]]; then
    return
  fi
  local retention="$SECRET_VERSION_RETENTION"
  if ! [[ "$retention" =~ ^[0-9]+$ ]]; then
    retention=5
  fi
  if (( retention < 1 )); then
    retention=1
  fi
  _resolve_secret_project
  ensure_gcloud
  local project="$SECRET_MANAGER_PROJECT_RESOLVED"
  local count=0
  while IFS=$'\t' read -r version state; do
    [[ -z "$version" ]] && continue
    ((count++))
    if (( count <= retention )); then
      continue
    fi
    if [[ "$state" == "enabled" ]]; then
      gcloud secrets versions disable "$version" --secret="$secret_id" --project="$project" >/dev/null
      echo "[INFO] Disabled old secret version ${version} for ${secret_id}"
    fi
  done < <(gcloud secrets versions list "$secret_id" --project="$project" --sort-by=~createTime --format='value(name,state)')
}

latest_tag_for_image() {
  local image_name=$1
  if [[ -z "$image_name" ]]; then
    echo "[ERROR] latest_tag_for_image requires image name argument" >&2
    exit 1
  fi
  require PROJECT_ID
  require REGION
  require REPO
  ensure_gcloud
  local image_path
  image_path="$(registry_repo)/${image_name}"
  gcloud artifacts docker tags list "$image_path" \
    --project="$PROJECT_ID" \
    --sort-by="~CREATE_TIME" \
    --limit=1 \
    --format="value(TAG)" | head -n1
}
