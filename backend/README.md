# Backend

Node.js 22（Express 5）後端 API，使用 ES Modules，程式放在 `src/`；需求單、員工與假別時數存在 SQLite，前端是原生 HTML／CSS／JavaScript（見[前端說明](../frontend/README.md)）；本文件說明後端的架構與模組、環境參數、日誌、維運腳本用法與關機流程
API 合約與畫面行為（登入、限流配額、AI 供應商、部門、需求單、自動生成、假別時數、管理 API、SQLite 儲存與錯誤處理）見 [API 介面規格書](../docs/企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)；需求類型的檔案格式與現有類型見[需求類型與 AI 資料來源規範](../docs/需求類型與AI資料來源規範.md)；專案總覽與本機快速啟動見[根目錄 README](../README.md)；Docker 與 Lightsail 部署見 [Docker 與 Lightsail 部署操作手冊](../docs/Docker與Lightsail部署操作手冊.md)

## 架構

```text
backend/
├── src/
│   ├── index.js                     # 啟動：先驗證需求類型定義，再開啟資料庫並匯入舊檔，最後監聽 port；註冊關機訊號、關閉伺服器與資料庫
│   ├── server.js                    # Express app、全域 middleware（只建立 app，不監聽；測試直接匯入）
│   ├── config/
│   │   └── env.js                   # 載入 backend/.env（僅 local）與驗證環境參數（含 TRUST_PROXY）
│   ├── routes/
│   │   ├── index.js                 # /api 路由總入口：/health、/auth、/departments、/forms、/tickets、/me、/leave
│   │   ├── authRoutes.js            # /auth：登入
│   │   ├── departmentRoutes.js      # /departments：部門與處理人名單
│   │   ├── requestTypeRoutes.js     # /forms：需求類型清單
│   │   ├── ticketRoutes.js          # /tickets：送出、自動生成（/draft）、查詢、簽核、轉單、取消
│   │   ├── meRoutes.js              # /me：本人的假別時數（/leave-balance）
│   │   ├── leaveRoutes.js           # /leave：人資查詢與調整假別時數（/balances、/adjustments）
│   │   └── adminRoutes.js           # /admin：管理監測與重置（自行掛載限流與 JSON 解析，由 server.js 直接掛載）
│   ├── controllers/
│   │   ├── ticketController.js      # 需求單：送出（含 form／department_id）、我的需求單、部門待簽核、已完成查詢、簽核／退回、轉單、取消
│   │   ├── departmentController.js  # 部門與處理人名單（GET /api/departments）
│   │   ├── requestTypeController.js # 需求類型清單（GET /api/forms）與「自動生成」對話（驗證請求後交給通用引擎 draftEngine）
│   │   └── leaveController.js       # 本人假別時數、人資查詢與調整（讀取使用 leave_entitlements 的需求類型與通用額度帳）
│   ├── middleware/
│   │   ├── closeOnShutdown.js       # 關機中的回應加上 Connection: close
│   │   ├── requestLogger.js         # 請求開始／完成日誌與 requestId
│   │   ├── originGuard.js           # 選用的代理來源秘密（X-Origin-Verify）
│   │   ├── authenticate.js          # Bearer 憑證驗證
│   │   ├── authorize.js             # requireUser／requireAdmin 角色檢查
│   │   ├── rateLimiter.js           # HTTP 限流（express-rate-limit、有界記憶體儲存）
│   │   └── errorHandler.js          # 404 與統一錯誤 JSON（含 400／413／415 用戶端錯誤對應）
│   ├── services/
│   │   ├── authService.js           # 密碼比對、JWT；帳號名單取自 accountService
│   │   ├── usageService.js          # 冷卻、並行租約、每日配額、登入失敗計數
│   │   ├── departmentService.js     # 載入並驗證部門設定檔（不含處理人）
│   │   ├── taskTracker.js           # 需求單工作追蹤器，供關機與管理重置等待
│   │   ├── storage/                 # 儲存層：
│   │   │   ├── dataStore.js         #   需求單儲存單例：all／find／insert（可帶交易內 guard）／update、clear、stats（監測用各狀態筆數）、通用額度帳 withLedger／ledgerBalances／addLedgerAdjustment（交易內 ledgerOverlaps／ledgerBusy）、額度異動紀錄（insert／update／addLedgerAdjustment 在同一筆交易內寫入，ledgerLog 讀取）、listAccounts／findAccount／departmentAccounts／listEmployees／findEmployee、prepare（啟動時開啟資料庫、全新資料庫寫入名冊並匯入舊檔）、close；每個操作一筆 SQLite 交易；前端不直接接觸 SQLite，所有讀寫都經後端 HTTP API 進入這個單例持有的唯一連線（啟動時於監聽前開啟）；better-sqlite3 為同步 API，每個操作在事件迴圈上以一筆完整交易執行完畢、彼此不會交錯，因此只有一個寫入者，不需要另外排隊
│   │   │   ├── database.js          #   SQLite 連線、PRAGMA、schema 遷移（目前版本 4，含請假額度異動紀錄 leave_log 的建立與回填）、額度表允許清單 LEDGER_TABLES、舊版 JSON 匯入、匯出、備份與還原
│   │   │   └── limitStore.js        #   限制儲存：單程序記憶體（含管理重置）；重啟即歸零，不能當作永久費用上限；只適用單一程序與單副本，多個 instance 不會共用，不支援多副本或 PM2 cluster；管理重置只清除目前執行環境，不操作其他 instance 或 AWS 資源
│   │   ├── personnel/               # 人員資料（只存在 SQLite）：
│   │   │   ├── accountService.js    #   帳號查詢（SQLite accounts 資料表，每次呼叫重新查詢）；啟用中的一般帳號即可指定的處理人
│   │   │   ├── accountDirectory.js  #   組出對外的帳號身分（附所屬部門）
│   │   │   ├── employeeService.js   #   員工基本資料與假別額度查詢（SQLite employees、leave_entitlements）
│   │   │   ├── personnel.js         #   人員資料驗證規則、全新資料庫寫入名冊、維運操作（服務與 scripts/personnel.js 共用）
│   │   │   └── demoPersonnel.js     #   示範人員名冊（假資料；只在全新資料庫或版本 2 升級時使用）
│   │   ├── ai/                      # AI 供應商與部門判斷：
│   │   │   ├── providers.js         #   先用主要供應商（預設 Gemini），這一回合失敗（不論原因）時改用有金鑰的備援（預設 Claude）
│   │   │   ├── claudeShared.js      #   Claude 呼叫共用：伺服器端 fallback 參數、取出回應文字、判斷輸出是否沒有正常完成
│   │   │   ├── ticketJudge.js       #   需求單判斷部門：共用流程（期限、日誌、75 分分流）＋ Gemini 呼叫
│   │   │   └── ticketJudgeClaude.js #   需求單判斷部門的 Claude 呼叫
│   │   ├── admin/                   # 管理功能：
│   │   │   ├── adminService.js      #   管理重置（維護鎖內清空需求單與保護計數）
│   │   │   └── adminMetrics.js      #   管理監測快照（唯讀）
│   │   ├── requestTypes/            # 需求類型通用引擎（不含任何類型專屬的程式）：
│   │   │   ├── registry.js          #   載入並驗證 _catalog.json 與各定義檔；提供 GET /api/forms 的形狀（forClient）、自動生成回應的類型（draftView）、交給 AI 的完整定義（aiView）、關鍵字備援（match）
│   │   │   ├── fieldTypes.js        #   欄位型別（self、enum、text、number、date、datetime、account、department）的定義驗證、值的整理（例如 2026/12/1 9:30 → 2026-12-01T09:30）與檢查
│   │   │   ├── capabilities.js      #   具名能力：計算 work_minutes、檢查 ledger_balance／ledger_overlap，以及工具的伺服器端執行與存取規則
│   │   │   ├── renderer.js          #   需求內容範本 {名稱|篩選器:參數} 與篩選器 date、time、date_range、hours_minutes、default
│   │   │   ├── evaluator.js         #   依定義驗證欄位、產生候選、執行計算與檢查、渲染內容、檢核清單
│   │   │   ├── draftEngine.js       #   「自動生成」對話流程（分類 → 填寫 → 伺服器驗證；API 規格書第 3.16 節）
│   │   │   ├── aiAssistant.js       #   Gemini 呼叫：分類一次、填寫為工具階段（function calling，最多 3 次）＋整理階段；整回合 20 秒；兩家共用的回合守衛
│   │   │   ├── claudeAssistant.js   #   Claude 呼叫：與 Gemini 版相同的流程（tool use、output_config 結構化輸出、effort low）
│   │   │   └── workflow.js          #   送出、簽核與轉單時依定義執行的規則（API 規格書第 3.3、3.7、3.9 節）
│   └── utils/                       # logger（JSON 日誌與遮蔽）、agentDeadline（上游逾時）、dates（台北日期、時間格式）、punctuation（AI 輸出的句號「。」：句中改成「；」、句尾刪除）、shutdown（連線追蹤、優雅關機、訊號處理）
├── scripts/                         # 維運腳本：人員資料、請假紀錄查詢、舊檔匯入、匯出 JSON、線上備份、停機還原（一併複製進映像檔）；eval-classification.js 與 lib/ 為分類評測（開發用）
├── evals/classification-cases.json  # 分類評測題庫（不複製進映像檔）
├── data/                            # 規則設定檔（部門與需求類型，提交 Git）；人員資料不在這裡，只存在 SQLite
│   ├── departments.json             # 部門設定檔（八個部門：部門、業務說明、關鍵字）
│   ├── requestTypes/                # 需求類型（規則設定，提交 Git，整個資料夾複製進映像檔）
│   │   ├── _catalog.json            #   目錄：AI 共通指示、類型清單（摘要與關鍵字）、default_type、AI 工具與存取規則
│   │   ├── leave.json               #   請假申請 v2（人力資源部；欄位、工作日曆、請假時數、額度帳與檢查、固定文字、流程）
│   │   ├── attendance.json          #   打卡補登 v1（人力資源部；示範用預設值）
│   │   ├── vpn.json                 #   VPN 申請 v1（資訊管理一部；示範用預設值）
│   │   ├── repair.json              #   報修 v1（總務與硬體組；示範用預設值）
│   │   ├── equipment.json           #   設備申請 v1（總務與硬體組；示範用預設值）
│   │   ├── purchase.json            #   採購申請 v1（採購部；示範用預設值）
│   │   └── general.json             #   一般需求 v1（沒有專用定義的需求；部門由對話決定）
├── storage/                         # 執行期資料（與容器的 /app/storage 同名）；目錄本身以 .gitkeep 提交，內容都不提交 Git、不放進映像檔
│   ├── helpdesk.db                  # 本機 SQLite 資料庫（執行後產生，內容見 API 規格書第 3.4 節）；含需求單原文，不放進部署包；連同 -wal／-shm、還原保留的 .before-restore-*、.restore-tmp 與匯出的 tickets*.json 都不提交 Git
│   └── tickets.json                 # 舊版 JSON 需求單檔（若有），不提交 Git；用途見 API 規格書第 3.4 節
├── tests/                           # 自動化測試（npm test）；涵蓋範圍見部署操作手冊；各測試檔共用的環境參數在 helpers/testEnv.js
├── Dockerfile、docker-healthcheck.js、.dockerignore   # 後端映像檔，見部署操作手冊
├── .env                             # 本機設定（npm start／npm run dev 使用；Compose 不讀它），不提交 Git
└── .env.example                     # 不含金鑰的設定範本
```

