#!/usr/bin/env bash
set -Eeuo pipefail

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

