FROM caddy:2-alpine

COPY deploy/Caddyfile /etc/caddy/Caddyfile
# 只發布網站資產，不提供 README、測試、後端檔案或 .env。
COPY frontend/index.html /srv/
COPY frontend/styles /srv/styles
COPY frontend/pages /srv/pages
COPY frontend/src /srv/src

# 部署版本資訊：由 deploy/hd build 傳入，覆寫 src/version.js（版本控制中的檔案各欄為 null，代表本機開發）；
# 管理頁用它和後端回報的版本比對，前後端不是同一次 build 時會提示。值只允許英數與 . _ / -，避免寫出無效的 JavaScript。
ARG GIT_TAG=""
ARG GIT_COMMIT=""
ARG GIT_BRANCH=""
LABEL GIT_TAG="${GIT_TAG}" GIT_COMMIT="${GIT_COMMIT}" GIT_BRANCH="${GIT_BRANCH}"
RUN set -eu; \
    for value in "$GIT_TAG" "$GIT_COMMIT" "$GIT_BRANCH"; do \
      case "$value" in *[!A-Za-z0-9._/-]*) echo "版本參數含不允許的字元：$value" >&2; exit 1;; esac; \
    done; \
    quote() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }; \
    printf '// 由 deploy/web.Dockerfile 在建置時產生\nexport const WEB_VERSION = Object.freeze({ tag: %s, commit: %s, branch: %s });\n' \
      "$(quote "$GIT_TAG")" "$(quote "$GIT_COMMIT")" "$(quote "$GIT_BRANCH")" > /srv/src/version.js
