# 智慧服務台前端

純 HTML、CSS 與原生 JavaScript（ES module），不使用框架，沒有需要安裝的 npm 依賴

Node.js 版本與前後端 `engines` 的規定見[後端說明](../backend/README.md)

## 本機啟動

先在另一個終端機啟動後端（見 [後端說明](../backend/README.md)），再於 **frontend 目錄**啟動靜態伺服器：

```bash
cd frontend
npm run dev
```

開發伺服器（`npm run dev`）的行為、要開啟的瀏覽器網址與啟動位置錯誤的處理見[專案說明](../README.md#本機啟動)

## 頁面目錄

登入頁 `index.html` 留在 frontend 根目錄；其他頁面各自放在 `pages/` 底下的資料夾，HTML 與該頁 CSS 放在一起；共用樣式集中在 `styles/`，JavaScript 統一放在 `src/`。

```text
frontend/
├── index.html                 # 登入頁
├── pages/
│   ├── propose/
│   │   ├── propose.html       # 提出需求單頁
│   │   └── propose.css
│   ├── tickets/
│   │   ├── tickets.html       # 狀態追蹤頁
│   │   └── tickets.css
│   └── admin/
│       ├── admin.html         # 管理頁
│       └── admin.css
├── styles/
│   ├── base.css               # 全站基礎樣式
│   ├── login.css              # 登入頁樣式；index.html 在根目錄（網站入口），沒有自己的 pages/ 資料夾，所以放在共用的 styles/
│   └── layout.css             # 提單與追蹤頁共用的頂欄、導覽與帳號選單
├── src/
│   ├── config.js、pageUrls.js # 全站共用：API 基底網址、各頁網址
│   ├── pages/                 # 各頁組裝入口：login.js、propose.js、tickets.js、admin.js
│   ├── components/            # 畫面元件；account.js、dom.js 多頁共用，其餘依頁面分資料夾：
│   │   ├── propose/           #   提出需求單頁（「自動生成」視窗與其日期時間欄位、結果視窗與部門卡片）
│   │   ├── tickets/           #   狀態追蹤頁（追蹤清單、卡片、操作表單、已完成面板）
│   │   └── admin/             #   管理頁（監測、重置）
│   ├── services/              # API 服務
│   └── utils/                 # 純顯示工具
├── tests/
└── package.json
```

各頁網址（本機 `http://localhost:5173` 起算；Docker 與正式網站在 `/helpdesk/` 之下，例如 `/helpdesk/pages/propose/propose.html`；登入頁在正式網站為 `https://alex-lin-lab.com/helpdesk/`，Docker 本機為 `http://localhost:8080/helpdesk/`）：

| 頁面 | 路徑 |
| --- | --- |
| 登入 | `/`（`index.html`） |
| 提出需求單 | `/pages/propose/propose.html` |
| 狀態追蹤 | `/pages/tickets/tickets.html`（`#completed` 直接開啟「已完成」分頁） |
| 管理 | `/pages/admin/admin.html` |

頁面內的樣式、腳本與導覽連結都使用相對於各頁深度的路徑（例如 `../../styles/base.css`、`../tickets/tickets.html`）；程式導頁統一透過 `src/pageUrls.js` 由模組位置建立網址，不依目前頁面深度推測，也不硬編碼網站根路徑或 repo 名稱

## 頁面與檔案

下表只說明各檔案負責哪一塊；畫面行為、API 呼叫與錯誤提示的完整規則見 [API 介面規格書](../docs/企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md) 第 3.8 節（前端呈現摘要）、第 3.12 節（管理重置）、第 3.14 節（管理監測）與第 3.18 節（「自動生成」視窗）

| 路徑 | 說明 |
| --- | --- |
| `index.html`、`styles/login.css`、`src/pages/login.js` | 登入頁 |
| `pages/admin/admin.html`、`pages/admin/admin.css`、`src/pages/admin.js`、`src/services/adminService.js` | 管理頁與其獨立的 API 服務 |
| `pages/propose/propose.html`、`pages/propose/propose.css`、`src/pages/propose.js` | 提出需求單頁 |
| `src/components/propose/draftDialog.js` | 「自動生成」視窗 |
| `src/components/propose/dateTimeControl.js` | 「自動生成」視窗的日期時間欄位：原生日期輸入加 24 小時制時間輸入（可打字或從每 30 分鐘一筆的建議清單挑選） |
| `src/services/draftService.js` | 「自動生成」（`POST /api/tickets/draft`）與需求類型目錄（`GET /api/forms`）的存取 |
| `src/utils/formFormatters.js` | 需求類型表單欄位與計算結果的顯示格式 |
| `pages/tickets/tickets.html`、`pages/tickets/tickets.css`、`src/pages/tickets.js` | 狀態追蹤頁（「表單追蹤」與「已完成」分頁） |
| `styles/base.css`、`styles/layout.css` | 全站基礎樣式；提單與追蹤頁共用的頂欄、導覽、帳號選單與介紹文字 |
| `src/components/account.js` | 頂欄帳號選單與登入守門，一般頁與管理頁共用 |
| `src/pageUrls.js` | 由模組位置建立登入頁與 `pages/` 各頁網址，統一登入／登出／跨頁跳轉，支援 `/helpdesk/` 等專案子路徑 |
| `src/config.js` | 決定 API 基底網址：前端是原生 ES Modules，不會讀取任何 `.env`；在 `localhost:5173` 時使用 `http://localhost:3000`，其餘網站由模組位置推導，保留 `/helpdesk/` 等專案前綴，例如 `origin/helpdesk`（基底不含 `/api`，由各 service 呼叫時附加）；特殊的跨站部署才另行調整設定 |
| `src/services/authService.js` | 登入、登出與工作階段的存取 |
| `src/services/ticketService.js` | 部門與需求單（送單、查詢、簽核、轉單、取消）的存取，以及錯誤提示對應 |
| `src/components/admin/adminReset.js` | 管理重置表單 |
| `src/components/tickets/ticketTracking.js` | 待簽核／已退回追蹤清單 |
| `src/components/tickets/ticketCard.js` | 可展開的需求單卡片（展開後左欄申請內容、右欄處理資訊與歷程） |
| `src/components/tickets/ticketActions.js` | 簽核／退回／轉單／取消表單 |
| `src/components/tickets/ticketActionState.js` | 待簽核卡片的處理中動作、錯誤與倒數狀態保存 |
| `src/components/tickets/completedTickets.js` | 「已完成」面板 |
| `src/components/tickets/ticketText.js`、`src/utils/ticketFormatters.js` | 共用文案及純顯示函式 |
| `src/components/admin/adminMonitoring.js`、`src/components/admin/adminMetrics.js` | 管理監測的輪詢與畫面繪製 |
| `src/components/propose/dialogs.js` | 結果視窗與部門卡片的繪製 |
| `src/components/dom.js` | 以 `textContent` 建立元素，避免 HTML 注入 |
| `tests/` | 測試與測試替身（執行方式見下方「測試」） |

`src/pages/admin.js` 與 `src/pages/tickets.js` 是頁面組裝入口：驗證登入、提供 service 依賴、協調元件與資料更新；管理頁分成監測與重置兩個獨立元件，狀態追蹤頁分成追蹤清單、卡片、操作表單、卡片動作狀態與已完成篩選面板

元件透過明確的參數及回呼溝通；API 存取集中在 services，純顯示規則放在 utils；測試直接匯入對應元件或工具，頁面測試則驗證組裝後的完整流程

AI 金鑰（Claude 或 Gemini）只存在後端

## 流程

登入、提出需求單、「自動生成」視窗、送出與結果視窗、追蹤與簽核、卡片動作、重新提出的畫面規則與錯誤提示見 [API 介面規格書](../docs/企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md) 第 2.1 節、第 3.8 節與第 3.18 節；需求單的保存方式見第 3.4 節，這裡只留下操作時最先碰到的兩個入口

1. **登入**：輸入 16 組英文姓名的一般帳號之一（例如 `racky.huang`，完整名單與所屬部門見 API 介面規格書；輸入框提示為「員工英文姓名（例如 alex.huang）」）與授課者另行提供的密碼；後端另外接受獨立的 alex.admin 管理員
2. **自動生成**：在提出需求單頁按「自動生成」後開啟 `#draft-dialog`，焦點移到訊息輸入框，立即以 `{ subject }` 呼叫 `POST /api/tickets/draft`，第一則助理訊息是後端回的招呼語（內容由需求類型定義決定，例如請假時說明會由人資部處理，請提供日期、時間、假別與代理人），接著列出「還需要確認」的清單

## 測試

```bash
cd frontend
npm test
```

測試項數、涵蓋範圍、測試替身與「不呼叫付費 API」的說明見 [Docker 與 Lightsail 部署操作手冊](../docs/Docker與Lightsail部署操作手冊.md)

## 管理員與正式部署

管理員帳號 `alex.admin`、管理員登入後的導向與權限見 [API 介面規格書](../docs/企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md) 第 2.1 節，管理重置見第 3.12 節；正式部署的架構、`/helpdesk/` 前綴與完整操作見 [Docker 與 Lightsail 部署操作手冊](../docs/Docker與Lightsail部署操作手冊.md)，正式 `CORS_ORIGIN` 見[後端說明](../backend/README.md)的環境參數表，`src/config.js` 的 API 基底推導見上方「頁面與檔案」

## 管理監測更新方式

管理監測的更新方式、顯示內容（含需求單資料庫區塊與 `isValidMetrics` 的檢查）、錯誤處理與獨立限制見 [API 介面規格書](../docs/企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md) 第 3.14 節；部署回滾時後端與 web 映像要一起回滾的原因見[部署手冊](../docs/Docker與Lightsail部署操作手冊.md)
