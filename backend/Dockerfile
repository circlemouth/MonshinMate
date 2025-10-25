# バックエンドAPIを提供するコンテナ
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app
# ソースコードをコピー
COPY backend /app
# GCP 用のプライベートアダプタはサブモジュール側の Dockerfile/Cloud Build で同梱します
# 依存を仮想環境にインストール
# ENABLE_GCP=1 のときのみ GCP 依存を追加インストール（デフォルト 0 で軽量化）
ARG ENABLE_GCP=0
RUN python -m venv /venv \
    && . /venv/bin/activate \
    && pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -e . \
    && if [ "$ENABLE_GCP" = "1" ]; then \
         pip install --no-cache-dir \
           google-cloud-firestore \
           google-cloud-secret-manager \
           google-cloud-storage \
           firebase-admin \
       ; fi
# PATH を仮想環境に設定
ENV PATH="/venv/bin:$PATH"

RUN adduser --disabled-password --gecos '' appuser \
    && chown -R appuser:appuser /app /venv

USER appuser

ENV PORT=8001
EXPOSE 8001
# Uvicorn でアプリを起動（PORT 環境変数に対応）
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8001}"]
