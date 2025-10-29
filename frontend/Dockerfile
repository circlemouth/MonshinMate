# フロントエンドをビルドして配信するコンテナ
FROM node:18 AS build
WORKDIR /app
# 依存をインストール
COPY frontend/package*.json ./
RUN npm install
# ソースをコピーしてビルド
COPY frontend ./
RUN npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache gettext

RUN mkdir -p /etc/nginx/templates

# ビルド成果物を配置
COPY --from=build /app/dist /usr/share/nginx/html

# ランタイム生成用のテンプレートとスクリプトをコピー
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY frontend/scripts/entrypoint.sh /entrypoint.sh

# config.js のデフォルト値（ビルド成果物に含まれているが念のためコピー）
COPY frontend/public/config.js /usr/share/nginx/html/config.js

RUN chmod +x /entrypoint.sh

ENV BACKEND_ORIGIN=http://backend:8001
ENV PORT=8080

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
