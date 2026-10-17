# Backend

輕量 Express API middleware，使用 ES Modules，適合逐步擴充 3～5 支 API。

## 架構

```text
backend/
├── index.js                 # 啟動、監聽 port、關閉伺服器
├── server.js                # Express app、全域 middleware
├── routes.js                # /api 路由總入口
├── routes/
│   └── agentRoutes.js       # /agent 功能路由
├── controllers/
│   └── agentController.js   # 驗證 HTTP 輸入、回傳 JSON
├── services/
│   ├── geminiAgent.js       # Gemini 推理核心
│   └── knowledgeService.js  # 向量索引、Cosine Top-3 檢索
├── data/
│   └── knowledgeBase.json   # 展示用知識庫段落
├── config/
│   └── env.js               # 載入 backend/.env 與設定預設值
├── middleware/              # 含 rateLimiter.js：入口 IP 與驗證後帳號 HTTP 保護
│   └── errorHandler.js      # 統一錯誤格式與 404
├── tests/                  # API、Agent、檢索與環境參數測試
├── .env                    # 本機設定，不提交 Git
└── .env.example            # 不含金鑰的設定範本
```

請求流程：`server.js → routes.js → agentRoutes.js → agentController.js → geminiAgent.js`。
Agent 先呼叫 `knowledgeService.js` 檢索 Top-3 文件，再送往 Gemini 取得 JSON 決策。
簡單健康檢查直接寫在路由中；需要驗證或業務邏輯的 API 再拆 controller 和 service。

## 啟動

需 Node.js 22.x。若使用 nvm，可在 backend 目錄執行 `nvm use`（未安裝時先 `nvm install`）。

```bash
cd helpdesk_agent/backend
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
DEMO_PASSWORD=<請填入私下提供的登入密碼>
GEMINI_MODEL=gemini-2.5-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
```

`CORS_ORIGIN` 設為實際前端網址。本機未設定金鑰時健康檢查仍可使用，對話 API 回傳 500 `SERVER_ERROR`。
模型可透過 `GEMINI_MODEL` 調整。修改 `.env` 後重新啟動伺服器。

## 本機與 AWS 環境參數

### 登入、限流與配額

帳號為 `admin1`～`admin10`，對應 `user-admin1`～`user-admin10`；登入密碼必須透過後端 `DEMO_PASSWORD` 設定，沒有內建預設值，也不在文件記錄實際密碼。前端不再保存或比對密碼。登入成功簽發 HS256 JWT，預設兩小時有效，對話與用量查詢需要 Bearer 憑證。

| 環境參數 | 預設 | 用途 |
| --- | --- | --- |
| `AUTH_SECRET` | 本機隨機、production 必填 | 至少 32 bytes 的隨機簽章金鑰，多個 instance 必須相同 |
| `AUTH_TTL_SECONDS` | 7200 | 憑證有效秒數 |
| `DEMO_PASSWORD` | 必填，無預設值 | 十個帳號共用的課堂密碼，僅存於未追蹤的 .env 或平台環境參數 |
| `CHAT_COOLDOWN_SECONDS` | 10 | 帳號獲准執行後的冷卻秒數 |
| `USER_DAILY_LIMIT` | 30 | 每帳號每日可獲准執行次數 |
| `GLOBAL_DAILY_LIMIT` | 100 | 所有帳號共用的每日上限，不因帳號增為十個而自動增加 |
| `GLOBAL_CONCURRENCY` | 2 | 全站同時處理上限，每帳號固定同時一筆 |
| `LOGIN_FAILURE_LIMIT` | 100 | 每 IP／IPv6 /64 在視窗內可失敗次數，成功登入不清除 |
| `LOGIN_WINDOW_SECONDS` | 900 | IP 整體登入失敗視窗；達上限後正確帳密也需等待 |
| `LOGIN_ACCOUNT_FAILURE_LIMIT` | 5 | 已知帳號＋IP／IPv6 /64 的失敗次數上限 |
| `LOGIN_ACCOUNT_WINDOW_SECONDS` | 300 | 帳號組合失敗視窗；達上限只封鎖該組合，除非 IP 整體也超限 |
| `HTTP_RATE_WINDOW_SECONDS` | 60 | 四種 HTTP 限流各自使用的視窗秒數 |
| `HTTP_RATE_MAX_KEYS` | 2048 | 每個 HTTP middleware 最多追蹤的識別碼；滿載拒絕新識別碼，不淘汰有效限制 |
| `HTTP_API_LIMIT` | 300 | 每 IP／IPv6 /64 的 API 請求數 |
| `HTTP_LOGIN_LIMIT` | 120 | 每 IP／IPv6 /64 的登入總請求數，包含成功與失敗 |
| `HTTP_CHAT_LIMIT` | 12 | 每個驗證後 userID 的聊天 HTTP 請求數 |
| `HTTP_USAGE_LIMIT` | 30 | 每個驗證後 userID 的用量查詢數 |
| `LIMIT_STORE` | 本機 memory、production dynamodb | 限制狀態儲存，production 拒絕 memory |
| `LIMIT_TABLE` | 無 | DynamoDB 表格名稱 |
| `AWS_REGION` | 無 | DynamoDB 所在區域；亦可用 AWS_DEFAULT_REGION |
| `TRUST_PROXY` | 不信任代理 | 依實際代理鏈填可信任 IP、網段或 hop 數，勿盲目填 true |

