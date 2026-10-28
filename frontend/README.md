# 智慧服務台前端

純 HTML、CSS 與原生 JavaScript（ES module），不使用框架，沒有需要安裝的 npm 依賴。四個頁面：管理頁、登入頁、提出需求單頁、狀態追蹤頁（追蹤、簽核、轉單、取消與簽核紀錄查詢）；對話頁已移除。

統一使用 Node.js 22，根目錄 `.nvmrc` 指定 22。

## 本機啟動

先在另一個終端機啟動後端（見 [後端說明](../backend/README.md)），再於 **frontend 目錄**啟動靜態伺服器：

```bash
cd frontend
npm run dev
```

`npm run dev` 實際執行 `python3 -m http.server 5173 --bind localhost`。Windows 通常沒有 `python3` 指令，改在 frontend 目錄執行：

```powershell
py -m http.server 5173 --bind localhost
```

瀏覽器開啟 **http://localhost:5173**。必須用 `localhost`（後端 CORS 預設只允許這個來源），不可用 `127.0.0.1`，也不可直接雙擊 HTML 以 `file://` 開啟。靜態伺服器必須在 frontend 目錄啟動；若看到整個專案的檔案清單而不是登入頁，代表啟動位置錯了，按 Control + C 停止後改在 frontend 目錄重啟。

## 頁面目錄

管理頁與工作單追蹤頁各自放在獨立資料夾，HTML 與頁面 CSS 放在一起；共享樣式與 JavaScript 元件維持共用。

```text
frontend/
├── index.html
├── propose.html
├── base.css
├── propose.css
├── admin/
│   ├── admin.html
│   └── admin.css
├── tickets/
│   ├── tickets.html
│   └── tickets.css
├── shared/
│   └── layout.css
└── src/
    ├── pageUrls.js
    ├── admin.js
    ├── tickets.js
    ├── components/
    ├── services/
    └── utils/
```

靜態伺服器仍從 frontend 根目錄啟動。管理頁路徑為 `admin/admin.html`，追蹤頁為 `tickets/tickets.html`；舊根目錄的同名頁面已搬移，書籤需更新。以登入頁進入時會自動跳轉至正確位置。所有 HTML 的樣式、腳本與導覽連結均按各頁深度設定；程式導頁統一透過 `src/pageUrls.js`，不硬編碼網站根路徑或 repo 名稱。

## 頁面與檔案

| 路徑 | 說明 |
| --- | --- |
| `index.html`、`src/login.js` | 登入頁：左側說明、右側登入表單；必填檢查、密碼顯示切換、登入後依 USER／ADMIN 導向提出需求單頁／管理頁 |
| `admin/admin.html`、`admin/admin.css`、`src/admin.js`、`src/services/adminService.js` | 管理頁與獨立 API 服務：每 5 秒監測用量與限制，亦可輸入確認文字後清空工作單及重置一般保護計數 |
| `propose.html`、`src/propose.js` | 提出需求單頁：主題與需求內容（字數提示）、指定處理人可搜尋選單（輸入英文姓名或部門即時過濾，依部門分組列出同事帳號，支援鍵盤上下鍵、Enter、Esc）、送出結果視窗（含前往狀態追蹤頁的連結）、各部門業務範圍視窗 |
| `tickets/tickets.html`、`src/tickets.js` | 狀態追蹤頁：「表單追蹤」分「待簽核」（等我簽核的單可簽核、退回、轉單或替提單人取消；我送出還在等的單可取消）與「已退回」（我被退回的單，可重新提出）；「已完成」查詢我已結案的單與本部門的簽核紀錄（預設最新 100 筆，關鍵字、結果、日期與常用區間篩選） |
| `base.css`、`login.css`、`propose.css`、`tickets/tickets.css` | 共用基礎樣式與各頁專屬樣式；頂欄、導覽及帳號選單使用 shared/layout.css |
| `src/components/handlerPicker.js` | 指定處理人的可搜尋選單（combobox）：關鍵字過濾、鍵盤操作、清除、隱藏欄位保存選定的處理人 id |
| `src/components/account.js` | 頂欄帳號選單（帳號、使用者代號、所屬部門、登出）與登入守門，一般頁與管理頁共用，角色不符時導回對應首頁 |
| `src/pageUrls.js` | 由模組位置建立各頁網址，統一登入／登出／跨頁跳轉，支援 GitHub Pages 專案子路徑 |
| `shared/layout.css` | 提單與追蹤頁共用的頂欄、導覽、帳號選單與介紹文字 |
| `src/config.js` | localhost:5173 的開發頁面使用 localhost:3000；Docker／正式網站使用目前 origin，不含 `/api` |
| `src/services/authService.js` | 後端登入、sessionStorage 工作階段（含所屬部門）與登出；只檢查 `user-<名.姓>` 的格式，帳號名單由後端決定 |
| `src/services/ticketService.js` | 部門名單、送單、我的需求單、部門需求單、已完成查詢、簽核、轉單與取消的存取、欄位驗證、回應整理與錯誤提示對應 |
| `src/components/adminReset.js` | 管理重置表單：確認文字、防重送、結果與錯誤提示，以及重置期間協調監測暫停／恢復 |
| `src/components/ticketTracking.js` | 待簽核／已退回追蹤清單，處理身分標籤、重複單與數量／空狀態 |
| `src/components/ticketCard.js` | 可展開的需求單卡片，顯示摘要、內容、送達資訊、歷程及重新提出按鈕 |
| `src/components/ticketActions.js` | 簽核／退回／轉單／取消表單，管理備註驗證、目標選單、按鈕鎖定與錯誤提示 |
| `src/components/completedTickets.js` | 已完成面板，管理篩選、快速日期、查詢與結果摘要 |
| `src/components/ticketText.js`、`src/utils/ticketFormatters.js` | 共用文案及純顯示函式：台北時間、日期區間、歷程、送達與筆數摘要 |
| `src/components/adminMonitoring.js`、`src/components/adminMetrics.js` | 管理監測的輪詢生命週期與安全文字渲染：隱藏暫停、退避、舊回應防護 |
| `src/components/dialogs.js` | 結果視窗文案與部門卡片的繪製 |
| `src/components/dom.js` | 以 `textContent` 建立元素，避免 HTML 注入 |
| `tests/` | 多個測試檔，以瀏覽器替身執行，不驗證版面，也不呼叫 Gemini 或真後端 |

