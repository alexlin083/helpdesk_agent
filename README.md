# 企業智慧服務台 Agent

員工在提出需求單頁填好主題後按「自動生成」，在對話視窗中由 AI 判斷需求類型與處理部門、依需要查詢公司資料（例如可擔任代理人的同事、本人的假別剩餘時數），確認該類型需要的資料（例如請假的日期、時間、假別與同部門代理人，或設備申請的品項、數量與需要日期），整理好的需求內容套用後直接送到確認的部門；需求內容在套用前唯讀，套用後可在固定格式文字前後補充說明；送達部門的成員負責簽核、退回、轉單或取消；後端仍保留不經「自動生成」的送單方式（直接指定處理人，或由 AI 判斷部門）供 API 用戶端使用，頁面已不使用

需求類型由設定檔驅動：程式不寫死任何類型，請假申請、打卡補登、VPN 申請、報修、設備申請、採購申請與一般需求各自只用 `backend/data/requestTypes/` 的一個 JSON 檔定義，新增類型只要加 JSON 檔（見[需求類型與 AI 資料來源規範](docs/需求類型與AI資料來源規範.md)）；AI 預設使用 Gemini（`GEMINI_API_KEY`），`backend/.env` 另有 Claude 金鑰（`ANTHROPIC_API_KEY`）時，Gemini 這一回合失敗（額度、過載、逾時或回應異常）會自動改用 Claude；沒有設定金鑰時，自動生成仍可在視窗右側的欄位手動填寫

依《開發規格書 v1.0.3》與後續需求，前端共有四個頁面：管理頁、登入頁、提出需求單頁（含「自動生成」對話視窗）、狀態追蹤頁（追蹤、簽核、轉單、取消與簽核紀錄查詢）；後端提供登入、健康檢查、部門與處理人名單、需求單送出與 AI 判斷部門、需求單查詢與部門簽核，以及提出需求單頁的「自動生成」對話；送單方式、需求類型與簽核規則見 [API 介面規格書](docs/企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)

後端是 Node.js 22 的 Express 5 API（ES Modules，程式放在 `backend/src/`），需求單、員工與假別時數存在 SQLite；前端是原生 HTML／CSS／JavaScript（ES module），不使用框架，沒有需要安裝的 npm 依賴；AI 供應商、切換條件與沒有金鑰時的行為見 API 介面規格書第 1 節「AI 供應商」

## 專案架構

```text
helpdesk_agent/
├── README.md、AGENTS.md          專案總覽與開發約定
├── compose.yaml、.env.example     Docker Compose 與其參數範本（.env 不提交）
├── .nvmrc、.gitignore、.dockerignore
├── docs/                          API 規格書、需求類型與 AI 資料來源規範、Docker 與 Lightsail 部署手冊
├── deploy/                        Caddyfile 與前端（web）映像的 Dockerfile
├── backend/
│   ├── src/                       後端程式：index.js（啟動）、server.js、config、controllers、
│   │                              middleware、routes（index.js 為 /api 總入口）、services
│   │                              （storage/ 儲存、personnel/ 人員、ai/ AI 供應商與部門判斷、
│   │                              admin/ 管理、requestTypes/ 需求類型通用引擎）、utils
│   ├── scripts/                   維運腳本：人員資料（personnel.js）、舊資料匯入、匯出、備份、還原
│   ├── data/                      規則設定檔：部門 departments.json、需求類型 requestTypes/
│   │                              （_catalog.json 與七種類型的定義檔；人員資料不在這裡）
│   ├── storage/                   本機的 helpdesk.db（與容器的 /app/storage 同名；內容不提交 Git）
│   ├── tests/
│   └── Dockerfile、docker-healthcheck.js、.env.example
└── frontend/
    ├── index.html                 登入頁
    ├── pages/                     propose（提出需求單）、tickets（狀態追蹤）、admin（管理頁），各含 HTML 與頁面 CSS
    ├── styles/                    共用樣式：base.css、login.css、layout.css
    ├── src/                       頁面腳本、元件與 API 服務
    └── tests/
```