需求單流程：`src/server.js → src/routes/index.js → src/routes/ticketRoutes.js → src/controllers/ticketController.js`；送出時決定送達方式、儲存與「自動生成」的處理流程見 API 規格書第 3.3、3.4、3.16 節
「自動生成」以 AI 工具查詢公司資料：資料由伺服器依權限查出來後交給 AI，而不是寫死在程式的流程裡，這就是本系統的 RAG
健康檢查與登入直接寫在路由或簡單處理器中；部門名單與業務邏輯較多的 API 拆成 controller 與 service

整個專案的目錄樹見[根目錄 README](../README.md)「專案架構」，前端的目錄見[前端說明](../frontend/README.md)

## 啟動

後端為 Node.js 22.23.4 單一程序（根目錄與 backend 的 `.nvmrc`、映像檔都固定 `22.23.4`），負責登入、需求單、管理與限量限流；backend `engines` 為 `>=22.14.0 <23`，因為 better-sqlite3 13.0.3 需要 Node-API 10（Node 22.14 以上）；frontend `engines` 維持 `22.x`，只用於執行前端測試
安裝與啟動指令（nvm、`npm ci`、`npm run dev`、`npm start`）見[根目錄 README](../README.md) 的「本機啟動」；測試與驗證範圍見[部署操作手冊](../docs/Docker與Lightsail部署操作手冊.md)；第一次啟動建立資料庫、寫入示範人員名冊與匯入舊檔的規則見 API 規格書第 3.4、3.6 節
`src/config/env.js` 只在 local 模式讀取 `backend/.env`（與從哪個目錄啟動無關）。將 `.env.example` 的設定填入現有 `.env`，保留自己的真實金鑰：

