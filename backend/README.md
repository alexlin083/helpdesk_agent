# Backend

Express 5 後端 API，使用 ES Modules。提供登入、健康檢查、部門與處理人名單、需求單送出（指定處理人直接送達，或由 Gemini 判斷部門）、需求單查詢與部門簽核。資料不使用資料庫，部門、帳號與需求單都保存在 `data/` 底下的 JSON 檔。
完整規格以專案根目錄的《企業智慧服務台 Agent 前後端 API 介面規格書》與開發規格書為準；本文件是後端入門說明。

對話 API（`/api/agent/chat`、`/api/agent/usage`）與知識庫檢索已移除，相關的空檔也已刪除。

## 架構

```text
backend/
├── index.js                     # 啟動、監聽 port、關閉伺服器
├── server.js                    # Express app、全域 middleware
├── routes.js                    # /api 路由總入口
├── routes/
│   ├── authRoutes.js            # /auth：登入
│   ├── departmentRoutes.js      # /departments：部門與處理人名單
│   └── ticketRoutes.js          # /tickets：送出需求單
├── controllers/
│   └── ticketController.js      # 需求單：送出、我的需求單、部門待簽核、已完成查詢、簽核／退回、轉單、取消；部門名單處理器
├── services/
│   ├── authService.js           # 密碼比對、JWT；帳號名單取自 accountService
│   ├── accountService.js        # 載入並驗證帳號設定檔（帳號與所屬部門）；帳號即可指定的處理人
│   ├── usageService.js          # 冷卻、並行租約、每日配額、登入失敗計數
│   ├── limitStore.js            # 限制儲存：單程序記憶體（含管理重置）
│   ├── departmentService.js     # 載入並驗證部門設定檔（不含處理人）
│   ├── ticketJudge.js           # 需求單判斷部門：一次 Gemini 呼叫、75 分分流
│   ├── ticketStore.js           # 需求單儲存：單一 JSON 檔，含狀態與簽核紀錄
│   └── chatTasks.js             # 需求單工作追蹤器，供關機流程等待
├── data/
│   ├── departments.json         # 部門設定檔（八個部門：部門、業務說明、關鍵字）
│   ├── accounts.json            # 帳號設定檔（十組一般帳號與獨立管理員；僅一般帳號可當處理人）
│   └── tickets.json             # 執行後產生的需求單資料（含原文、狀態與簽核紀錄，不提交 Git）
├── utils/                       # logger（JSON 日誌與遮蔽）、agentDeadline（上游逾時）、shutdown（優雅關機）
├── config/
│   └── env.js                   # 載入 backend/.env 與驗證環境參數
├── middleware/                  # authenticate、errorHandler、requestLogger、rateLimiter
├── tests/                       # API、環境參數、日誌、保護、限流、可靠性與需求單測試
├── .env                         # 本機設定，不提交 Git
└── .env.example                 # 不含金鑰的設定範本
```

需求單流程：`server.js → routes.js → ticketRoutes.js → ticketController.js`；指定處理人時直接保存為待簽核，沒指定時由 `ticketJudge.js` 呼叫 Gemini 判斷部門後保存；查詢與簽核都經 `ticketStore.js` 讀寫 `data/tickets.json`。
健康檢查、登入與部門名單直接寫在路由或簡單處理器中；業務邏輯較多的 API 才拆 controller 與 service。

## 啟動

統一使用 Node.js 22（根目錄與 backend 的 `.nvmrc` 均指定 22，前後端 `engines` 均為 `22.x`）。使用 nvm 時執行 `nvm install 22`、`nvm use 22`，再執行 `npm ci`。

```bash
cd backend
nvm use
npm install
npm run dev
```

一般啟動使用 `npm start`，測試使用 `npm test`。
將 `.env.example` 的設定填入現有 `.env`，保留自己的真實金鑰：

```dotenv
PORT=3000
CORS_ORIGIN=http://localhost:5173
GEMINI_API_KEY=<請填入自己的金鑰>
DEMO_PASSWORD=<請填入私下提供的一般登入密碼>
ADMIN_PASSWORD=<請填入獨立管理密碼，不得與一般密碼相同>
GEMINI_MODEL=gemini-3.5-flash-lite
```

