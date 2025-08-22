SHELL := /bin/bash

.PHONY: dev backend frontend test

dev:
	@bash ./dev.sh

backend:
	@source venv/bin/activate && cd backend && uvicorn app.main:app --reload --port 8001

frontend:
	@cd frontend && (pnpm run dev || yarn dev || npm run dev)

test:
	@source venv/bin/activate && cd backend && pytest -q