冷卻、並行與每日用量皆在呼叫 Gemini 前檢查。帳號與全站每日配額一起預扣，獲准後的上游錯誤也計入，不退額；拒絕或輸入／身分驗證失敗不扣額。台北午夜重置每日計數，但不清除執行中租約或冷卻。這是 Agent 次數上限，不是金額或 token 保證，一次 Agent 可包含多個上游 API 呼叫。

本機記憶體模式只適用單一程序，重啟會歸零。未設定 AUTH_SECRET 時本機使用暫時金鑰，重啟後需重新登入。要在本機保留相同簽章金鑰，可自行產生隨機值放入 `.env`；勿提交或分享：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

登出只清除前端分頁憑證，舊 JWT 到期前仍有效，沒有逐筆撤銷清單。修改 DEMO_PASSWORD 不會撤銷已簽發憑證；需要使全部憑證失效時更換 AUTH_SECRET 並重新部署所有 instance。

### AWS 配額儲存設定

上雲前需另外建立 DynamoDB 表格，設定 **partition key `pk`（String），不設 sort key**。本次程式變更沒有建立或部署任何 AWS 資源。

在 EB 設定 `DEMO_PASSWORD=<私下提供的密碼>`、`NODE_ENV=production`、`LIMIT_STORE=dynamodb`、`LIMIT_TABLE=<表格名稱>`、`AWS_REGION=<表格區域>`、`AUTH_SECRET=<隨機金鑰>`，以及既有 Gemini、CORS 設定。所有 instance 使用相同表格與簽章金鑰；每個獨立部署請使用各自的表格，避免共用配額。