`CORS_ORIGIN` 設為實際前端網址。本機未設定金鑰時健康檢查、登入、部門名單與指定處理人的需求單仍可使用，AI 判斷部門回傳 500 `SERVER_ERROR`。
程式預設模型是 `gemini-2.5-flash`，曾有帳號回報 404，請在 `.env` 明確填寫已驗證可用的 `GEMINI_MODEL`。修改 `.env` 後重新啟動伺服器。

## 登入、限流與配額

一般帳號為十組英文姓名帳號（全小寫、格式為「名.姓」、區分大小寫），每個帳號屬於一個部門，定義在 `data/accounts.json`（`username`、`department_id`、選填 `role`）；對應的使用者代號為 `user-` 加帳號（例如 `user-racky.huang`）。帳號必須唯一、部門必須存在於部門設定檔，否則啟動失敗；修改後須重啟。前端不保存帳號名單，只檢查格式。這十組帳號同時就是「指定處理人」的名單：處理人 id 即帳號名稱，送達對象顯示「帳號（部門）」。
登入密碼必須透過後端 `DEMO_PASSWORD` 設定，沒有內建預設值，也不在文件記錄實際密碼。另有 `alex.admin`（`dept-it-1`，`role: ADMIN`），只可使用管理頁與重置 API，不參與工作單、不列入處理人名單，密碼由 `ADMIN_PASSWORD` 獨立設定且不得與 `DEMO_PASSWORD` 相同。登入成功簽發 HS256 JWT，預設兩小時有效，回應的 `user` 含 `department` 與 `role`（部門與角色不寫入憑證，驗證時依目前設定檔查詢）；部門名單與需求單都需要 Bearer 憑證，提單人由憑證決定。

| 環境參數 | 預設 | 用途 |
| --- | --- | --- |
| `AUTH_SECRET` | 本機隨機、production 必填 | 至少 32 bytes 的隨機簽章金鑰，多個 instance 必須相同 |
| `AUTH_TTL_SECONDS` | 7200 | 憑證有效秒數 |
| `DEMO_PASSWORD` | 必填，無預設值 | 十個帳號共用的課堂密碼，僅存於未追蹤的 .env 或平台環境參數 |
| `CHAT_COOLDOWN_SECONDS` | 10 | 帳號獲准 AI 判斷部門後的冷卻秒數 |
| `USER_DAILY_LIMIT` | 30 | 每帳號每日可獲准 AI 判斷的次數 |
| `GLOBAL_DAILY_LIMIT` | 100 | 所有帳號共用的每日上限 |
| `GLOBAL_CONCURRENCY` | 2 | 全站同時處理上限，每帳號固定同時一筆 |
| `LOGIN_FAILURE_LIMIT` | 100 | 每 IP／IPv6 /64 在視窗內可失敗次數，成功登入不清除 |
| `LOGIN_WINDOW_SECONDS` | 900 | IP 整體登入失敗視窗；達上限後正確帳密也需等待 |
| `LOGIN_ACCOUNT_FAILURE_LIMIT` | 5 | 已知帳號＋IP／IPv6 /64 的失敗次數上限 |
| `LOGIN_ACCOUNT_WINDOW_SECONDS` | 300 | 帳號組合失敗視窗；達上限只封鎖該組合，除非 IP 整體也超限 |
| `HTTP_RATE_WINDOW_SECONDS` | 60 | 各 HTTP 限流使用的視窗秒數 |
| `HTTP_RATE_MAX_KEYS` | 2048 | 每個 HTTP middleware 最多追蹤的識別碼；滿載拒絕新識別碼 |
| `HTTP_API_LIMIT` | 300 | 每 IP／IPv6 /64 的 API 請求數（不含健康檢查與 OPTIONS） |
| `HTTP_LOGIN_LIMIT` | 120 | 每 IP／IPv6 /64 的登入總請求數，包含成功與失敗 |
| `HTTP_TICKET_LIMIT` | 12 | 每個驗證後帳號的需求單送出請求數（含被業務規則拒絕的） |
| `HTTP_DEPARTMENTS_LIMIT` | 30 | 每個驗證後帳號的部門名單請求數 |
| `HTTP_QUERY_LIMIT` | 60 | 每個驗證後帳號的需求單查詢請求數（我的需求單、部門需求單） |
| `TICKETS_FILE` | `data/tickets.json` | 需求單 JSON 檔的絕對路徑；留空使用預設 |
| `SHUTDOWN_TIMEOUT_MS` | 75000 | 關機最多等待既有需求單與租約清理的毫秒數，至少 25000 |
| `LIMIT_STORE` | memory | local 與 production 都只允許 memory；重啟及管理重置會歸零 |
| `ADMIN_PASSWORD` | 必填 | 應用程式管理員的獨立密碼，不是 AWS IAM 密碼 |
| `ORIGIN_VERIFY_SECRET` | 無 | CloudFront 來源秘密，設定後至少 32 bytes；除健康檢查外 API（含 OPTIONS）需帶 X-Origin-Verify |
| `NODE_ENV` | local | 只接受 local 或 production；正式環境不讀 .env |
| `TRUST_PROXY` | 不信任代理 | 依實際代理鏈填可信任 IP、網段或 hop 數，勿盲目填 true |

