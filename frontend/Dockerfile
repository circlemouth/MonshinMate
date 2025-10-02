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
# ビルド成果物を配置
COPY --from=build /app/dist /usr/share/nginx/html
# バックエンドへのリバースプロキシ設定
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
