SHELL := /bin/bash

.PHONY: dev backend frontend test submodules export-public

dev:
	@bash ./dev.sh

backend:
	@source venv/bin/activate && cd backend && uvicorn app.main:app --reload --port 8001

frontend:
	@cd frontend && (pnpm run dev || yarn dev || npm run dev)

test:
	@source venv/bin/activate && cd backend && pytest -q

submodules:
	@git submodule update --init --recursive

# 公開用エクスポート（internal_docs を含めない）
export-public:
	@bash tools/export_public.sh public_export