冷卻、並行與每日用量只在「沒有指定處理人、需要呼叫 Gemini」時檢查並預扣；指定處理人的需求單不扣額度。獲准後的上游錯誤也計入，不退額；拒絕或輸入／身分驗證失敗不扣額。台北午夜重置每日計數，但不清除執行中租約或冷卻。

本機記憶體模式只適用單一程序，重啟會歸零。未設定 `AUTH_SECRET` 時本機使用暫時金鑰，重啟後需重新登入；要保留相同簽章金鑰可自行產生隨機值放入 `.env`，勿提交或分享：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

登出只清除前端分頁憑證，舊 JWT 到期前仍有效。修改 `DEMO_PASSWORD` 不會撤銷已簽發憑證；需要使全部憑證失效時更換 `AUTH_SECRET` 並重新部署所有 instance。

登入失敗以 `LIMIT_STORE` 原子保存來源整體與已知帳號＋來源兩種視窗；封鎖後即使正確帳密也需等待。未知帳號只累積來源整體；狀態最多 512 筆，滿載回傳 503。IPv6 以 /64 分組。IP 登入保護只相信 Express 判定的 `req.ip`，CloudFront 與 Nginx 後須依實際拓撲設定 `TRUST_PROXY`。

## 需求單 API、部門與帳號設定檔

部門定義放在 `data/departments.json`（目前八個部門，每個部門至少一個登入帳號，AI 判斷送達的需求單才有人能簽核），由後端啟動時讀入並驗證；每個部門的欄位為 `id`、`name`、`type`（選填）、`duty`、`business`（關鍵字陣列）。部門 id 全檔唯一；`business` 含「IT資訊服務台」的部門是接收對不到部門需求單的預設部門，必須恰有一個，否則啟動失敗。處理人不寫在部門設定檔（若仍含 `handlers` 欄位會啟動失敗），而是由 `data/accounts.json` 的帳號決定：每個部門可指定的處理人就是該部門的登入帳號。修改任一設定檔後須重啟後端。

`GET /api/departments` 回傳部門設定檔內容並合併處理人（`handlers` 為該部門的帳號：`id` 與 `name` 都是帳號名稱；`type` 缺漏為空字串）。`POST /api/tickets` 接收 `{ subject, content, handler_id }`：`subject` 1～100 字、`content` 1～2000 字（去空白後以 Unicode code points 計），`handler_id` 為字串或 null。兩種路徑都把需求單保存為「待簽核」（`status: PENDING`）：

- 有 `handler_id`：查帳號設定檔，找不到回 400「指定的處理人不存在」；找到就保存並回 `{ ticket_id, route: "HANDLER", department, handler: { name }, status }`，不扣額度、不呼叫 Gemini。
- 沒有 `handler_id`：先預扣冷卻、並行與每日配額，呼叫 Gemini 一次（逾時 15 秒、temperature 0.2、maxOutputTokens 1024、結構化輸出 `department_id`、`confidence_score`、`basis`），部門 id 在設定檔內且信心分數達 75 分回 `DEPARTMENT`，否則回 `FALLBACK` 並送預設部門；`basis` 去空白後最多 200 字，空字串時省略。保存成功後才回應，保存失敗回 503 `TICKET_STORE_UNAVAILABLE`，已扣的額度不退還。成功回應帶 `X-User-Remaining`、`X-Global-Remaining` 標頭。