```dotenv
PORT=3000
CORS_ORIGIN=http://localhost:5173
AI_PROVIDER=gemini
GEMINI_API_KEY=<請填入自己的 Gemini 金鑰>
GEMINI_MODEL=gemini-3.5-flash
# 選填：主要供應商 Gemini 失敗時改用 Claude（切換條件見下方參數表的 ANTHROPIC_API_KEY）
ANTHROPIC_API_KEY=<選填，Claude 金鑰>
ANTHROPIC_MODEL=claude-sonnet-5-5
DEMO_PASSWORD=<請填入私下提供的一般登入密碼>
ADMIN_PASSWORD=<請填入獨立管理密碼，不得與一般密碼相同>
```

`CORS_ORIGIN` 設為實際前端網址（格式見下方參數表）
AI 供應商的選擇、備援的切換條件與期限、模型需求、Claude 的呼叫細節，以及未設定金鑰時各功能的行為，見 API 規格書第 1 節「AI 供應商」與第 3.16 節；修改 `.env` 後重新啟動伺服器（`npm run dev` 只監看程式檔，不會因 `.env` 變更而重啟）

## 登入、限流與配額

帳號、登入與憑證的規則見 API 規格書第 2.1 節，限流與配額的完整規則見第 2.2 節；這裡只列後端的環境參數

| 環境參數 | 預設 | 用途 |
| --- | --- | --- |
| `NODE_ENV` | local | 只接受 local 或 production；必須由 shell 或部署平台設定（寫在 `backend/.env` 不會改變模式），production 完全不讀 `.env` |
| `PORT` | 3000 | 監聽埠，1～65535 的整數 |
| `CORS_ORIGIN` | `http://localhost:5173`（僅 local） | 瀏覽器開啟前端的 origin，不含頁面路徑、`/helpdesk` 或結尾斜線；production 必填，正式值為網站的 HTTPS origin（例如 `https://alex-lin-lab.com`） |
| `AI_PROVIDER` | `gemini` | AI 主要供應商：`gemini` 或 `anthropic`，其他值啟動失敗；判斷部門與「自動生成」共用；另一家有金鑰時為備援；production 只要求主要供應商的金鑰，備援的金鑰可以不設 |
| `GEMINI_API_KEY` | 無（僅 local 可留空） | Gemini 金鑰；主要供應商為 Gemini 時 production 必填 |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Gemini 模型，請填已驗證可用且支援 function calling 的名稱 |
| `ANTHROPIC_API_KEY` | 無 | Claude 金鑰；選填，有填時作為備援：「自動生成」在主要供應商這一回合因 `RATE_LIMIT_EXCEEDED`、`AI_UPSTREAM_ERROR`、`AI_INVALID_RESPONSE`、`AI_TIMEOUT` 任一原因失敗時改用備援，AI 判斷部門在上游回 429 或 500 時改用備援，切換後 60 秒內直接用備援（`src/services/ai/providers.js`）；`AI_PROVIDER=anthropic` 時改為主要供應商、production 必填 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Claude 模型 |
| `LOG_LEVEL` | info | debug、info、warn、error 或 silent |
| `AUTH_SECRET` | 本機自動產生並保存在 SQLite、production 必填 | 至少 32 bytes 的隨機簽章金鑰，多個 instance 必須相同 |
| `AUTH_TTL_SECONDS` | 7200 | 憑證有效秒數 |
| `DEMO_PASSWORD` | 必填，無預設值 | 16 個一般帳號共用的課堂密碼，僅存於未追蹤的 .env 或平台環境參數 |
| `ADMIN_PASSWORD` | 必填，無預設值 | 應用程式管理員的獨立密碼，不得與 `DEMO_PASSWORD` 相同；不是 AWS IAM 密碼 |
| `DATABASE_FILE` | `storage/helpdesk.db` | 需求單 SQLite 資料庫檔的絕對路徑；留空使用預設。所在目錄必須已存在（不自動建立）；新檔在 SQLite 開啟前先以 600 權限建立，之後產生的 `-wal`／`-shm` 也沿用 600 |
| `TICKETS_FILE` | `storage/tickets.json` | 舊版 JSON 需求單檔的絕對路徑，只作匯入與回滾的來源，服務不會寫入；留空使用預設 |
| `SHUTDOWN_TIMEOUT_MS` | 75000 | 關機最多等待既有需求單與租約清理的毫秒數，至少 30000（自動生成一回合的 20 秒期限加 10 秒；下限原為 25000，一回合期限改為 20 秒時提高為 30000，compose.yaml 固定 75000 不受影響） |
| `LIMIT_STORE` | memory | local 與 production 都只允許 memory；重啟及管理重置會歸零 |
| `ORIGIN_VERIFY_SECRET` | 無 | 可選代理來源秘密，設定後至少 32 bytes；目前 Compose 強制停用（固定為空，避免舊 CloudFront 參數阻擋同站點 API），功能保留供其他拓撲使用：啟用時除 `GET /api/health` 外的 API（含 OPTIONS）需由代理附上 `X-Origin-Verify`，一般瀏覽器不持有來源秘密 |
| `TRUST_PROXY` | 不信任代理（未設定或空白） | 依實際代理鏈填信任的跳數（純十進位整數）、`loopback`／`linklocal`／`uniquelocal`，或以逗號分隔的 IP／CIDR；啟動時以 proxy-addr 2.0.8（Express 使用的同一套件，後端已明列為直接相依）編譯驗證，`true`／`false`（不分大小寫）與無法解析的值會讓後端拒絕啟動，錯誤訊息不回顯原值 |

