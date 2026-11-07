FROM caddy:2-alpine

COPY deploy/Caddyfile /etc/caddy/Caddyfile
# 只發布網站資產，不提供 README、測試、後端檔案或 .env。
COPY frontend/index.html /srv/
COPY frontend/styles /srv/styles
COPY frontend/pages /srv/pages
COPY frontend/src /srv/src