`src/admin.js` 與 `src/tickets.js` 是頁面組裝入口：驗證登入、提供 service 依賴、協調元件與資料更新。管理頁分成監測與重置兩個獨立元件；工作單頁分成追蹤清單、卡片、操作表單與已完成篩選面板。元件透過明確的參數及回呼溝通；API 存取集中在 services，純顯示規則放在 utils。測試直接匯入對應元件或工具，頁面測試則驗證組裝後的完整流程。

前端是原生 ES Modules，不會讀取任何 `.env`；要改後端網址就編輯 `src/config.js`。Gemini 金鑰只存在後端。

## 流程

1. **登入**：輸入十組英文姓名帳號之一（例如 `racky.huang`，完整名單與所屬部門見 API 介面規格書）與授課者另行提供的密碼（輸入框提示為「員工英文姓名（例如 alex.huang）」，後端接受十組一般帳號與獨立的 alex.admin 管理員）。帳號與密碼只有空白也算空白，顯示「請輸入帳號與密碼」；登入請求結束後（成功、失敗或連線失敗）一律清空密碼。憑證只存在本分頁的 sessionStorage，關閉分頁即失效。
2. **載入名單**：進入提出需求單頁後以 `GET /api/departments` 載入處理人與部門。載入中搜尋框停用；成功後點擊或輸入即展開清單，依部門分組顯示帳號名稱並依關鍵字（帳號或部門名稱，不分大小寫）即時過濾，沒有處理人的部門不列出，選定後顯示「預計送達：帳號（部門）」並可用 × 清除；失敗時（含舊版後端回 404、格式不正確）搜尋框維持停用並改為「名單無法載入，由 AI 判斷部門」，表單上方顯示原因，仍可送出需求單。
3. **送出需求單**：主題 1～100 字、需求內容 1～2000 字（去除首尾空白後以 Unicode code points 計）；兩欄一起檢查，錯誤顯示在欄位下方並把焦點移到第一個有錯的欄位。送出中按鈕改為「送出中…」、主題與內容唯讀、「清除重填」鎖住。
4. **結果視窗**：依後端回傳的 `route` 顯示送達對象與方式：`HANDLER` 為「姓名（部門）」、`DEPARTMENT` 為 AI 判斷的部門（有判斷依據時多一列）、`FALLBACK` 為預設部門並由人工分派。以任何方式關閉視窗都會清空表單並把焦點放回主題。
5. **錯誤**：429 非額度錯誤時送出鈕改為「請等 N 秒」倒數（超過 300 秒或沒有秒數則只顯示提示）；額度用盡、400、403、404、413、503、其他 5xx、連線失敗、逾時與無法辨識的回應各有固定提示；憑證失效（401）清除登入狀態並回到登入頁。完整規則見開發規格書「送出結果與錯誤處理」。