限流與配額參數（`CHAT_COOLDOWN_SECONDS`、`USER_DAILY_LIMIT`、`GLOBAL_DAILY_LIMIT`、`GLOBAL_CONCURRENCY`、`LOGIN_FAILURE_LIMIT`、`LOGIN_WINDOW_SECONDS`、`LOGIN_ACCOUNT_FAILURE_LIMIT`、`LOGIN_ACCOUNT_WINDOW_SECONDS`、`HTTP_RATE_WINDOW_SECONDS`、`HTTP_RATE_MAX_KEYS`、`HTTP_API_LIMIT`、`HTTP_LOGIN_LIMIT`、`HTTP_TICKET_LIMIT`、`HTTP_DEPARTMENTS_LIMIT`、`HTTP_QUERY_LIMIT`、`HTTP_DRAFT_LIMIT`、`DRAFT_USER_DAILY_LIMIT`、`DRAFT_GLOBAL_DAILY_LIMIT`）的預設值與用途見 API 規格書第 2.2 節；Docker Compose 使用的參數見「正式環境與部署」

未設定 `AUTH_SECRET` 時本機簽章金鑰的產生與保存方式見 API 規格書第 2.1 節；也可以自行產生隨機值放入 `.env`（優先使用），勿提交或分享：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 需求單 API、部門設定檔與人員資料

部門設定檔、需求單 API（送出、查詢、簽核、轉單、取消）與 SQLite 儲存的完整規則見 API 規格書第 3.1～3.11 節，人員資料的資料表與規則見第 3.6 節

- 啟動時匯入舊版 `tickets.json`（`TICKETS_FILE`）的判斷規則見第 3.4 節；匯入紀錄為 `source: "none"`（初始化時沒有舊檔）而之後才出現 `tickets.json` 時，確認要匯入再執行 `node scripts/import-legacy-tickets.js --import-late`（可先加 `--dry-run` 預覽）：只有資料表為空時才匯入並以 tickets.json 紀錄取代 none 紀錄，否則以 `LEGACY_CONFLICT` 拒絕
- 任何失敗都記錄 `storage.failed` 並以結束碼 1 結束，不開始監聽；成功記錄 `storage.ready`，需要提醒時另記 warn `storage.legacy_warning`（欄位見「日誌與排查」）

## 需求類型與自動生成

需求類型的檔案格式、每個鍵的意義、現有七種類型的內容、修改既有類型的規則與新增類型的步驟見[需求類型與 AI 資料來源規範](../docs/需求類型與AI資料來源規範.md)；`GET /api/forms`、「自動生成」對話 `POST /api/tickets/draft`、AI 工具與假別時數 API 的合約見 API 規格書第 3.15～3.17 節

- 需求類型定義驗證錯誤時記錄 `request_types.failed`（`reason: REQUEST_TYPES_INVALID`，`detail` 含檔名與鍵路徑，例如 `equipment.json fields[2].type 未知的欄位型別「slider」…`）並以結束碼 1 結束，成功記錄 `request_types.ready`（`types`、`defaultType`、`catalogVersion`）；修改定義後的重啟與重新建置規則見規範文件第 2 節
- 通用引擎在 `src/services/requestTypes/`，不含任何類型的 id、欄位 key 或領域用語；`tests/requestTypes.test.js` 會掃描 `src/` 確認（資料庫結構、人員資料與人資假別 API 不在掃描範圍）。新增類型只需新增 JSON 檔並在目錄加一筆，不改程式（`tests/draftFlow.test.js` 以一個只存在測試中的 `overtime.json` 驗證）。需要新的欄位型別、計算或檢查能力時才改程式，並同步更新規範文件。
- 分類評測：`npm run eval:classify` 以 `evals/classification-cases.json` 的題目量測第一回合分類（類型、部門、混淆、邊界題、多輪是否一致）；使用的 AI 供應商與備援、`--provider`、`--offline` 等選項，以及如何依結果修改摘要見規範文件第 15 節

## API 端點

業務 API 的端點總表、請求與回應見 API 規格書第 1 節與第 2、3 節，錯誤回應格式、錯誤代碼與用戶端錯誤的對應見第 4 節；這裡只列不屬於業務 API 的兩項

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 檢查伺服器是否運作；不需要認證，回 `{ "success": true, "data": { "status": "ok" } }`；只驗證 HTTP 程序，不檢查 AI 連線，也不能證明需求單寫入正常 |
| OPTIONS | 所有路徑 | CORS 預檢，由 middleware 處理；允許 GET、POST、OPTIONS |

各環境的基礎 API 網址見 API 介面規格書第 1 節
本文件與 API 規格書列出的 `/api/...` 為 Express 內部路徑，Docker 與正式環境的公開網址須加 `/helpdesk`（例如公開健康端點為 `/helpdesk/api/health`）；JSON 請求、回應及驗證規則不變

## 正式環境與部署

只區分 `NODE_ENV=local` 與 `NODE_ENV=production`，不接受第三種模式，模式須設定在 shell 或平台；本機預設 local，讀取 `backend/.env`，shell 參數優先；正式環境完全不讀 `.env`，必須由平台設定主要 AI 供應商的金鑰（預設 `GEMINI_API_KEY`；`AI_PROVIDER=anthropic` 時為 `ANTHROPIC_API_KEY`；另一家的金鑰選填，作為備援）、`CORS_ORIGIN`、`AUTH_SECRET`（至少 32 bytes）、`DEMO_PASSWORD`、獨立的 `ADMIN_PASSWORD`；正式服務也不要以本機模式啟動來規避必要設定，測試則使用隔離的 local 參數及假密碼

部署架構、映像檔內容、volume、版本升級與回滾、備份與還原的完整步驟見 [Docker 與 Lightsail 部署操作手冊](../docs/Docker與Lightsail部署操作手冊.md)；Compose 與反向代理對 API 的限制見 API 規格書第 3.13 節

要回滾到先前的 JSON 版映像時，先以 `scripts/export-tickets-json.js` 匯出目前的需求單，因為 volume 內原本的 `tickets.json` 只含遷移當時的資料

### Docker Compose 的環境參數（根目錄 `.env`）

Compose 的參數來源是專案根目錄未追蹤的 `.env`（或 `HELPDESK_ENV_FILE` 指定的檔案），與 `backend/.env` 分開：

- 根目錄 `.env.example` 是 Docker 參數範本；先確認根目錄沒有既有 `.env`（避免覆蓋設定），再複製成 `.env` 私下填寫，不提交 Git
- `backend/.env` 保留給 `npm start`／`npm run dev`（`node src/index.js`）使用，Compose 不讀它；Compose 將根目錄 `.env` 的值注入容器，production 後端只讀程序環境，映像檔不包含 `.env`，這兩份檔案的修改不會互相同步
- 值含 `$` 或 `#` 時，以單引號包住整個值；在 `.env` 中修改既有項目，不要新增重複設定