讓 EB EC2 instance profile 具有該表格的 `dynamodb:GetItem` 與 `dynamodb:PutItem` 權限。使用 AWS SDK 的預設憑證鏈，不把 AWS access key 放進原始碼。範例 IAM policy（替換 region、account-id、table-name）：

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
    "Resource": "arn:aws:dynamodb:<region>:<account-id>:table/<table-name>"
  }]
}
```

儲存器使用強一致讀取與單項目的版本條件寫入，原子性更新帳號配額、全站配額、冷卻、並行租約與登入失敗計數。版本競爭最多重算八次；其他儲存錯誤回傳 503，不自動降級放行。寫入結果不明時可能保守消耗配額，但不呼叫 Gemini。此單項目設計適合本課堂規模，並非高流量架構；資料不依賴 TTL 刪除來判定重置。[AWS 版本控制說明](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_ImplementingVersionControl.html)

並行租約為 180 秒，成功或失敗會以租約 ID 釋放；程序崩潰後可於到期復原，舊請求不會釋放新租約。Agent 各上游階段目前逾時 30 秒；若日後增加重試、排隊或更長的執行階段，需一起調整租約與測試。

IP 登入保護只相信 Express 判定的 req.ip。EB 的負載平衡器與反向代理需依實際拓撲設定 TRUST_PROXY，並確保無繞過代理的公開路徑；同一學校 NAT 的同學可能共用 IP，帳號聊天配額則以驗證後身分分開。[Express 代理設定](https://expressjs.com/en/guide/behind-proxies/)

所有業務程式透過 `config/env.js` 的 `env` 取得設定：

- 本機（預設 `development`）：使用固定路徑載入 `backend/.env`，從其他目錄啟動也適用。
- 已存在於 `process.env` 的環境參數優先於 `.env`，不會被覆寫。
- `NODE_ENV=production`：完全不讀取 `.env`，只使用平台環境參數。
- production 缺少 `GEMINI_API_KEY`、`CORS_ORIGIN`、`AUTH_SECRET`、DynamoDB 表格或區域設定時停止啟動，錯誤不輸出金鑰值。

請將 `NODE_ENV` 設在 shell 或平台上，而非 `.env`，讓程式在載入檔案前決定模式。
Gemini 金鑰只供 backend 使用，不應放在 frontend 的任何設定中。

### Elastic Beanstalk 設定

在 AWS Console 選擇環境 → Configuration → Updates, monitoring, and logging → Edit，
於 Environment properties 設定以下參數並套用：

| 名稱 | 值 | 說明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 啟用雲端模式，跳過 `.env` |
| `GEMINI_API_KEY` | 你的真實金鑰 | 僅在 AWS 平台填入，不寫進程式碼或部署設定檔 |
| `CORS_ORIGIN` | `https://你的帳號.github.io` | 只填 origin，不含專案路徑或結尾斜線 |
| `GEMINI_MODEL` | `gemini-2.5-flash` 或可用模型 | 選填，覆寫預設模型 |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | 選填，向量模型需支援 RETRIEVAL_DOCUMENT／QUERY |

`PORT` 使用 EB Node.js 平台提供的值，程式已透過 `process.env.PORT` 讀取；
不需要在 AWS 複製本機 `PORT=3000`。
設定方式參考 [AWS 環境參數文件](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environments-cfg-softwaresettings.html)。

部署以 **backend 目錄為應用程式根目錄**。已加入 `Procfile`，以 `npm start` 啟動；
程式會監聽平台提供的 port。選擇 Node.js 22.x、仍受支援的 EB 平台。
可將健康檢查路徑設為 `/api/health`。
[AWS Node.js 平台文件](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/create_deploy_nodejs.container.html)

`backend/.ebignore` 供 EB CLI 排除 `.env`、環境變數檔案與 `node_modules`；
只有不含真實金鑰的 `.env.example` 保留。
使用 `.ebignore` 時，EB CLI 不再使用 `.gitignore`。
若手動上傳 ZIP，這份忽略規則不會自動生效，必須自行排除上述檔案，
並讓 `package.json`、`Procfile` 直接位於 ZIP 根目錄，不能再包一層 backend 資料夾。
[EB CLI 忽略規則](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/eb-cli3-configuration.html)、
[AWS 部署包格式](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/applications-sourcebundle.html)