需求單資料保存在 `data/tickets.json`（可用 `TICKETS_FILE` 改路徑），每張需求單含 `ticket_id`、`created_at`、`updated_at`、`requester`（提單人與其部門）、`subject`、`content`、`route`、`department_id`、`department_name`、`handler`、`judgement`（AI 判斷的部門、分數、依據、模型）、`status`、`decision`、`history`。檔案含需求單原文，不得提交 Git，也不放進部署包；寫入先寫暫存檔再改名並在程序內排隊，改名遇到 Windows 暫時性鎖定（EPERM／EBUSY）最多重試三次；新增需求單寫檔失敗時會從記憶體移除該筆，避免呼叫端重送後出現重複的需求單。只適用單一程序，多個 instance 不會共用。

查詢、簽核、轉單與取消（狀態：`PENDING` 待簽核、`APPROVED` 已簽核、`REJECTED` 已退回、`CANCELLED` 已取消；沒有刪除）：

- `GET /api/tickets/mine`：我提出的需求單，最新在前。
- `GET /api/tickets/department`：送達我所屬部門的需求單，待簽核在前（最早優先），其餘依更新時間由新到舊；回應另含 `department`。
- `GET /api/tickets/completed?status=&q=&from=&to=&limit=`：我提出且已結案的需求單，加上我所屬部門已簽核、已退回、已取消的需求單，依簽核時間由新到舊，預設最新 100 筆（最多 500）；`q` 比對單號、主題、內容、提單人、簽核人、備註與處理人，`from`／`to` 是簽核日期的台北日期；回應含 `total`（符合條件總數）與 `limit`。
- `POST /api/tickets/{id}/decision`：`{ action: "APPROVE" | "REJECT", comment? }`，備註最多 200 字；只有送達部門的成員可操作（403 `FORBIDDEN`），需求單必須是待簽核（409 `TICKET_ALREADY_DECIDED`），查無回 404 `TICKET_NOT_FOUND`；成功回 `{ ticket }`。
- `POST /api/tickets/{id}/transfer`：`{ department_id, handler_id?, comment? }`，送達部門的成員把待簽核的單轉到其他部門（可指定該部門的處理人），狀態維持待簽核、歷程追加 `TRANSFERRED`；目標部門不存在或與目前相同、處理人不屬於目標部門都回 400。
- `POST /api/tickets/{id}/cancel`：`{ comment? }`，提單人可取消自己待簽核的單（原因選填）；送達部門的成員替提單人取消時必須填原因；其他人 403；已簽核或已取消回 409`decision.cancelled_by` 記錄是 `REQUESTER` 或 `DEPARTMENT`。

