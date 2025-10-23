#!/bin/sh
set -eu

BACKEND_ORIGIN=${BACKEND_ORIGIN:-http://backend:8001}
NGINX_LISTEN_PORT=${PORT:-8080}
API_BASE_URL=${API_BASE_URL:-}

cat <<CONFIG_EOF > /usr/share/nginx/html/config.js
window.__MONSHIN_CONFIG__ = Object.assign({}, window.__MONSHIN_CONFIG__ || {}, {
  apiBaseUrl: "${API_BASE_URL}"
});
CONFIG_EOF

export BACKEND_ORIGIN
export NGINX_LISTEN_PORT
envsubst '${BACKEND_ORIGIN} ${NGINX_LISTEN_PORT}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
