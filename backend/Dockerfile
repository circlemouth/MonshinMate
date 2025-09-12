# バックエンドAPIを提供するコンテナ
FROM python:3.11-slim

WORKDIR /app
# ソースコードをコピー
COPY backend /app
# 依存を仮想環境にインストール
RUN python -m venv /venv \
    && . /venv/bin/activate \
    && pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -e .
# PATH を仮想環境に設定
ENV PATH="/venv/bin:$PATH"
EXPOSE 8001
# Uvicorn でアプリを起動
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