| 參數 | 本機設定 | 正式設定 | 原因 |
| --- | --- | --- | --- |
| `NODE_ENV` | `local` | `production` | 只區分 local／production |
| `SITE_ADDRESS` | `http://localhost` | `alex-lin-lab.com` | 本機先驗證 HTTP，不申請公開憑證；正式不加 `http://`，讓 Caddy 啟用自動 HTTPS |
| `CORS_ORIGIN` | `http://localhost:8080` | `https://alex-lin-lab.com` | 與網站來源一致；不加 `/helpdesk`、結尾斜線或頁面路徑 |
| `HTTP_BIND`／`HTTP_PORT` | `127.0.0.1`／`8080` | `0.0.0.0`／`80` | 本機設定只允許本機連入 |
| `HTTPS_BIND`／`HTTPS_PORT` | `127.0.0.1`／`8443` | `0.0.0.0`／`443` | 本機 HTTP 模式不會提供正式 HTTPS |

`NODE_ENV` 與 `CORS_ORIGIN` 一定要寫在這份 `.env`：只由這個 env_file 提供，`compose.yaml` 不再另外設定或提供預設值（`environment` 會蓋過 env_file）；缺少 `NODE_ENV` 時後端以 local 執行，缺少 `CORS_ORIGIN` 時 local 預設 `http://localhost:5173`、production 拒絕啟動；密碼、金鑰等其餘設定也由 env_file 提供

後端容器的 `environment` 固定下列值，寫在 `.env` 也會被覆蓋：`PORT=3000`、`DATABASE_FILE=/app/storage/helpdesk.db`（需求單資料庫，目錄須已存在，即 tickets volume）、`TICKETS_FILE=/app/storage/tickets.json`（只作舊版 JSON 匯入來源，服務不寫入）、`LIMIT_STORE=memory`、`TRUST_PROXY=1`（只適用唯一 Caddy 代理且後端沒有對外發布 port 的拓撲）、`ORIGIN_VERIFY_SECRET=`（空）、`SHUTDOWN_TIMEOUT_MS=75000`；後端啟動時會驗證 `TRUST_PROXY`，`true`／`false` 或無法解析的值會拒絕啟動；容器停止寬限 90 秒（不要縮短），`init: true`

## 人員資料（只存 SQLite）

人員資料（帳號、所屬部門、角色、啟用狀態、員工基本資料與假別額度）的資料表、示範名冊、結構升級與哪些帳號可以登入或被指定，見 API 規格書第 3.6 節；這裡說明維運腳本 `scripts/personnel.js` 的用法

| 指令 | 說明 |
| --- | --- |
| `node scripts/personnel.js list [--department <id>]` | 列出帳號（含已停用）、`department_missing`、員工資料與額度（JSON 陣列，欄位 `username`、`department_id`、`department_missing`、`role`、`active`、`display_name`、`employee_no`、`hire_date`、`entitlements`） |
| `node scripts/personnel.js add <username> --department <id> [--role USER\|ADMIN] [--name <顯示名稱> --employee-no <編號> --hire-date YYYY-MM-DD]` | 新增帳號；USER 必須提供三個員工欄位，ADMIN 不可提供；新員工沒有額度，請再用 grant |
| `node scripts/personnel.js set-department <username> <department_id>` | 調整所屬部門（部門必須存在），立即改變處理人名單與代理人候選 |
| `node scripts/personnel.js deactivate <username>`／`activate <username>` | 停用（不能登入、不是處理人或代理人）／恢復 |
| `node scripts/personnel.js grant <username> <假別> <年度> <分鐘>` | 設定（取代）某年度某假別的額度；增減請用人資調整 API；額度有變更時在 `leave_log` 記一列 `GRANTED` |

每個子指令都可加 `--dry-run`：以唯讀連線開啟、不寫入任何內容，輸出 `{ action, username, changed, changes, dryRun: true }`。驗證規則與服務相同（`src/services/personnel.js`）；不提供刪除帳號。腳本與服務一樣使用 WAL 與 busy timeout 5000 ms，可在服務執行中使用；日誌只含帳號、部門 id、角色、狀態與額度數字，不含姓名或員工編號。

### 人員調整的操作步驟（已實作）

本機在 `backend/` 目錄執行（local 模式讀取 `backend/.env`，資料庫為 `DATABASE_FILE`，未設定時是 `storage/helpdesk.db`）；Docker 部署改在 backend 容器內執行，指令前加 `sudo docker compose exec -T backend`，見[部署手冊](../docs/Docker與Lightsail部署操作手冊.md)第 5.7 節。每次調整都依這個順序：

1. **先備份**：人員資料沒有其他副本，調整前以 `node scripts/db-backup.js <備份檔>` 做一次線上備份（服務執行中也可以），確認日誌 `storage.backup.completed` 的 `schemaVersion` 為 4
2. **確認資料庫路徑與現況**：`node scripts/personnel.js list`。`list` 與 `--dry-run` 在資料庫檔不存在或尚未升級到目前版本（4）時會拒絕（`PERSONNEL_NOT_FOUND`、`PERSONNEL_SCHEMA_OLD`），可藉此確認路徑正確。正式寫入的指令不做這項檢查：`DATABASE_FILE` 打錯時會建立一個新的版本 4 資料庫並寫入該筆帳號，之後在那個檔案啟動服務也不會再寫入示範名冊，因此務必先跑 `list`。
3. **預覽**：同一個指令加 `--dry-run`，看 `changes` 是否符合預期；`changed: false` 表示內容已相同、不會寫入。
4. **執行**：拿掉 `--dry-run` 再執行一次。每個指令在一筆交易內完成，失敗時不留下部分修改。
5. **確認**：再跑一次 `list`；執行中的服務下一個請求就使用新資料，不需要重啟。

常見調整（帳號與部門 id 為示意，部門 id 必須存在於 `data/departments.json`）：

