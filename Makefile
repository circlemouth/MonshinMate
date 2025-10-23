SHELL := /bin/bash

IMAGE_TAG ?= latest
BACKEND_IMAGE ?= monshinmate-backend
FRONTEND_IMAGE ?= monshinmate-frontend

.PHONY: dev backend frontend test submodules export-public docker-build-backend docker-build-frontend docker-build docker-push-backend docker-push-frontend docker-push

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

docker-build-backend:
	@docker build -f backend/Dockerfile -t $(BACKEND_IMAGE):$(IMAGE_TAG) .

docker-build-frontend:
	@docker build -f frontend/Dockerfile -t $(FRONTEND_IMAGE):$(IMAGE_TAG) .

docker-build: docker-build-backend docker-build-frontend

docker-push-backend:
	@docker push $(BACKEND_IMAGE):$(IMAGE_TAG)

docker-push-frontend:
	@docker push $(FRONTEND_IMAGE):$(IMAGE_TAG)

docker-push: docker-push-backend docker-push-frontend
