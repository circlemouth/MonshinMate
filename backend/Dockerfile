# バックエンドAPIを提供するコンテナ
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app
# ソースコードをコピー
COPY backend /app
# 汎用 SQLite/CouchDB イメージ。クラウド専用構成は非公開アダプタ側で管理する。
RUN python -m venv /venv \
    && . /venv/bin/activate \
    && pip install --no-cache-dir -r requirements.lock \
    && pip install --no-cache-dir --no-deps -e .
# PATH を仮想環境に設定
ENV PATH="/venv/bin:$PATH"

RUN adduser --disabled-password --gecos '' appuser \
    && chown -R appuser:appuser /app /venv

USER appuser

ENV PORT=8001
EXPOSE 8001
# Uvicorn でアプリを起動（PORT 環境変数に対応）
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8001}"]