```bash
# 調整所屬部門：處理人名單、代理人候選與簽核權限立即改用新部門
node scripts/personnel.js set-department cindy.wang dept-it-1 --dry-run
node scripts/personnel.js set-department cindy.wang dept-it-1

# 新增一般帳號：三個員工欄位都必填，員工編號不可重複；新員工沒有額度，接著用 grant 設定
node scripts/personnel.js add test.user --department dept-it-2 --name "測試人員" --employee-no T-9001 --hire-date 2026-11-01 --dry-run
node scripts/personnel.js add test.user --department dept-it-2 --name "測試人員" --employee-no T-9001 --hire-date 2026-11-01
node scripts/personnel.js grant test.user 特休 2026 6720

# 新增管理員：不可帶員工欄位
node scripts/personnel.js add test.admin --department dept-it-1 --role ADMIN

# 停用／恢復：停用後不能登入、既有憑證立即失效、不出現在處理人名單與代理人候選
node scripts/personnel.js deactivate test.user
node scripts/personnel.js activate test.user

# 設定額度：把某年度某假別的額度「設為」指定分鐘數（不是加減）；假別只接受事假、病假、特休，年度為四位數
node scripts/personnel.js grant test.user 病假 2027 14400
```

注意事項：

- 帳號與密碼的關係、調整部門與停用對既有資料的影響、`grant` 與人資調整 API `POST /api/leave/adjustments` 的差別，見 API 規格書第 3.6、3.17 節
- 結束碼：參數錯誤 2（stderr 另印出用法），驗證或資料庫錯誤 1（日誌 `storage.personnel.failed` 的 `reason`：`PERSONNEL_INVALID` 格式或部門不符、`PERSONNEL_NOT_FOUND` 帳號或員工資料不存在、`PERSONNEL_CONFLICT` 帳號或員工編號已存在、`PERSONNEL_SCHEMA_OLD` 資料庫尚未升級）。
- stdout 同時有結果 JSON 與一行 info 日誌（warn／error 日誌寫入 stderr）。要把 `list` 交給 JSON 工具處理時，加上 `LOG_LEVEL=warn` 只保留結果，例如 `LOG_LEVEL=warn node scripts/personnel.js list > personnel.json`（shell 的環境參數優先於 `.env`）。`list` 的結果含顯示名稱與員工編號，輸出檔不要提交 Git 或貼到公開處。

## 維運腳本

`scripts/` 底下的腳本已複製進映像檔，使用後端相同的環境參數（`DATABASE_FILE`、`TICKETS_FILE`，以及 `src/config/env.js` 的必填檢查，因此 `DEMO_PASSWORD`、`ADMIN_PASSWORD` 也要能讀到）；本機在 backend 目錄以 `node scripts/<檔名>.js` 執行（local 模式讀取 `backend/.env`），Docker 部署在 backend 容器內執行；輸出為單行 JSON 日誌，只含狀態、筆數、結構版本或雜湊，不含需求單原文；輸出檔已存在時一律拒絕覆寫；失敗時以結束碼 1 結束

| 指令 | 用途 |
| --- | --- |
| `node scripts/personnel.js <子指令> [--dry-run]` | 維護人員資料（帳號、部門、角色、啟用狀態、員工資料與假別額度），見上方「人員資料」；結果另以 JSON 寫到 stdout（`list` 為多行 JSON 陣列），日誌 `storage.personnel.changed`／`storage.personnel.dry_run`／`storage.personnel.listed`，失敗為 `storage.personnel.failed`（參數錯誤結束碼 2、驗證或資料庫錯誤結束碼 1） |
| `node scripts/import-legacy-tickets.js [--dry-run] [--import-late]` | 預覽（`--dry-run`）或執行舊版 `tickets.json` 匯入；判斷規則、選項與日誌見 API 規格書第 3.4、3.13 節 |
| `node scripts/export-tickets-json.js <out.json>` | 以唯讀連線開啟資料庫（服務執行中也可使用），依建立順序匯出成舊版 `tickets.json` 格式，供回滾到先前的 JSON 版映像（只含需求單，不含員工、額度與人資調整）；先寫入權限 600 的 `<out.json>.tmp` 再改名；輸出檔或殘留的 `<out.json>.tmp` 已存在時以 `OUTPUT_EXISTS` 拒絕、不覆寫，此時改用新的檔名；成功日誌 `storage.export.completed`（`tickets` 為匯出筆數），失敗為 `storage.export.failed` |
| `node scripts/leave-log.js [--user <帳號>] [--year <年度>] [--leave-type <假別>] [--json]` | 唯讀列出請假額度異動紀錄 `leave_log`：每次送出、簽核、退回、取消、人資調整與年度額度變更的時數與前後剩餘，服務執行中也可使用；欄位與事件見 API 規格書第 3.4 節 |
| `node scripts/db-backup.js <out.db>` | 線上備份；權限、完整性檢查與日誌見[部署操作手冊](../docs/Docker與Lightsail部署操作手冊.md)第 6.2 節 |
| `node scripts/db-restore.js <backup.db>` | 停機還原；執行條件、流程與日誌見部署操作手冊第 6.3 節 |

備份與還原的範圍、Lightsail 上的操作指令、維運容器的執行帳號與擁有者修正，見[部署操作手冊](../docs/Docker與Lightsail部署操作手冊.md)第 6 節

## 管理員與課堂重置

管理員帳號 `alex.admin`、管理頁與管理重置 `POST /api/admin/reset` 的完整規則（維護鎖、清除範圍、獨立的管理路徑保護與掛載順序、錯誤代碼）見 API 規格書第 3.12 節；執行中不要手動刪除、覆寫或搬移 `helpdesk.db` 及其 `-wal`／`-shm`，相關說明與重置前的備份方式見部署操作手冊第 6 節

## 管理監測

管理監測 `GET /api/admin/metrics` 的回應欄位（含需求單資料庫摘要 `ticketStore`）、獨立的監測限流與管理頁的取樣規則見 API 規格書第 3.14 節

## 日誌與排查

後端以單行 JSON 輸出日誌，warn 與 error 寫入 stderr；預設 `LOG_LEVEL=info`，排查時設 `LOG_LEVEL=debug` 並重啟；debug 不輸出需求單原文、原始 SDK 錯誤或金鑰；欄位名稱含 key、token、secret、authorization、password、message、content、subject、body、prompt 等的值一律顯示 `[REDACTED]`；日誌也遮蔽兩家 AI 供應商設定的金鑰與 `AIza…`、`sk-ant-…` 格式的字串；Docker Compose 的日誌輪替上限為每個服務 3 個 10 MB 檔，不是總磁碟空間上限

排查順序：

