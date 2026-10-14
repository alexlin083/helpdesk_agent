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
├── middleware/
│   └── errorHandler.js      # 統一錯誤格式與 404
├── tests/                  # API、Agent、檢索與環境參數測試
├── .env                    # 本機設定，不提交 Git
└── .env.example            # 不含金鑰的設定範本
```

請求流程：`server.js → routes.js → agentRoutes.js → agentController.js → geminiAgent.js`。
Agent 先呼叫 `knowledgeService.js` 檢索 Top-3 文件，再送往 Gemini 取得 JSON 決策。
簡單健康檢查直接寫在路由中；需要驗證或業務邏輯的 API 再拆 controller 和 service。

## 啟動

需 Node.js 20 以上。若使用 nvm，可在 backend 目錄執行 `nvm use`（未安裝時先 `nvm install`）。

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
GEMINI_API_KEY=你的金鑰
GEMINI_MODEL=gemini-2.5-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
```

`CORS_ORIGIN` 設為實際前端網址。本機未設定金鑰時健康檢查仍可使用，對話 API 回傳 500 `SERVER_ERROR`。
模型可透過 `GEMINI_MODEL` 調整。修改 `.env` 後重新啟動伺服器。

## 本機與 AWS 環境參數

所有業務程式透過 `config/env.js` 的 `env` 取得設定：

- 本機（預設 `development`）：使用固定路徑載入 `backend/.env`，從其他目錄啟動也適用。
- 已存在於 `process.env` 的環境參數優先於 `.env`，不會被覆寫。
- `NODE_ENV=production`：完全不讀取 `.env`，只使用平台環境參數。
- production 缺少 `GEMINI_API_KEY` 或 `CORS_ORIGIN` 時立即停止啟動，錯誤只顯示參數名稱。

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
程式會監聽平台提供的 port。選擇 Node.js 20 以上、仍受支援的 EB 平台。
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

## API

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 檢查伺服器是否運作，不檢查 Gemini 連線 |
| POST | `/api/agent/chat` | Top-3 檢索、意圖辨識、信心評估與工單分流 |
| OPTIONS | `/api/agent/chat` | CORS 預檢，由 middleware 處理 |

```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"請問如何重設密碼？"}'
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
錯誤使用 400 `INVALID_PAYLOAD`、429 `RATE_LIMIT_EXCEEDED`、500 `SERVER_ERROR`。
另外保留未知路由 404 與超過 JSON 大小限制的 413；429 回應附 `Retry-After: 10`。
目前 429 來自 Gemini 推理或 embedding 限流，尚未實作後端使用者流量限制。

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
- `ESCALATE_TICKET`：顯示 `reply_text`，並將 `ticket_payload` 的四個欄位呈現在另開新分頁的簡易工單 HTML。

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

工單 HTML 與開啟分頁由 frontend 實作，後端提供 JSON，不回傳 HTML。
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

此版本供本機開發，尚未加入登入驗證與流量限制。CORS 只控制瀏覽器跨來源讀取，
不會阻擋其他客戶端；公開對話 API 前應加入驗證與流量限制，以控制 Gemini 使用額度。

SDK 與錯誤處理參考：[Gemini SDK](https://googleapis.github.io/js-genai/release_docs/classes/types.GenerateContentResponse.html)、
[Express 5 錯誤處理](https://expressjs.com/en/5x/guide/error-handling/)。
