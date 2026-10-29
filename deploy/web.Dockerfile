FROM caddy:2-alpine

COPY deploy/Caddyfile /etc/caddy/Caddyfile
# 只發布網站資產，不提供 README、測試、後端檔案或 .env。
COPY frontend/*.html frontend/*.css /srv/
COPY frontend/src /srv/src
COPY frontend/admin /srv/admin
COPY frontend/tickets /srv/tickets
COPY frontend/shared /srv/shared