1. 啟動時先查看 `storage.ready`（`engine`、`schemaVersion`（目前為 4）、`legacyImport`、`legacyCount`、`seededAccounts`、`seededEmployees`、`seededEntitlements`；後三者是本次寫入示範名冊的帳號、員工與額度筆數，全新資料庫第一次啟動為 17、16、96，帳號表已有資料（之後的啟動，或由版本 2 升級）時皆為 0）；接著可能有 warn `storage.account_department_missing`（`username`、`departmentId`、`active`、`hint`），表示該帳號的部門已不在 `data/departments.json`，帳號不能登入，修正部門設定或以 `scripts/personnel.js set-department` 調整（每個這樣的帳號各記一筆，不讓啟動失敗）；部門設定檔或需求類型定義不符時，程序在開啟資料庫前就以錯誤結束，訊息只列出位置與原因；需求類型的錯誤記錄 `request_types.failed`（`reason: REQUEST_TYPES_INVALID`，`detail` 的格式是「檔名 鍵路徑 原因」，例如 `equipment.json fields[2].type 未知的欄位型別「slider」，只接受 self、enum、text、number、date、datetime、account、department`；依 detail 修正 `data/requestTypes/` 後重啟，常見錯誤見規範文件第 13 節步驟 8），正常時在 `storage.ready` 之前先有 `request_types.ready`（`types` 為類型 id，目前依序為 leave、attendance、vpn、repair、equipment、purchase、general；`defaultType` 為 general；另有 `catalogVersion`）；`legacyImport` 可能為 `imported`、`already-imported`、`legacy-changed`、`legacy-appeared`、`legacy-unreadable`、`no-legacy-file`；新主機第一次啟動為 `no-legacy-file`，之後的啟動為 `already-imported`；後三種需要提醒的情況（`legacy-changed`、`legacy-appeared`、`legacy-unreadable`）另記 warn `storage.legacy_warning`（`legacyImport`、只有 `legacy-unreadable` 才有的 `errorCode`、`hint`），服務照常啟動但不匯入也不合併舊檔；`legacy-appeared` 的 hint 會提示以 `--import-late` 匯入；若出現 `storage.failed`，程序不會監聽；`reason` 是固定代碼：`NODE_TOO_OLD`（Node 版本低於 22.14.0，better-sqlite3 13 需要 Node-API 10；請依 `.nvmrc` 改用 22.23.4）、`DIRECTORY_MISSING`（`DATABASE_FILE` 目錄不存在）、`FOREIGN_DATABASE`（路徑指到其他程式的 SQLite 檔）、`SCHEMA_TOO_NEW`（改用對應版本的映像）、`LEGACY_UNREADABLE`／`LEGACY_INVALID`／`LEGACY_CONFLICT`（檢查舊版 `tickets.json`）、`PERSONNEL_UNMAPPED`（版本 2 資料庫有員工不在示範名冊，無法決定部門；整步回滾，資料庫仍是版本 2）、`PERSONNEL_INVALID`（示範名冊驗證失敗）、`FOREIGN_KEY_VIOLATION`（版本 3 重建後外鍵不一致，已回滾），或 SQLite／檔案系統代碼如 `SQLITE_CANTOPEN`、`EACCES`（目錄或檔案權限、擁有者）、`SQLITE_NOTADB`（不是 SQLite 檔）；沒有代碼的錯誤為 `PREPARE_FAILED`；`detail` 為不含需求單內容的錯誤訊息（最多 200 字），`hint` 為排查提示；關閉資料庫失敗另記 `storage.close_failed`（`sqliteCode`）
2. 資料庫準備完成後才開始監聽；接著查看 `server.started`（`port`、`nodeEnv`、`nodeVersion`、`corsOrigin`、`model`（主要供應商的模型）、`aiProvider`（主要供應商）、`aiFallbackProvider`（有金鑰的備援，沒有時為 null）、`credentialsConfigured`、`logLevel`、`localUrl`），以及 `server.limits`（含 `draftUserDailyLimit`、`draftGlobalDailyLimit`）、`server.http_limits`（含 `draft`）；未設金鑰另有 warn `server.credentials.missing`，本機未設 `AUTH_SECRET` 另有 warn `server.auth.local_secret`（改用保存在 SQLite 的本機簽章金鑰）；`server.started` 只在真正監聽成功（`listening` 事件）後記錄；監聽失敗只會記錄 `server.failed`（`reason` 為 `PORT_IN_USE` 或 `LISTEN_FAILED`）並以結束碼 1 結束，不會同時出現 `server.started`；`credentialsConfigured=true` 只代表已設定金鑰，不代表金鑰有效；改用備援供應商時記錄 warn `ai.fallback.used`（含 `reason`）
3. 送出需求單後，找出 `http.request.started`，用相同 `requestId` 追蹤後續日誌，最後是 `http.request.completed`；被拒絕的請求另有 `http.request.rejected`（`status`、`code`、`retryAfter`；4xx 以 warn、5xx 以 error 記錄）
4. 指定處理人會記錄 `ticket.assigned`；AI 判斷會依序記錄 `limits.reserved`、`ticket.judge.started`、`claude.generate.started`／`completed`（或 `gemini.generate.started`／`completed`）、`ticket.judge.completed`、`ticket.record.saved`；簽核或退回記錄 `ticket.decided`，轉單記錄 `ticket.transferred`，取消記錄 `ticket.cancelled`；帶需求類型表單的送出記錄 `ticket.form.saved`（`route`、`typeId`、`departmentId`、`withHandler`、`computedCount`），只帶 `department_id` 的送出記錄 `ticket.record.saved`（`source: "draft"`）；每次自動生成記錄 `ticket.draft.evaluated`（`typeId`、`departmentId`、`firstCall`、`aiAttempted`、`aiUsed`、`aiError`、`aiUpdates`、`toolsUsed`（工具 id）、`historyCount`、`lockedCount`、`missingCount`、`invalidCount`、`complete`）；有呼叫 AI 時另有 `ticket.draft.ai.started`（`purpose` 為 `ticket.draft.classify` 或 `ticket.draft.fill`）、每次 AI 呼叫（`purpose` 為 `ticket.draft.classify`、`ticket.draft.tools` 或 `ticket.draft.fill`）的 `claude.generate.started`／`completed`（Claude，含停止原因與 input／output token 數，不含內容）或 `gemini.generate.started`／`completed`（Gemini，`completed` 另記 `finishReason`（例如 `STOP`、`MAX_TOKENS`）、`inputUsage`、`outputUsage`、`thoughtUsage`（思考用量））、`ticket.draft.ai.completed`（`durationMs`、`typeId`、`departmentId`、`confidence`、`updateCount`、`toolCount`、`answered`），失敗為 `ticket.draft.ai.failed`（`purpose`、`stage` 為 client.initialize／claude.tools 或 gemini.tools／tool.execute／claude.generate 或 gemini.generate／response.validate、`reason`）；人資調整記錄 `leave.adjusted`（`actorID`、`leaveType`、`year`、`deltaMinutes`）；這些日誌都不含主題、訊息、對話、欄位值或調整原因；`ticket.draft.evaluated` 與 `ticket.draft.ai.*` 只記錄 id、筆數、代碼、工具 id 與是否完成，`leave.adjusted` 只記錄 actorID、假別、年度與分鐘數
5. 遇到 `ticket.judge.failed`，查看 `stage`（client.initialize、gemini.generate、response.parse、response.validate）、`upstreamStatus`、`reason`、`hint`、`model`；`tickets.store.unavailable` 代表需求單資料庫無法讀寫（`operation` 為 load 或 persist，`errorCode` 為 SQLite 錯誤代碼或開啟時的固定代碼，例如 `SQLITE_BUSY`、`FOREIGN_DATABASE`；只記錄這兩個欄位，不記錄需求單內容；管理監測讀不到資料庫時也會記錄（`operation` 為 load），此時監測回應的 `ticketStore.available` 為 false，其餘欄位照常回傳）；若曾以 root 執行維運腳本，`helpdesk.db` 或 `-wal`／`-shm` 可能變成 root 擁有而使後端啟動失敗或回 503，修正方式見部署操作手冊第 6.3 節
6. 關機依序記錄 `server.stopping`（`signal`、`timeoutMs`）與 `server.stopped`；逾時或排空失敗為 `server.shutdown.failed`（`DRAIN_FAILED_OR_TIMEOUT`），強制結束為 `server.shutdown.forced`（`REPEATED_SIGNAL`），1 秒內的重複訊號只記 debug `server.signal.ignored`（`DUPLICATE_SIGNAL`）。