## API 端點

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/api/admin/metrics` | 管理員唯讀監測：AI、帳號、HTTP 與登入保護摘要 |
| POST | `/api/admin/reset` | 管理員清空全部工作單與一般保護計數 |
| GET | `/api/health` | 檢查伺服器是否運作，不檢查 Gemini 連線 |
| POST | `/api/auth/login` | 驗證一般帳號或獨立管理員並取得登入憑證 |
| GET | `/api/departments` | 以 Bearer 憑證取得部門與處理人名單，不呼叫 Gemini、不扣額度 |
| POST | `/api/tickets` | 以 Bearer 憑證送出需求單；指定處理人時直接送達，沒指定時呼叫 Gemini 判斷部門；保存為待簽核 |
| GET | `/api/tickets/mine` | 我提出的需求單 |
| GET | `/api/tickets/department` | 送達我所屬部門的需求單 |
| GET | `/api/tickets/department/completed` | 我所屬部門的簽核紀錄（已簽核、已退回、已取消），可篩選，預設最新 100 筆 |
| POST | `/api/tickets/{id}/decision` | 簽核或退回一張送達我所屬部門的待簽核需求單 |
| POST | `/api/tickets/{id}/transfer` | 把待簽核的需求單轉到其他部門 |
| POST | `/api/tickets/{id}/cancel` | 取消待簽核的需求單（提單人或送達部門成員） |
| OPTIONS | 所有路徑 | CORS 預檢，由 middleware 處理；允許 GET、POST、OPTIONS |

以下 `<PASSWORD>`、`<token>`、`<TICKET_ID>` 為佔位文字，請自行替換，勿提交實際值；`handler_id` 是處理人的帳號名稱。

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

成功回應（指定處理人）：

```json
{ "ticket_id": "TK-123e4567-e89b-42d3-a456-426614174000", "route": "HANDLER", "department": "資訊管理一部", "handler": { "name": "racky.huang" }, "status": "PENDING" }
```

簽核（`<TICKET_ID>` 為上面回應的單號，由送達部門的帳號執行）：

```bash
curl -X POST http://localhost:3000/api/tickets/<TICKET_ID>/decision \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"action":"APPROVE","comment":"已安排"}'
```

錯誤回應一律為 `{"error":{"code":"...","message":"..."}}`，有等待期限時另有 `error.retry_after` 與相同的 `Retry-After` 標頭。錯誤包含 400 輸入無效、401 未登入／登入失敗、403 無權限（不是送達部門、不是提單人）、404 未知路由／方法不符／查無需求單、409 已簽核或已取消、413 本文超過 16 KB、429 冷卻／每日配額／處理中／登入失敗過多、500 未設金鑰／輸出格式異常／上游失敗、503 全站忙碌／限制儲存故障／需求單儲存故障。完整代碼以 API 規格書為準。

## 正式環境與部署

不使用資料庫。工作單存在單一 JSON 檔，配額、冷卻、並行租約、登入失敗與 HTTP 計數都存在記憶體。local 與 production 使用相同保護邏輯；重啟、換機或管理重置會清空保護計數，不能當作永久的費用上限。`LIMIT_STORE` 預設且只接受 `memory`；已移除 AWS 資料庫 SDK、表格參數及資料庫權限需求。

只區分 `NODE_ENV=local` 與 `NODE_ENV=production`。本機預設 local，讀取 `backend/.env`，shell 參數優先；正式環境完全不讀 `.env`，必須由平台設定 `GEMINI_API_KEY`、`CORS_ORIGIN`、`AUTH_SECRET`（至少 32 bytes）、`DEMO_PASSWORD`、獨立的 `ADMIN_PASSWORD`。模式須設定在 shell 或平台；不接受第三種模式。測試使用隔離的 local 參數及假密碼。

部署架構為 **GitHub Pages → CloudFront HTTPS → 單台 Elastic Beanstalk／Nginx → 單一 Node.js 22 程序**，不使用 ALB。JSON 不能跨程序共用，禁止 PM2 cluster、多 instance 或以額外執行個體進行部署。應用程式更新可能覆蓋檔案；EC2 被替換後本機檔案可能遺失，修改 `TICKETS_FILE` 路徑不等於持久化。課堂資料應事先匯出或另行備份。

以 backend 為應用程式根目錄，ZIP 根目錄直接放 `package.json` 與 `Procfile`；`.ebignore` 排除 `.env`、測試及真實工作單，但手動 ZIP 不會自動套用該檔，需自行檢查。EB 使用 `NODE_ENV=production`、`PORT=5000`，健康檢查 `/api/health`。AWS Console 由既有 IAM user `alex.admin` 操作；IAM user 不能充當 EB Service Role 或 EC2 Instance Profile，仍須選擇合適的既有角色或另行建立，應用程式不保存 AWS 金鑰。

CloudFront 必須停用 API 快取、轉送 Authorization、Origin、預檢標頭及查詢參數，並允許 POST／OPTIONS。詳見 [單台 EB 與 CloudFront 部署操作手冊](./單台EB與CloudFront部署操作手冊.md)。本次只完成程式與部署說明，沒有建立或修改 AWS 資源。

## 管理員與課堂重置

`alex.admin` 登入後導向 `frontend/admin/admin.html`，顯示限制設定與即時取樣用量；沒有工作單操作入口，後端所有 `/api/tickets` 與 `/api/departments` 也明確拒絕 ADMIN（403）。帳號設定的 `role` 只接受 USER 或 ADMIN，省略為 USER，禁止從請求本文或前端角色決定授權。

`POST /api/admin/reset` 需要 Bearer 管理員憑證及本文：

```json
{ "confirmation": "RESET_HELPDESK" }
```

成功回 HTTP 200：

```json
{ "deletedTickets": 12, "resetAt": "2026-10-28T00:00:00.000Z" }
```

維護鎖先拒絕新登入與業務工作（503 SERVICE_BUSY），等待已開始的登入、AI、查詢及工作單變更完成，再依序將檔案及快取清為 `[]`、清除全部配額／冷卻／租約／登入失敗記錄、清除一般 HTTP 計數。檔案寫入失敗回 503 TICKET_STORE_UNAVAILABLE，還原快取並保留計數。重複重置回 503，不會排入無限等待。

管理路徑使用獨立的 IP 與管理員 HTTP 保護，不受一般 API 入口已耗盡影響；管理路徑自己的計數不會被重置，以免反覆清除繞過保護。未登入回 401、一般帳號回 403、確認文字不符回 400。帳號與已核發 JWT 保留；重置不會重送請求或通知其他分頁，也不會退還 Gemini 實際費用。`admin.reset.completed` 僅記錄操作者 userID、筆數及時間。

不要在執行中手動刪檔或覆寫檔案，否則快取可能把舊資料寫回。管理清除不可復原，畫面要求輸入確認文字；連線中斷不自動重試，因為伺服器可能已完成操作。

## 管理監測

`GET /api/admin/metrics` 只接受 Bearer ADMIN，未登入回 401、一般帳號回 403。回傳 observedAt、pollSeconds、runtime、ai、users、login、http、monitoring，採明確欄位白名單，不包含金鑰、密碼、IP、來源雜湊、租約 ID 或工作單原文。

管理頁每次請求完成後等待 5 秒再取樣，也提供「立即更新」與「暫停自動更新」。各帳號只列 USER，顯示部門、AI 今日已用／上限／剩餘、處理中與剩餘冷卻。全站顯示每日額度、AI 並行數、午夜重置時間、維護／關機狀態、業務工作數與程序運行時間；設定值取自執行中的後端，不在前端寫死預設值。

HTTP 表格顯示五種一般限制的設定、有效識別數／容量、有效視窗請求合計、達上限識別數與超額次數。視窗起點因識別碼而異，不是每秒流量或啟動以來的歷史累計；超額次數不含容量不足或更上層 middleware 的拒絕。來源只回總量，帳號層可回 userID 的視窗資料。登入失敗另分來源與帳號＋來源的有效視窗摘要，同次失敗可能進入兩類，不能相加視為總次數。

監測使用獨立固定 60 秒視窗：每 IP／IPv6 /64 最多 120 次、每已驗證管理員最多 60 次。與一般入口、查詢、管理重置的計數完全分開，不受一般入口耗盡影響，也不被管理重置清除。監測不扣 AI 額度、不呼叫 Gemini、不載入工作單、不寫入或清除任何業務保護狀態；到期與跨午夜只在輸出時投影。仍經過來源驗證與 no-store，CloudFront 也須 CachingDisabled。

維護中可持續讀取監測，重置後畫面立即要求新快照（若監測已被限流則等待 Retry-After）。分頁隱藏、離開或開始重置會取消監測請求；過時回應不覆蓋新快照。恢復可見後自動更新；手動暫停後不自行恢復。429 尊重等待秒數、其他連線或格式錯誤逐步退避，保留舊值並標示不是最新快照；401 停止輪詢並登出，403 停止自動更新。

此功能為單程序、短間隔取樣，沒有逐筆推播、歷史儲存、Gemini Token／帳單或 AWS 費用監控。各儲存依序取樣，並非跨儲存交易；重啟後記憶體數據消失。清除一般計數會增加可用保護額度，不會退還實際費用。

## 日誌與排查

後端以單行 JSON 輸出日誌，warn 與 error 寫入 stderr。預設 `LOG_LEVEL=info`；排查時設 `LOG_LEVEL=debug` 並重啟。debug 不輸出需求單原文、原始 SDK 錯誤或金鑰；欄位名稱含 key、token、secret、password、subject、content 等的值一律顯示 `[REDACTED]`。

排查順序：

1. 啟動後查看 `server.started`（其後沒有 `server.failed`）：確認 `credentialsConfigured=true`、`model`、port 及 CORS origin。這只代表已設定金鑰，不代表金鑰有效。
2. 送出需求單後，找出 `http.request.started`，用相同 `requestId` 追蹤後續日誌。
3. 指定處理人會記錄 `ticket.assigned`；AI 判斷會依序記錄 `limits.reserved`、`ticket.judge.started`、`gemini.generate.started`、`gemini.generate.completed`、`ticket.judge.completed`、`ticket.record.saved`；簽核或退回記錄 `ticket.decided`，轉單記錄 `ticket.transferred`，取消記錄 `ticket.cancelled`。
4. 遇到 `ticket.judge.failed`，查看 `stage`（client.initialize、gemini.generate、response.parse、response.validate）、`upstreamStatus`、`reason`、`hint`、`model`；`tickets.store.unavailable` 代表需求單檔案無法讀寫（`operation` 為 load 或 persist）。

| 診斷原因 | 排查方向 |
| --- | --- |
| `API_KEY_INVALID`／`MISSING_API_KEY` | 後端金鑰是否有效、環境參數是否覆蓋 `.env`、是否已重新啟動 |
| `MODEL_NOT_FOUND` | 模型是否存在、支援結構化輸出且可由目前專案存取 |
| `ACCESS_DENIED` | 金鑰限制、API 啟用、權限與地區限制 |
| `RATE_LIMIT_OR_QUOTA` | 專案配額、速率限制及計費狀態（上游 429 對前端是 429 `RATE_LIMIT_EXCEEDED`） |
| `INVALID_ARGUMENT` | 結構化輸出 schema 與模型是否相容 |
| `NETWORK_ERROR`／`TIMEOUT` | DNS、代理、防火牆、TLS 與連線品質；判斷超過 15 秒也是 `TIMEOUT` |
| `INVALID_AI_RESPONSE` | 模型輸出未通過 JSON 或欄位驗證 |
| `UPSTREAM_UNAVAILABLE`／`UNKNOWN` | 上游服務狀態；未知錯誤保留為未知 |

## HTTP 限流 middleware

`middleware/rateLimiter.js` 使用 express-rate-limit，一般五個 middleware 各有獨立的有界記憶體儲存：`/api` 入口 IP 限流、登入總請求限流、需求單送出／簽核／轉單／取消的帳號限流、部門名單帳號限流、需求單查詢（含已完成）帳號限流。`server.js` 掛載順序為日誌 → API no-store 與選用來源驗證 → CORS → 獨立管理路由 → 一般 /api IP 粗限流 → POST 登入總請求限流 → JSON 解析 → 路由 → 錯誤處理。GET /api/health（含尾斜線）與 OPTIONS 不計入 HTTP 限流。
`ticketRoutes.js` 與 `departmentRoutes.js` 先 authenticate 與 USER 角色驗證，再套用各自的帳號限流，最後才呼叫處理器；帳號 middleware 只採 `req.user.userID`。

HTTP 超限維持 429／`RATE_LIMIT_EXCEEDED` 與既有 JSON，`error.retry_after` 與 `Retry-After` 是相同的實際剩餘整數秒。`http.rate_limit.blocked` 日誌標示 api／login／ticket／departments／query，沒有原始 IP、帳密或 token。被 HTTP 限流拒絕不扣額度，也不呼叫 Gemini。HTTP 計數使用單程序記憶體，重啟歸零，多 instance 各自計數。

## 關機

`index.js` 收到 SIGINT 或 SIGTERM 後停止接受新需求單與連線，等待既有需求單（含預扣、判斷、記錄寫入與租約釋放）完成，最多 `SHUTDOWN_TIMEOUT_MS`；逾時強制關閉連線並以結束碼 1 結束。部署平台的終止寬限須大於這個值。

## 新增功能

例如新增查詢 API：建立 `routes/xxxRoutes.js`，在 `routes.js` 掛載 `router.use('/xxx', xxxRoutes)`，將請求處理放在 `controllers/xxxController.js`，需要業務邏輯時再建立 service；需求單 API 的掛法（`routes/ticketRoutes.js` → `controllers/ticketController.js` → `services/ticketJudge.js`）可作為範例。

SDK 與錯誤處理參考：[Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)、[Express 5 錯誤處理](https://expressjs.com/en/5x/guide/error-handling/)。
