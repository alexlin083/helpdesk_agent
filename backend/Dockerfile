# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && mkdir -p /app/storage && chown node:node /app/storage

# 明確列出執行所需檔案，避免把本機 .env、工作單與測試放入 image。
COPY config ./config
COPY controllers ./controllers
COPY middleware ./middleware
COPY routes ./routes
COPY services ./services
COPY utils ./utils
COPY data/accounts.json data/departments.json ./data/
COPY index.js server.js routes.js docker-healthcheck.js ./

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "docker-healthcheck.js"]
# 直接執行 Node，讓 SIGTERM 能交給既有的優雅關機流程。
CMD ["node", "index.js"]