AI 診斷原因（`API_KEY_INVALID`、`MISSING_API_KEY`、`MODEL_NOT_FOUND`、`ACCESS_DENIED`、`RATE_LIMIT_OR_QUOTA`、`INVALID_ARGUMENT`、`NETWORK_ERROR`、`TIMEOUT`、`INVALID_AI_RESPONSE`、`UPSTREAM_UNAVAILABLE`、`UNKNOWN`）的排查方向見 API 規格書第 4 節

## HTTP 限流 middleware

HTTP 限流的種類、上限、套用範圍與超限回應見 API 規格書第 2.2 節（實作在 `src/middleware/rateLimiter.js`）；`src/server.js` 掛載順序為關機連線關閉（closeOnShutdown）→ 日誌 → API no-store 與選用來源驗證 → CORS → 獨立管理路由（自帶 IP 限流 → JSON 解析 → 驗證，見「管理員與課堂重置」）→ 一般 /api IP 粗限流 → POST 登入總請求限流 → JSON 解析（16 KB）→ 路由 → 404 → 錯誤處理

`http.rate_limit.blocked` 日誌標示 api／login／ticket／departments／query／draft，沒有原始 IP、帳密或 token

## 關機

`src/index.js` 以 `process.on` 持續監聽 SIGINT 與 SIGTERM（`src/utils/shutdown.js`；關機期間的回應標頭由 `src/middleware/closeOnShutdown.js` 加上）；Docker Compose 的 `stop`、`down` 與重建容器都會先送 SIGTERM：

- 第一次訊號開始優雅關機（`server.stopping`）：停止接受新的登入、部門、需求單、查詢與維護工作（已建立的連線上的新請求回 503 `SERVICE_BUSY`，Retry-After 10 秒；健康檢查與管理監測不受此限），停止監聽新連線，等待既有需求單（含預扣、判斷、記錄寫入與租約釋放）完成，最多 `SHUTDOWN_TIMEOUT_MS`（預設與 Compose 皆為 75000 毫秒）；關機期間每個回應都帶 `Connection: close`，讓 Caddy 等代理的 keep-alive 連線在回應後關閉；工作排空後每 50 毫秒清掃一次真正閒置（沒有處理中或排隊的請求、也沒有新到資料）的 keep-alive 連線，有請求未完成的連線會等回應寫完才關閉；全部結束後關閉資料庫（WAL 合併回主檔）並以結束碼 0 結束（`server.stopped`）；逾時或關閉失敗時記錄 `server.shutdown.failed`，強制關閉所有連線，仍嘗試關閉資料庫，並以結束碼 1 結束
- 第一次訊號後 1 秒內的重複訊號（例如 `npm start`／`npm run dev` 下按一次 Control + C，終端機與 npm 各送一次 SIGINT）只記錄 debug 日誌 `server.signal.ignored`，不中斷優雅關機；超過 1 秒後再收到訊號才強制結束（`server.shutdown.forced`）：關閉所有連線與資料庫後以結束碼 1 結束，不會落回 Node 預設的直接終止

部署平台的終止寬限須大於 `SHUTDOWN_TIMEOUT_MS`（Compose 為 90 秒，不要縮短）；程序被強制終止也不會損毀資料庫，已提交的交易會在下次開啟時由 WAL 自動復原

## 新增功能

例如新增查詢 API：建立 `src/routes/xxxRoutes.js`，在 `src/routes/index.js` 掛載 `router.use('/xxx', xxxRoutes)`，將請求處理放在 `src/controllers/xxxController.js`，需要業務邏輯時再建立 `src/services/` 底下的 service；需求單 API 的掛法（`src/routes/ticketRoutes.js` → `src/controllers/ticketController.js` → `src/services/ai/ticketJudge.js`）可作為範例；新增需求類型不改程式：在 `data/requestTypes/` 新增一個定義檔，並在 `_catalog.json` 的 `types` 加一筆（`id`、`file`、`name`、`summary`、`keywords`），重啟後端（Docker 部署重新建置 backend 映像檔）即可；啟動驗證會指出錯誤的檔名與鍵路徑，步驟以 `equipment.json` 為例寫在[需求類型與 AI 資料來源規範](../docs/需求類型與AI資料來源規範.md)；需要改程式的情況見規範文件第 12 節；開發約定見 [AGENTS.md](../AGENTS.md)

SDK 與錯誤處理參考：[Claude Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)、[Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)、[Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)、[Express 5 錯誤處理](https://expressjs.com/en/5x/guide/error-handling/)。