Elastic Beanstalk 本身不收額外服務費，但 EC2、儲存與其他資源仍可能產生費用；
能否免費取決於帳號的 Free Tier／額度與實際資源使用。
[AWS 費用說明](https://aws.amazon.com/elasticbeanstalk/faqs/)

## 日誌與 Gemini 串接排查

後端以單行 JSON 輸出日誌。預設 `LOG_LEVEL=info`；需要詳細診斷時，在 `backend/.env` 加入
`LOG_LEVEL=debug` 並重新啟動。也可從 shell 暫時啟用：

```bash
cd backend
LOG_LEVEL=debug npm start
```

可用等級為 `debug`、`info`、`warn`、`error`、`silent`。正式環境使用平台環境變數。
設定不會修改 `.env` 的真實金鑰；debug 亦不輸出問題、文件、回答原文、原始 SDK 錯誤或金鑰。

排查順序：

1. 啟動後查看 `server.started`：確認 `credentialsConfigured=true`、`model`、`embeddingModel`、port 及 CORS origin。這只代表已設定金鑰，不代表金鑰有效或 Gemini 已連線。
2. 前端送出問題後，找出 `http.request.started`，用相同 `requestId` 追蹤後續日誌。
3. `gemini.embedding.started` 的 `taskType=RETRIEVAL_DOCUMENT` 是首次建立文件索引，`RETRIEVAL_QUERY` 是問題向量；`gemini.generate.started` 才是推理呼叫。
4. 遇到 `gemini.embedding.failed` 或 `agent.failed`，查看 `stage`、`upstreamStatus`、`reason`、`hint`、`model`。若檢索先失敗，本次不會進入推理呼叫。
5. 成功時會看到 `agent.completed` 及 HTTP 200；debug 另有索引快取、向量維度、回應長度與 token 使用量。`gemini.generate.completed` 只表示上游呼叫完成，仍須通過解析與驗證。

| 診斷原因 | 排查方向 |
| --- | --- |
| `API_KEY_INVALID`／`MISSING_API_KEY` | 後端金鑰是否有效、環境參數是否覆蓋 `.env`、是否已重新啟動 |
| `MODEL_NOT_FOUND` | 失敗階段所用模型是否存在、支援該 API 且可由目前專案存取 |
| `ACCESS_DENIED` | 金鑰限制、API 啟用、權限與地區限制 |
| `RATE_LIMIT_OR_QUOTA` | 專案配額、速率限制及計費狀態 |
| `INVALID_ARGUMENT` | embedding 參數或推理結構化輸出 schema 與模型是否相容 |
| `NETWORK_ERROR`／`TIMEOUT` | DNS、代理、防火牆、TLS 與連線品質；有可辨識的網路代碼時顯示 `networkCode` |
| `INVALID_EMBEDDING`／`INVALID_AI_RESPONSE` | API 回傳內容未通過向量、JSON 或欄位驗證 |
| `UPSTREAM_UNAVAILABLE`／`UNKNOWN` | 上游服務狀態；未知錯誤保留為未知，不以猜測當成根因 |

前端仍遵守既有 API 錯誤格式，不接收供應商內部錯誤。若需分享排查資訊，可提供失敗事件的安全日誌，不必提供 `.env`。

## API 端點

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 檢查伺服器是否運作，不檢查 Gemini 連線 |
| POST | `/api/auth/login` | 驗證十組帳號並取得登入憑證 |
| GET | `/api/agent/usage` | 以 Bearer 憑證查詢剩餘配額，不消耗 Agent 次數 |
| POST | `/api/agent/chat` | Top-3 檢索、意圖辨識、信心評估與工單分流 |
| OPTIONS | `/api/agent/chat` | CORS 預檢，由 middleware 處理 |

以下 `<PASSWORD>`、`<token>` 為佔位文字，請自行替換，勿提交實際值。

```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin1","password":"<PASSWORD>"}'
# 將登入回應的 token 填入下方，勿提交實際 token。
curl -X POST http://localhost:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"message":"請問如何重設密碼？","userID":"user-admin1"}'
```

`message` 必須是非空白字串，去除首尾空白後最長 500 個 Unicode code points；JSON 本文上限 16 KB。

成功回應：

```json
{
  "intent": "IT_SUPPORT",
  "retrieved_sources": [{"doc_name": "VPN連線故障排查手冊.md", "relevance": 0.89}],
  "confidence_score": 88,
  "action_route": "AUTO_REPLY",
  "reply_text": "請確認 VPN 憑證與帳號狀態。",
  "ticket_payload": null
}
```

錯誤回應：

```json
{"error":{"code":"INVALID_PAYLOAD","message":"..."}}
```

對話成功直接回傳規格書的物件，不包 `success` 或 `data`。
錯誤包含 400 輸入無效、401 未登入／登入失敗、403 身分不符、429 冷卻／每日配額／處理中、503 全站忙碌／儲存故障，以及原有上游錯誤。完整代碼以專案 API 規格書為準。
保留未知路由 404 與 JSON 大小限制 413；有等待期限時回傳 `Retry-After` 與 `error.retry_after`（秒），不是固定十秒。對話成功回應另有 `X-User-Remaining`、`X-Global-Remaining` 標頭，CORS 已公開供前端讀取。

## Agent 與知識庫

1. 從 `data/knowledgeBase.json` 載入本地文件段落（`doc_name`、`content`）。
2. 第一次請求呼叫 Gemini embedding API 建立文件向量，索引保存在記憶體並供後續請求重用。
3. 每次將提問轉成向量，以 Cosine Similarity 排序取 Top-3；負相似度顯示為 0，回應保留四位小數。
4. 將真實檢索段落傳入 Gemini，使用 `responseMimeType: application/json` 和 JSON schema 限定輸出。
5. 後端驗證分類、分數與工單欄位；來源名稱與分數一律取自檢索結果。
6. 最終分數 >= 75 時自動回覆；< 75 時組合工單資料並回傳前端。沒有文件、模型要求轉派或明確硬體危險字詞出現時，分數最高 74。

工單包含 `ticket_id`、`level`、`department`、`action_required`，
ID 由後端使用 UUID 生成。明確危險字詞會觸發 `HARDWARE_FACILITY`／`P1_URGENT`；
字詞比對是保守補強，並非完整緊急事件分類器，其他事件仍由模型判斷。
模型提供的信心分數不是經過校準的正確率，應透過專題測試案例評估。

知識庫目前採用範例的三份展示資料，請替換成小組確認的正式規章段落；
每筆代表一個已切好的段落，尚未加入長文件自動切片。
文件段落與使用者提問會送往 Gemini 產生向量與決策。
第一次請求會額外建立文件 embedding，之後每次仍會呼叫 query embedding 與推理 API。
修改知識庫後需重啟；各 EB instance 的索引獨立，重啟後重建。

本專題的「建立工單」指產生供前端顯示的工單資料，後端只回傳 `ticket_payload`，
不需要資料庫或工單保存／派送服務。`ticket_id` 是本次產生的展示編號，
`department` 和 `action_required` 是建議處置資料，不代表已實際派送或通知部門。

前端收到回應後依 `action_route` 處理：

- `AUTO_REPLY`：顯示 `reply_text`，`ticket_payload` 為 `null`。
- `ESCALATE_TICKET`：顯示 `reply_text`，並將 `ticket_payload` 的四個欄位呈現在右側工單資料區。

例如「建立工單」的回應片段（完整回應另含 intent、retrieved_sources、confidence_score）：

```json
{
  "action_route": "ESCALATE_TICKET",
  "reply_text": "已產生工單資料，可於工單頁面查看。",
  "ticket_payload": {
    "ticket_id": "TK-123e4567-e89b-42d3-a456-426614174000",
    "level": "P3_NORMAL",
    "department": "IT資訊服務台",
    "action_required": "人工確認 VPN 連線問題"
  }
}
```

工單資料區由 frontend 呈現，後端提供 JSON，不回傳 HTML。
程式維持單次推理，沒有對話歷史。

結構化輸出與向量 API 參考：
[Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)、
[Gemini Embeddings](https://ai.google.dev/gemini-api/docs/embeddings)。

## Express 與 HTTPS

`index.js` 負責監聽；`server.js` 設定 JSON、CORS、路由與統一錯誤 middleware。
Express 5 會將 async controller 的例外交給錯誤 middleware。
CORS 來源取自 `CORS_ORIGIN`，允許 POST／OPTIONS 與健康檢查 GET。

本機使用 HTTP；正式環境依規格需在 AWS 負載平衡器／反向代理配置憑證與 HTTPS，
由其終止 TLS 後轉送 Express。僅部署 Node.js 或將網址改為 `https://` 不會自動配置 HTTPS。
GitHub Pages 前端應呼叫已實際配置 HTTPS 的後端網址。
[AWS HTTPS 設定](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/configuring-https.html)

## 新增功能

例如新增知識庫查詢 API：建立 `routes/knowledgeRoutes.js`，在 `routes.js` 掛載
`router.use('/knowledge', knowledgeRoutes)`，將請求處理放在 `controllers/knowledgeController.js`。
需要業務邏輯時再建立 service；工單資料已包含於 chat 回應，不需獨立建立工單 API。

目前已加入後端登入驗證與限制。CORS 只控制瀏覽器跨來源讀取，不代替身分驗證；正式部署須完成上述簽章金鑰、DynamoDB 與代理設定。

SDK 與錯誤處理參考：[Gemini SDK](https://googleapis.github.io/js-genai/release_docs/classes/types.GenerateContentResponse.html)、
[Express 5 錯誤處理](https://expressjs.com/en/5x/guide/error-handling/)。

## 本次後端可靠性調整

執行版本為 Node.js 22.x。一般工單的 department 一律由後端依 intent 映射，模型不得覆寫。
明確符合既有危險關鍵字時，通過登入及配額檢查後直接產生本地 P1 工單資料，不呼叫 Gemini；不代表已派送或通知。

`AGENT_TIMEOUT_MS` 預設 60000，限制整次檢索與推理，最多允許 120000；逾時維持 HTTP 500／SERVER_ERROR，且不退還已預扣配額。
每個上游呼叫另有 30 秒限制；總期限訊號會取消查詢 embedding 與推理的本地等待，不保證供應商停止執行或計費。
共用文件索引不綁定單一請求的取消訊號，避免影響其他請求，仍有 30 秒呼叫限制；取消後不再開始該請求的下一階段。
前端目前等待 100 秒，若調高總期限，須一併協調前端、反向代理及關機期限。

`SHUTDOWN_TIMEOUT_MS` 預設 75000，必須至少比 Agent 總期限多 10000。
關機先停止新對話，再等待 HTTP 連線及已追蹤對話（包含預扣與租約釋放）；成功回應也會在嘗試釋放租約後才送出。
儲存服務故障仍依既有規則記錄失敗、等待租約到期，不保證故障時已成功清除。
雲端程序管理器與代理的關機／請求期限需配合設定，否則平台仍可能提早中斷程序。

已實作的 HTTP 限流、學校 Wi-Fi 注意事項及暫緩的 DynamoDB 工作，見 [後端保護與上雲待辦](後端保護與上雲待辦.md)。

## HTTP 限流 middleware

`middleware/rateLimiter.js` 使用 express-rate-limit，四個 middleware 各有獨立的有界記憶體儲存。
`server.js` 掛載順序為日誌 → CORS → /api IP 粗限流 → POST 登入總請求限流 → JSON 解析 → 路由 → 錯誤處理。
GET /api/health（含尾斜線）與 OPTIONS 不計入 HTTP 限流。
`agentRoutes.js` 先 authenticate，再套用聊天／用量的 userID 限流，最後才呼叫 controller／用量儲存。
驗證失敗仍計入入口 IP 請求數；帳號 middleware 只採 req.user.userID，不採本文的 userID。

HTTP 超限維持 429／RATE_LIMIT_EXCEEDED 與既有 JSON，error.retry_after 與 Retry-After 是相同的實際剩餘整數秒。
`http.rate_limit.blocked` 日誌標示 api／login／chat／usage，沒有原始 IP、帳密或 token。
被 HTTP 限流拒絕不扣 Agent 額度；HTTP 計數包括成功及失敗，不等於每日 Agent 用量。
每個 HTTP 儲存最多 HTTP_RATE_MAX_KEYS 筆，請求時清除到期項目；容量不足以 503／SERVICE_BUSY 拒絕新識別碼。

登入失敗另外沿用 usageService 與 LIMIT_STORE 原子保存；已知帳號與來源組合達五次後，同 IP 其他帳號仍可登入，除非來源整體已達一百次。
未達封鎖前成功登入只清除該帳號組合，不清除 IP 整體失敗；兩種視窗各自到期。
未知帳號、無效格式只累積來源整體，不為任意 username 建桶；登入失敗狀態最多 512 筆，滿載保守拒絕。
IPv6 入口與失敗計數皆以 /64 分組，避免切換同子網地址繞過；校園網段仍可能共用此限制，須依課堂實測調整。

HTTP 計數不使用 DynamoDB，重啟歸零、多 instance 各自計數；production 的 Agent 配額與登入失敗仍強制 LIMIT_STORE=dynamodb。
本次未啟用或驗證實際 AWS 服務。若現有 .env 或平台仍設定 LOGIN_FAILURE_LIMIT=10，會覆寫新預設；課堂設定應依同意的新規則改成 100。