6. **追蹤與簽核**：狀態追蹤頁依「進行中／已結案」分兩個分頁。「表單追蹤」的「待簽核」區先列送達本部門、等我簽核的需求單（同部門的任何一般帳號都可以簽核或退回，備註最多 200 字；可轉單到其他部門並指定該部門的處理人，用於 AI 判斷錯誤時改派；可替提單人取消，原因必填），再列我送出且仍在等待的需求單（可取消，原因選填）；「已退回」區列我被退回的需求單與退回原因，「重新提出」會把主題與內容帶到提出需求單頁。「已完成」分頁查詢我提出且已結案的需求單與本部門的簽核紀錄，預設最新 100 筆，可用關鍵字、結果、簽核日期與常用區間篩選。每張卡片顯示狀態、送達對象、判斷依據、簽核人與備註、轉單紀錄與歷程。一般帳號沒有刪除功能；管理員可執行全站清除。403、404、409 提示顯示在卡片內。

需求單送出後的「送達」不會實際通知任何人；所有需求單與簽核紀錄由後端保存在 `backend/data/tickets.json`。

## 測試

```bash
cd frontend
npm test
```

測試以 `node --test` 執行，使用 fetch 與 DOM 替身驗證請求合約、欄位驗證、錯誤提示、倒數與頁面流程；不會呼叫付費 API。實際串接請啟動後端並在頁面操作。

## 管理員與正式部署

`alex.admin` 是應用程式管理員，屬於 dept-it-1，使用後端 `ADMIN_PASSWORD`，不是 AWS IAM 登入憑證。其登入回應 `user.role` 為 ADMIN，一般帳號為 USER。管理員登入直接前往 admin/admin.html，不顯示提單、查詢或簽核功能；直接開一般頁也會導回管理頁。角色仍由後端授權，修改 sessionStorage 無法取得權限。

管理頁要求完整輸入 `RESET_HELPDESK` 後才啟用按鈕，呼叫 `POST /api/admin/reset`。此操作永久清空工作單與全站一般限量限流；管理操作的 IP／帳號頻率保護不重置。等待時鎖定輸入與按鈕，完成顯示清除筆數與台北時間。401 回登入頁，403／429／503 顯示後端提示，網路中斷顯示結果尚未確認且不自動重試。

目前使用單台 Lightsail＋Docker Compose＋Caddy 同站點部署，不再需要 GitHub Pages 或 CloudFront。Caddy 提供 HTML／CSS／JS，將 `/api` 轉送後端；`src/config.js` 自動使用目前網站的 origin，不必在部署時改 JS。原本 `localhost:5173` 的 Python 開發伺服器仍連到 `localhost:3000`。正式 CORS_ORIGIN 設為網站 HTTPS origin，不含頁面路徑。完整操作見 [Docker 與 Lightsail 部署操作手冊](../Docker與Lightsail部署操作手冊.md)。

## 管理監測更新方式

管理頁透過獨立 service 的 `GET /api/admin/metrics` 讀取唯讀資料，每次完成後等待 5 秒再更新，沒有重疊請求；可以按「立即更新」或「暫停自動更新」。顯示實際限制設定、AI 全站及各 USER 帳號用量、冷卻、處理中數量、HTTP 視窗與登入失敗摘要。上限來自後端執行設定，不使用前端預設數字。

最後成功取樣時間以台北時區顯示。更新失敗仍保留舊資料並標示陳舊狀態，429 依 Retry-After 等待，其他錯誤逐步退避；401 停止並回登入頁，403 暫停自動更新。隱藏分頁／離開時中止輪詢，恢復可見時繼續；管理重置期間先暫停，完成後要求新快照，忽略重置前的延遲回應。

監測獨立限制每 IP 120 次／分鐘、每管理員 60 次／分鐘，不扣 AI 或一般查詢額度，也不被重置清除。HTTP 顯示仍有效視窗的合計，來源 IP 不公開；登入來源與帳號＋來源可能重複計數。資料只代表目前程序，沒有歷史圖表、逐筆推播、Token 或實際費用統計。
