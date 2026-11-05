# syntax=docker/dockerfile:1
# 釘選 Node patch 版本：better-sqlite3 13 需要 Node-API 10（Node 22.14 以上），與 .nvmrc 一致。
FROM node:22.23.4-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
# 原生 SQLite 模組安裝時會呼叫 node-gyp；在建置期間提供工具，完成後移除以縮小正式 image。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev && npm cache clean --force \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/storage && chown node:node /app/storage

# 明確列出執行所需檔案，避免把本機 .env、工作單與測試放入 image。
COPY src ./src
COPY scripts ./scripts
# 規則設定檔（部門、需求類型目錄與各類型定義）在啟動時驗證；人員資料（帳號、部門歸屬、員工與額度）只存在 SQLite，
# 全新資料庫由程式內的示範名冊寫入一次。資料庫不放入 image。
COPY data/departments.json ./data/
COPY data/requestTypes ./data/requestTypes
COPY docker-healthcheck.js ./
# 建置時確認原生 SQLite 驅動可在此映像載入，避免部署後才在第一次存取時失敗。
RUN node -e "const D=require('better-sqlite3');new D(':memory:').close()"

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "docker-healthcheck.js"]
# 直接執行 Node，讓 SIGTERM 能交給既有的優雅關機流程。
CMD ["node", "src/index.js"]