後端各模組的職責見[後端說明](backend/README.md)「架構」，前端的目錄與檔案分工見[前端說明](frontend/README.md#頁面目錄)

## 本機啟動

統一使用 Node.js 22.23.4：根目錄與 `backend/` 的 `.nvmrc` 都指定 `22.23.4`；後端 `engines` 為 `>=22.14.0 <23`，因為 better-sqlite3 13.0.3 需要 Node-API 10（Node 22.14 以上），前端 `engines` 維持 `22.x`（只用於執行測試）；better-sqlite3 套件內附預先編譯的二進位檔，不需另裝編譯工具

1. 後端（第一個終端機）：使用 nvm（含 Windows 版）時先切換版本，再安裝套件；可用 `node --version` 確認目前版本

   ```bash
   cd backend
   ```

   ```bash
   nvm install 22.23.4
   nvm use 22.23.4
   ```

   ```bash
   npm ci
   ```

   複製 `backend/.env.example` 為 `backend/.env`，填入自己的密碼與金鑰（不要提交），再啟動：

   ```bash
   npm run dev
   ```

   `npm run dev` 執行 `node --watch src/index.js`（修改程式後自動重啟）；不需要自動重啟時用 `npm start`（`node src/index.js`）；後端監聽 http://localhost:3000，未設定 `NODE_ENV` 時預設為 `local`，第一次啟動會在 `backend/storage/helpdesk.db` 建立資料庫

   確認後端可用（`<PASSWORD>`、`<token>` 為佔位文字，請自行替換，勿提交實際值；`handler_id` 是處理人的帳號名稱，這種只指定處理人的送單方式保留給 API 用戶端）：

   ```bash
   curl http://localhost:3000/api/health
   curl -X POST http://localhost:3000/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"username":"racky.huang","password":"<PASSWORD>"}'
   curl http://localhost:3000/api/departments -H 'Authorization: Bearer <token>'
   curl -X POST http://localhost:3000/api/tickets \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer <token>' \
     -d '{"subject":"VPN 帳號申請","content":"新進同仁需要 VPN 連線權限","handler_id":"racky.huang"}'
   ```

2. 前端（第二個終端機）：靜態伺服器必須在 frontend 目錄啟動

   ```bash
   cd frontend
   ```

   執行 `npm run dev`，也就是 `node scripts/dev-server.js`：只提供 frontend 目錄的檔案、監聽 localhost:5173，每個回應都帶 `Cache-Control: no-cache`（與正式環境的 Caddy 相同），修改 CSS／JS 後一般重新整理就會載入新檔；macOS、Linux、Windows 都用同一個指令，不需要 Python

   ```bash
   npm run dev
   ```

   之前用 `py -m http.server 5173`（或 `python3 -m http.server`）啟動的話，Python 伺服器不送快取標頭，瀏覽器可能沿用舊的 CSS／JS；請停止它改用 `npm run dev`，或在瀏覽器按 Ctrl + F5 強制重新整理；若瀏覽器看到整個專案的檔案清單而不是登入頁，代表啟動位置錯了，按 Control + C 停止後改在 frontend 目錄重啟

3. 瀏覽器開啟 http://localhost:5173（登入頁 `index.html`）；必須用 `localhost`（後端 CORS 預設只允許這個來源），不可用 `127.0.0.1`，也不可直接雙擊 HTML 以 `file://` 開啟；登入後的頁面在 `pages/` 底下，例如 http://localhost:5173/pages/propose/propose.html、`/pages/tickets/tickets.html`、`/pages/admin/admin.html`

測試：在 `backend/` 與 `frontend/` 各執行 `npm test`（都不呼叫 Claude 或 Gemini）；測試範圍與項數見[部署手冊](docs/Docker與Lightsail部署操作手冊.md)第 11 節

人員資料以 `backend/scripts/personnel.js` 調整部門、新增或停用人員、設定假別額度，變更不需重啟（步驟見[後端說明](backend/README.md)「人員資料」）；資料庫、示範名冊與帳號對應見 [API 介面規格書](docs/企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md) 第 2.1 節與第 3.4、3.6 節

維運腳本在 `backend/` 目錄以 `node scripts/<檔名>.js` 執行，例如 `node scripts/db-backup.js <備份檔路徑>`，說明見[後端說明](backend/README.md#維運腳本)。

以 Docker Compose 在本機驗證時，複製根目錄 `.env.example` 為 `.env`（與 `backend/.env` 分開），再依[部署手冊](docs/Docker與Lightsail部署操作手冊.md)第 2 節執行；網站位於 http://localhost:8080/helpdesk/，頁面網址為 `/helpdesk/pages/...`，例如 `/helpdesk/pages/propose/propose.html`、`/helpdesk/pages/tickets/tickets.html`、`/helpdesk/pages/admin/admin.html`；這個模式不用另外執行後端 `npm start` 或前端 `npm run dev`，頁面的設定模組依自身位置推導出 `/helpdesk/api`（公開網址須加 `/helpdesk`，例如 `/helpdesk/api/health`），首頁 `/` 暫時導向 `/helpdesk/`；原本 localhost:5173 的開發方式仍保留，該模式連 localhost:3000

建立雲端資源與購買網域由操作者依部署手冊執行；專案加入設定檔不代表已完成雲端部署

## 文件

| 文件 | 內容 |
| --- | --- |
| [API 介面規格書](docs/企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md) | 前後端 API 合約、畫面行為、錯誤碼與實作狀態（含歷史紀錄）；完整規格以這份規格書與開發規格書為準；需求類型、自動生成、假別時數的合約與「自動生成」視窗見第 3.15～3.18 節 |
| [需求類型與 AI 資料來源規範](docs/需求類型與AI資料來源規範.md) | 「自動生成」使用的需求類型設定：`_catalog.json` 與各類型定義檔怎麼寫、每個鍵的意思、欄位型別、能力、AI 可以查哪些資料以及權限怎麼限制，最後以 `equipment.json`（設備申請）一步一步示範新增需求類型 |
| [Docker 與 Lightsail 部署操作手冊](docs/Docker與Lightsail部署操作手冊.md) | 正式部署、更新、備份、還原與回滾 |
| [後端說明](backend/README.md) | 入門說明：架構、環境參數、維運腳本、日誌排查 |
| [前端說明](frontend/README.md) | 前端目錄、頁面網址與各檔案的分工 |
| [開發約定](AGENTS.md) | 機密資訊、函式文件與 API 規格同步的規則 |
