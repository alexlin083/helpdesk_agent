# 智慧服務台前端

使用原生 HTML、CSS、ES Modules，無需安裝前端依賴。需 Python 3 啟動靜態伺服器，Node.js 20 以上執行測試。

## 本機啟動

先在另一個終端機執行後端：

```bash
cd /Users/liweimac/helpdesk_agent/backend
npm start
```

再啟動前端：

```bash
cd /Users/liweimac/helpdesk_agent/frontend
npm run dev
```

瀏覽器開啟 **http://localhost:5173**，請勿直接雙擊 HTML 使用 `file://`。
首頁為登入畫面，使用 `admin1`～`admin10`，密碼皆為 `123456`。登入後進入 `chat.html`，右上角顯示帳號與 userID 並提供登出。
後端預設 CORS 來源即為此網址；若變更前端網址，同步設定後端 `CORS_ORIGIN` 並重新啟動。

## 架構與設定

- `src/app.js`：協調表單提交、服務請求與畫面狀態。
- `index.html`、`src/login.js`：登入畫面與登入後導頁。
- `chat.html`：需前端登入狀態的對話頁。
- `src/services/authService.js`：後端登入、憑證與 sessionStorage 工作階段管理。
- `src/components/ChatPanel.js`：聊天紀錄、範例、輸入驗證、等待提示與逐字顯示。
- `src/components/DecisionPanel.js`：意圖、Top-3 來源、信心與分流、工單及完整 JSON。
- `src/components/dom.js`：安全的純文字元素建立工具。
- `src/services/agentService.js`：對話與用量 API 存取入口，處理 HTTP、逾時、錯誤及合約驗證。
- `src/config.js`：設定公開的後端 origin，預設 `http://localhost:3000`；不含 `/api`。

原生 ES Modules 不會讀取 `.env`。Gemini 金鑰只設定在後端；前端不保存金鑰。
部署 GitHub Pages 時可直接使用本目錄的靜態檔案，將 API origin 改為實際 HTTPS 網址，並設定後端 CORS。這次實作未執行部署。

## 需求與 API 對應

以專案根目錄的《企業智慧服務台 Agent 前後端 API 介面規格書》為介面依據：

| 需求 | 前端行為 |
| --- | --- |
| 單次問答 | `POST /api/agent/chat`，傳 `{ "message": "...", "userID": "user-admin1" }`；畫面保留聊天紀錄，後端不接收歷史 |
| 輸入 | 去除首尾空白，限制 1～500 個 Unicode code points；Enter 或按鈕送出 |
| 等待 | 請求開始後至少十秒不能再次送出，輸入框下方顯示倒數與說明；若 API／回覆顯示超過十秒，完成前仍鎖定送出 |
| 左側聊天 | 區分員工與 AI 訊息，完整回答到達後以打字效果顯示；支援減少動態效果偏好 |
| 右側資料 | 顯示 `intent`、`retrieved_sources`、`confidence_score`、`action_route` |
| 分流 | `AUTO_REPLY` 綠色、`ESCALATE_TICKET` 黃色；門檻為 75 分 |
| 工單 | 顯示四個工單欄位與可展開 JSON；目前僅展示，不保存、派送或通知部門 |
| 錯誤 | 顯示後端錯誤提示，解除輸入鎖定，仍須等待十秒冷卻到期才可重試；不自動重送 |
| 附加檢視 | 可展開完整 API JSON，方便驗證 Gemini 串接 |

目前採用規格書的右側工單預覽方式，未新增另開工單分頁。規格範例中的「已立案」不代表目前後端已串接工單系統，介面依實際功能明確標示。
資料使用純文字渲染，不將 AI 回覆或問題當成 HTML。重整頁面即清除聊天紀錄。

十個 userID 依序為 `user-admin1`～`user-admin10`，重新登入同一帳號不會改變。sessionStorage 保存後端簽發的 JWT、期限與身分，不保存密碼；有效期內重新整理維持登入，登出後清除。所有導頁使用相對路徑，支援 GitHub Pages 的專案子目錄。

登入改由 `POST /api/auth/login` 驗證，對話與 `GET /api/agent/usage` 均攜帶 Bearer 憑證。後端以驗證後的身分執行冷卻、並行與配額檢查，偽造本文 userID 不能切換計費身分。頁面顯示帳號與全站剩餘次數及重置時間；憑證失效則回登入。登出只清除本分頁憑證，舊 JWT 到期前仍有效。

## 驗證

```bash
npm test
```

測試以替代 fetch 驗證請求合約及錯誤處理，不會呼叫付費 API。實際串接需啟動後端並設定有效金鑰後，在頁面送出問題。
