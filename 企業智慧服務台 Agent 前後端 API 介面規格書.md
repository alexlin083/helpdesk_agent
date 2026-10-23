---
title: 企業智慧服務台 Agent 前後端 API 介面規格書
tags: [中原資管碩, 人工智慧與流程自動化實務研討]

---

# 企業智慧服務台 Agent 前後端 API 介面規格書

本規格書為成員 A（後端與架構主導）與成員 B（前端與 UI/UX 設計）之間的標準介面合約（API Contract），旨在規範 GitHub Pages 前端網頁與部署於 AWS Elastic Beanstalk 之 Node.js Express 後端 API 服務間的通訊協定、JSON 資料綱要、分流邏輯與錯誤處理機制。

---

## 文件適用範圍與實作狀態

依《開發規格書 v1.0.3》與後續需求，前端有登入頁、提出需求單頁與狀態追蹤頁（追蹤與簽核），後端提供登入、健康檢查、部門與處理人名單、需求單送出與 AI 判斷部門、需求單查詢與簽核。原本的對話 API（`POST /api/agent/chat`、`GET /api/agent/usage`）、知識庫向量檢索與來源卡片擴充契約已移除；相關檔案暫時保留為空檔以利合併時比對差異。

| 項目 | 狀態 |
| --- | --- |
| 登入、使用者代號（含所屬部門）、配額與錯誤格式 | 已實作 |
| 部門設定檔、帳號設定檔、`GET /api/departments`、`POST /api/tickets` | 已實作（第 3 節） |
| 需求單 JSON 儲存、`GET /api/tickets/mine`、`GET /api/tickets/department`、`POST /api/tickets/{id}/decision` | 已實作（第 3.4～3.7 節） |
| 轉單、取消、已完成查詢（`POST /api/tickets/{id}/transfer`、`POST /api/tickets/{id}/cancel`、`GET /api/tickets/completed`） | 已實作（第 3.9～3.11 節） |
| 「送達」實際通知處理人或部門、Email 或即時通知 | 未實作，不在本次範圍 |

## 1. 系統概觀與傳輸規範

前後端通訊採用標準 RESTful API 架構，正式部署的傳輸層使用 HTTPS（由負載平衡器或反向代理終止 TLS，後端程式本身不處理憑證）；本機開發可使用 HTTP。為配合前端託管於 GitHub Pages 且後端部署於 AWS Elastic Beanstalk 之跨網域環境，後端必須妥善設定跨來源資源共享（CORS）標頭。

* **基礎 API 網址**：正式 `https://<aws-beanstalk-domain>.elasticbeanstalk.com`；本機 `http://localhost:3000`；所有端點都在 `/api` 之下。
* **資料格式**：`application/json; charset=utf-8`。請求須帶 `Content-Type: application/json`；JSON 本文上限 16 KB，超過回 413；本文不是有效 JSON 回 400。
* **認證**：登入與健康檢查以外的端點都需 `Authorization: Bearer <token>`，缺少或格式不符回 401 `UNAUTHORIZED`。
* **CORS**：只允許 `CORS_ORIGIN` 設定的單一來源；方法 GET、POST、OPTIONS；允許標頭 Content-Type、Accept、Authorization；公開標頭 Retry-After、X-User-Remaining、X-Global-Remaining；預檢請求回 204。
* **環境變數管理**：`GEMINI_API_KEY` 嚴禁包含於前端代碼或程式庫中，統一交由 AWS Elastic Beanstalk 後端環境變數進行管理。

| 方法 | 路徑 | 認證 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/health` | 不需要 | 檢查後端是否運作，不呼叫 Gemini；回 `{ "success": true, "data": { "status": "ok" } }` |
| POST | `/api/auth/login` | 不需要 | 驗證十組課堂帳號，取得憑證 |
| GET | `/api/departments` | Bearer | 部門與處理人名單，取自部門設定檔，不呼叫 Gemini、不扣額度 |
| POST | `/api/tickets` | Bearer | 送出需求單；指定處理人直接送達，沒指定時呼叫 Gemini 判斷部門；兩者都保存為「待簽核」 |
| GET | `/api/tickets/mine` | Bearer | 我提出的需求單（最新在前） |
| GET | `/api/tickets/department` | Bearer | 送達我所屬部門的需求單（待簽核在前） |
| GET | `/api/tickets/completed` | Bearer | 我提出且已結案的需求單，加上我所屬部門已簽核、已退回、已取消的需求單，預設最新 100 筆，可篩選 |
| POST | `/api/tickets/{id}/decision` | Bearer | 簽核或退回一張送達我所屬部門、狀態為待簽核的需求單 |
| POST | `/api/tickets/{id}/transfer` | Bearer | 把一張送達我所屬部門、待簽核的需求單轉到其他部門（可指定處理人） |
| POST | `/api/tickets/{id}/cancel` | Bearer | 取消一張待簽核的需求單：提單人可取消自己的單，送達部門的成員替提單人取消時必須填原因 |

未知路由與方法不符（例如對 `/api/tickets` 發 GET、對 `/api/tickets/{id}/decision` 發 PUT）一律回 404 `NOT_FOUND`。

## 2. 登入、使用者代號與配額

### 2.1 課堂展示登入與 userID

前端首頁為登入頁 `index.html`，後端驗證成功後導向提出需求單頁 `propose.html`。帳號限定下表十組英文姓名帳號（全小寫、格式為「名.姓」、區分大小寫），每個帳號屬於一個部門；登入密碼由後端 `DEMO_PASSWORD` 提供，沒有內建預設值，並由授課者私下提供給使用者。其他帳號顯示「查無使用者」，已知帳號密碼不符顯示「密碼錯誤」。

| 帳號 | 固定 userID | 所屬部門 |
| --- | --- | --- |
| `racky.huang` | `user-racky.huang` | 資訊管理一部（dept-it-1） |
| `cindy.wang` | `user-cindy.wang` | 資訊管理二部（dept-it-2） |
| `emily.wu` | `user-emily.wu` | 人力資源部（dept-hr-1） |
| `frank.liu` | `user-frank.liu` | 人力資源部（dept-hr-1） |
| `grace.tsai` | `user-grace.tsai` | 總務與硬體組（dept-ga-1） |
| `henry.yang` | `user-henry.yang` | 總務與硬體組（dept-ga-1） |
| `amy.chen` | `user-amy.chen` | 財務部（dept-fin-1） |
| `brian.lin` | `user-brian.lin` | 採購部（dept-pur-1） |
| `david.lee` | `user-david.lee` | 法務部（dept-legal-1） |
| `ivy.chang` | `user-ivy.chang` | 資訊管理三部（dept-it-3） |

帳號與所屬部門定義在後端 `data/accounts.json`（見 3.6 節），前端不再保存帳號名單，只檢查 `user-<名.姓>` 的格式；修改後須重啟後端。這十組帳號同時就是「可指定的處理人」：指定處理人時選的是同事的帳號，處理人 id 即帳號名稱。

`POST /api/auth/login` 接收 `{ "username": "racky.huang", "password": "<PASSWORD>" }`（`username` 去除首尾空白後比對，長度不得超過 100；`password` 長度不得超過 200），成功回 HTTP 200（帶 `Cache-Control: no-store`）：

```json
{ "token": "<JWT>", "expiresAt": 1790000000000, "user": { "username": "racky.huang", "userID": "user-racky.huang", "department": { "id": "dept-it-1", "name": "資訊管理一部" } } }
```

`expiresAt` 是憑證到期的 epoch 毫秒，範例數值僅示意。JWT 以 HS256 簽署，含 username、sub（userID）、iat、exp（預設 7200 秒後）、iss（helpdesk）與 aud（helpdesk-chat）；部門不寫入憑證，每次驗證時依目前的帳號設定檔查詢。驗證時檢查演算法、簽章、期限、iss、aud、必要欄位與 username 對應 userID，憑證字串超過 2048 字元或帳號已從設定檔移除都視為無效。

登入失敗：

| HTTP | 錯誤代碼 | 觸發條件與訊息 |
| --- | --- | --- |
| 400 | `INVALID_PAYLOAD` | 帳號或密碼不是字串、超過長度上限或缺漏（「請提供有效帳號與密碼」） |
| 401 | `USER_NOT_FOUND` | 帳號不在十組名單內（「查無使用者」） |
| 401 | `INVALID_CREDENTIALS` | 帳號存在但密碼不符（「密碼錯誤」） |
| 429 | `LOGIN_RATE_LIMITED` | 來源或帳號＋來源的失敗次數已達上限（「登入失敗次數過多，請稍後再試」） |
| 503 | `SERVICE_BUSY` | 同時追蹤的登入狀態已達 512 筆（「登入服務忙碌，請稍後再試」） |
| 503 | `LIMIT_STORE_UNAVAILABLE` | 限制儲存無法使用 |

前端只在 sessionStorage 保存後端核發的憑證、期限及身分，不保存密碼、不在前端比對密碼。需求單本文不帶 `userID`，提單人由後端依憑證決定。前端登出清除本分頁憑證，不代表伺服器撤銷；舊憑證在期限內仍有效。變更簽章金鑰會使既有憑證失效。

### 2.2 限流與配額

| 項目 | 預設限制 | 環境參數 | 超過時的回應 |
| --- | --- | --- | --- |
| 帳號冷卻 | AI 判斷部門獲准後 10 秒 | `CHAT_COOLDOWN_SECONDS` | 429 `RATE_LIMIT_EXCEEDED`，retry_after 為剩餘秒數 |
| 帳號並行 | 同時 1 筆 | 固定 | 429 `REQUEST_IN_PROGRESS`，retry_after 2 秒 |
| 全站並行 | 同時 2 筆 | `GLOBAL_CONCURRENCY` | 503 `SERVICE_BUSY`，retry_after 2 秒 |
| 帳號每日 | 30 次 | `USER_DAILY_LIMIT` | 429 `DAILY_QUOTA_EXCEEDED`，retry_after 為距台北午夜的秒數 |
| 全站每日 | 100 次，十組帳號共用 | `GLOBAL_DAILY_LIMIT` | 429 `GLOBAL_QUOTA_EXCEEDED`，retry_after 同上 |
| 登入失敗（來源整體） | 每 IP／IPv6 /64 每 15 分鐘 100 次 | `LOGIN_FAILURE_LIMIT`、`LOGIN_WINDOW_SECONDS` | 429 `LOGIN_RATE_LIMITED` |
| 登入失敗（已知帳號＋來源） | 每組合每 5 分鐘 5 次 | `LOGIN_ACCOUNT_FAILURE_LIMIT`、`LOGIN_ACCOUNT_WINDOW_SECONDS` | 429 `LOGIN_RATE_LIMITED` |
| HTTP API 入口 | 每 IP／IPv6 /64 每 60 秒 300 次；不含健康檢查及 OPTIONS | `HTTP_API_LIMIT`、`HTTP_RATE_WINDOW_SECONDS` | 429 `RATE_LIMIT_EXCEEDED` |
| HTTP 登入總請求 | 每 IP／IPv6 /64 每 60 秒 120 次 | `HTTP_LOGIN_LIMIT` | 429 `RATE_LIMIT_EXCEEDED` |
| HTTP 需求單送出與簽核 | 每個驗證後 userID 每 60 秒 12 次 | `HTTP_TICKET_LIMIT` | 429 `RATE_LIMIT_EXCEEDED` |
| HTTP 部門名單 | 每個驗證後 userID 每 60 秒 30 次 | `HTTP_DEPARTMENTS_LIMIT` | 429 `RATE_LIMIT_EXCEEDED` |
| HTTP 需求單查詢 | 每個驗證後 userID 每 60 秒 60 次 | `HTTP_QUERY_LIMIT` | 429 `RATE_LIMIT_EXCEEDED` |

- 只有沒指定處理人、需要呼叫 Gemini 的需求單才檢查並預扣冷卻、並行與每日配額；檢查順序為處理中租約 → 冷卻 → 帳號每日 → 全站每日 → 全站並行，在同一次原子操作內完成，通過才扣帳號與全站各一次並取得 180 秒租約。
- 被拒絕的請求（含輸入、身分驗證失敗）不扣額；獲准後的任何失敗（Gemini 上游錯誤、未設金鑰、輸出格式異常、需求單保存失敗）仍計入用量且不退還；後端不自動重送。
- 每日計數以台北時間（UTC+8）00:00 重置；跨午夜仍保留冷卻與執行中的租約。
- 記憶體模式只適用本機單一程序，重啟後歸零；production 強制使用 DynamoDB（`LIMIT_STORE=dynamodb`），儲存故障時回 503 `LIMIT_STORE_UNAVAILABLE`，不退回記憶體、不放行 Gemini。
- HTTP 層限制各自使用有界單程序記憶體（`HTTP_RATE_MAX_KEYS`，預設 2048），滿載回 503 `SERVICE_BUSY`；被 HTTP 限流拒絕不扣額度。
- 獲准後的成功回應帶 `X-User-Remaining` 與 `X-Global-Remaining` 標頭；任何帶等待時間的拒絕帶 `Retry-After` 標頭，與 `error.retry_after` 一致。

## 3. 需求單 API（已實作）

本節依《開發規格書 v1.0.3》的「部門設定檔」與「需求單 API」實作，並依後續需求加入帳號設定檔、需求單 JSON 儲存、查詢與簽核端點。所有端點都需要 `Authorization: Bearer <token>`，錯誤格式見第 4 節。「送達」不會實際通知任何人；送達部門的成員可在狀態追蹤頁看到待簽核的需求單並簽核或退回，提單人可追蹤狀態。

### 3.1 部門設定檔 `backend/data/departments.json`

部門陣列，每個部門一筆，欄位一律用英文；後端啟動時一次讀入並驗證，修改後須重啟。目前定義八個部門：資訊管理一部（預設部門）、資訊管理二部、人力資源部、總務與硬體組、財務部、採購部、法務部、資訊管理三部（AI 宣導、部署、教育訓練與發展），每個部門至少有一個登入帳號，AI 判斷送達的需求單才有人能簽核：

| 欄位 | 型別 | 必填 | 規則 |
| --- | --- | --- | --- |
| `id` | string | 是 | 部門的穩定識別碼，全檔唯一；Gemini 回覆時也用它指定部門 |
| `name` | string | 是 | 部門名稱，是需求單最後要送到的業務單位 |
| `type` | string | 否 | 部門屬性標籤；缺漏時視為空字串，前端不顯示標籤 |
| `duty` | string | 是 | 一段話說明部門處理哪些事；交給 Gemini，也顯示在「各部門業務範圍」視窗 |
| `business` | string[] | 是 | 代表部門業務的關鍵字詞；Gemini 用來比對主題與內容 |

處理人不寫在部門設定檔：每個部門可被指定的處理人就是該部門的登入帳號（見 3.6 節），`GET /api/departments` 會自動合併。設定檔若仍含 `handlers` 欄位會啟動失敗，提示改用帳號設定檔。預設部門：`business` 含「IT資訊服務台」的部門，接收對不到部門的需求單；設定檔必須恰有一個，否則啟動失敗。JSON 語法錯誤、必填欄位缺漏或型別不符、id 重複時啟動失敗，錯誤訊息只列出位置與原因。

### 3.2 `GET /api/departments`

取得部門與處理人名單，不呼叫 Gemini、不扣額度、不計入冷卻。成功回 HTTP 200（帶 `Cache-Control: no-store`），內容直接取自部門設定檔：

```json
{
  "departments": [
    {
      "id": "dept-it-1",
      "name": "資訊管理一部",
      "type": "資訊",
      "duty": "處理各部門有關網路連線相關、VPN 連線申請等，並擔任 IT資訊服務台",
      "business": ["VPN", "防火牆", "IT資訊服務台"],
      "handlers": [
        { "id": "racky.huang", "name": "racky.huang" },
        { "id": "amy.chen", "name": "amy.chen" }
      ]
    }
  ]
}
```

`handlers` 是該部門的登入帳號（`id` 與 `name` 都是帳號名稱，沒有職稱欄位），沒有帳號的部門回空陣列；`type` 缺漏時回空字串。前端：部門或處理人缺少 `id` 或 `name` 時整份名單視為格式不正確；`business` 中不是文字的項目略過；沒有處理人的部門不出現在指定處理人的選單，但仍列在「各部門業務範圍」視窗。指定處理人為可搜尋選單：輸入帳號或部門名稱即時過濾（不分大小寫），依部門分組顯示，選定後把處理人 id 放入 `handler_id` 送出。

### 3.3 `POST /api/tickets`

請求欄位：

| 欄位 | 型別 | 必填 | 規則 |
| --- | --- | --- | --- |
| `subject` | string | 是 | 去除首尾空白後 1～100 個 Unicode code points；不合規定回 400 `INVALID_PAYLOAD`（「subject 必須是 1 到 100 字元的非空白字串」） |
| `content` | string | 是 | 去除首尾空白後 1～2000 個 Unicode code points（「content 必須是 1 到 2000 字元的非空白字串」） |
| `handler_id` | string 或 null | 否 | 指定處理人的 id，即同事的帳號名稱（取自 GET /api/departments 的 handlers[].id）；null、省略或空字串代表不指定；有值但不是任何帳號回 400（「指定的處理人不存在」）；不是字串或 null 回 400（「handler_id 必須是字串或 null」） |

提單人由後端依憑證決定，本文不帶 `userID`；多餘欄位忽略；本文上限 16 KB。

成功一律回 HTTP 200：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `ticket_id` | string | `TK-` 加 UUID，由後端每次產生 |
| `route` | string | `HANDLER`（有指定處理人）、`DEPARTMENT`（Gemini 判斷出部門且信心分數達 75）、`FALLBACK`（對不到部門，送預設部門） |
| `department` | string | 送達的部門名稱；`HANDLER` 為處理人所屬部門，`FALLBACK` 為預設部門 |
| `handler` | object | 只有 `HANDLER` 出現：`{ name }`，name 為處理人的帳號名稱 |
| `basis` | string | 判斷依據，只有 `DEPARTMENT` 與 `FALLBACK` 出現；去空白後最多 200 字，空字串時省略 |
| `status` | string | 新單一律為 `PENDING`（待簽核） |

範例一（指定處理人）：

```json
// 請求
{ "subject": "VPN 帳號申請", "content": "新進同仁需要 VPN 連線權限", "handler_id": "racky.huang" }
// 回應
{ "ticket_id": "TK-123e4567-e89b-42d3-a456-426614174000", "route": "HANDLER", "department": "資訊管理一部", "handler": { "name": "racky.huang" }, "status": "PENDING" }
```

範例二（由 Gemini 判斷）：

```json
// 請求
{ "subject": "ERP 報表權限", "content": "財務部需要新增 ERP 報表的檢視權限", "handler_id": null }
// 回應
{ "ticket_id": "TK-9b2f6c1e-5d3a-4e8b-8f21-0a7c4d9e1b35", "route": "DEPARTMENT", "department": "資訊管理二部", "basis": "需求提到 ERP 報表權限，屬於資訊管理二部的 ERP 業務", "status": "PENDING" }
```

處理順序：解析 JSON → ① 驗證憑證 → ② 檢查欄位 → ③ 查指定處理人（找到即保存為待簽核並回傳 `HANDLER`，不扣額度、不呼叫 Gemini）；沒有指定處理人時 → ④ 預扣用量與租約（見 2.2，成功時回應帶 `X-User-Remaining`、`X-Global-Remaining`）→ ⑤ 呼叫 Gemini 一次（逾時 15 秒、temperature 0.2、maxOutputTokens 1024；輸入為 `{ ticket: { subject, content }, departments: [{ id, name, duty, business }] }`，不送處理人；結構化輸出 `department_id`（字串或 null）、`confidence_score`（0～100 整數）、`basis`（字串））→ ⑥ 驗證與分流（`department_id` 在設定檔內且分數 >= 75 為 `DEPARTMENT`，否則 `FALLBACK`；格式異常回 500「AI 回應格式異常，請稍後再試」）→ ⑦ 保存需求單（失敗回 503 `TICKET_STORE_UNAVAILABLE`）→ ⑧ 回應並釋放租約。上游 429 轉成 429 `RATE_LIMIT_EXCEEDED`，其他上游錯誤與逾時轉成 500 `SERVER_ERROR`；已扣的額度不退還。這條流程不使用向量檢索。

### 3.4 需求單儲存 `backend/data/tickets.json`

所有需求單（指定處理人與 AI 判斷都包含）保存在單一 JSON 檔（可用 `TICKETS_FILE` 指定其他絕對路徑），每張需求單一筆，含狀態與簽核紀錄；檔案含需求單原文，不得提交 Git，也列入 `.ebignore`。寫入先寫暫存檔再改名，並在程序內排隊；只適用單一程序，多個 instance 不會共用。

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `ticket_id` | string | 單號，`TK-` 加 UUID |
| `created_at`、`updated_at` | string | UTC ISO 8601；簽核或退回時更新 `updated_at` |
| `requester` | object | 提單人 `{ user_id, username, department_id, department_name }`，取自憑證 |
| `subject`、`content` | string | 去除首尾空白後的原文 |
| `route` | string | `HANDLER`、`DEPARTMENT`、`FALLBACK` |
| `department_id`、`department_name` | string | 送達部門；簽核權限以 `department_id` 判定 |
| `handler` | object 或 null | 指定處理人 `{ id, name }`（都是帳號名稱）；AI 判斷的單為 null |
| `judgement` | object 或 null | AI 判斷 `{ ai_department_id, confidence_score, basis, model }`；指定處理人的單為 null |
| `status` | string | `PENDING`（待簽核）、`APPROVED`（已簽核）、`REJECTED`（已退回）、`CANCELLED`（已取消） |
| `decision` | object 或 null | 簽核或取消結果 `{ by_user_id, by_username, at, comment }`，取消時另含 `cancelled_by`（`REQUESTER` 或 `DEPARTMENT`）；待簽核時 null |
| `history` | object[] | 歷程，每筆 `{ at, event, by_user_id, by_username, comment? }`，event 為 `SUBMITTED`、`APPROVED`、`REJECTED`、`TRANSFERRED`、`CANCELLED`；轉單另含 `from_department_id`、`from_department_name`、`to_department_id`、`to_department_name`、`to_handler_name?`；取消另含 `cancelled_by` |

轉單只改變 `department_id`、`department_name` 與 `handler`，`route` 與 `judgement` 保留原始判斷；簽核權限以目前的 `department_id` 判定。

### 3.5 `GET /api/tickets/mine` 與 `GET /api/tickets/department`

- `GET /api/tickets/mine`：回 `{ "tickets": [ ...需求單 ] }`，只含提單人為憑證身分的需求單，依 `created_at` 由新到舊；帶 `Cache-Control: no-store`。
- `GET /api/tickets/department`：回 `{ "department": { "id", "name" }, "tickets": [ ...需求單 ] }`，只含 `department_id` 等於憑證身分所屬部門的需求單；待簽核的在前（最早的優先），其餘依 `updated_at` 由新到舊。
- 兩者都不呼叫 Gemini、不扣額度；需求單的欄位見 3.4 節。前端整理時缺少 `ticket_id`、`subject`、`status`、`department_name` 或 `created_at` 視為格式不正確。

### 3.6 帳號設定檔 `backend/data/accounts.json`

帳號陣列，每筆 `{ "username", "department_id" }`；`username` 全小寫、格式為「名.姓」、全檔唯一；`department_id` 必須存在於部門設定檔。後端啟動時讀入並驗證，錯誤時啟動失敗並只列出位置與原因。十組帳號的對應見 2.1 節。帳號同時是可指定的處理人（下拉選單依部門分組顯示帳號），同部門的所有帳號都可以看到並簽核送達該部門的需求單。

### 3.7 `POST /api/tickets/{id}/decision`

簽核或退回一張需求單；只有送達部門的成員可以操作，且需求單狀態必須是待簽核。

| 欄位 | 型別 | 必填 | 規則 |
| --- | --- | --- | --- |
| `action` | string | 是 | `APPROVE`（簽核）或 `REJECT`（退回）；其他值回 400「action 必須是 APPROVE 或 REJECT」 |
| `comment` | string | 否 | 備註，去除首尾空白後最多 200 個 Unicode code points；不是字串回 400「comment 必須是字串」，超過回 400「comment 最多 200 字元」 |

成功回 HTTP 200 `{ "ticket": { ...更新後的需求單 } }`：`status` 變為 `APPROVED` 或 `REJECTED`，`decision` 填入簽核人與備註，`history` 追加一筆。失敗：404 `TICKET_NOT_FOUND`（「找不到這張需求單」）、403 `FORBIDDEN`（「只有送達部門的成員可以簽核這張需求單」）、409 `TICKET_ALREADY_DECIDED`（「這張需求單已經簽核過」或「這張需求單已經取消」）、503 `TICKET_STORE_UNAVAILABLE`。

### 3.9 `POST /api/tickets/{id}/transfer`

AI 判斷錯誤或指定錯處理人時，送達部門的成員可把「待簽核」的需求單轉到其他部門；狀態維持待簽核，轉單後只有新部門的成員可以簽核、退回、轉單或替提單人取消。

| 欄位 | 型別 | 必填 | 規則 |
| --- | --- | --- | --- |
| `department_id` | string | 是 | 目標部門 id，必須存在且不同於目前送達部門（「轉單的目標部門不存在」「轉單的目標部門必須不同於目前部門」） |
| `handler_id` | string 或 null | 否 | 目標部門的處理人 id（帳號名稱）；不存在回「指定的處理人不存在」，不屬於目標部門回「指定的處理人不屬於目標部門」；省略或 null 代表不指定（轉單後 `handler` 為 null） |
| `comment` | string | 否 | 備註，最多 200 字 |

成功回 HTTP 200 `{ "ticket": { ...更新後的需求單 } }`，`history` 追加 `TRANSFERRED`。失敗：400、403 `FORBIDDEN`（「只有送達部門的成員可以轉這張需求單」）、404、409（已簽核或已取消）、503。

### 3.10 `POST /api/tickets/{id}/cancel`

取消一張「待簽核」的需求單，資料保留、狀態改為 `CANCELLED`，不提供刪除。

| 身分 | 條件 |
| --- | --- |
| 提單人（`requester.user_id` 等於憑證身分） | 可取消自己的單，`comment` 選填 |
| 送達部門的成員 | 可替提單人取消，`comment` 必填（「替提單人取消時必須填寫原因」） |
| 其他人 | 403 `FORBIDDEN`（「只有提單人或送達部門的成員可以取消這張需求單」） |

成功回 HTTP 200 `{ "ticket": { ...更新後的需求單 } }`，`decision.cancelled_by` 為 `REQUESTER` 或 `DEPARTMENT`，`history` 追加 `CANCELLED`。已簽核、已退回或已取消的單回 409 `TICKET_ALREADY_DECIDED`（「這張需求單已經簽核或取消，不能再取消」）。

### 3.11 `GET /api/tickets/completed`

回傳與憑證身分有關且已結案的需求單：提單人是本人的，加上送達部門是本人所屬部門的，狀態為已簽核、已退回或已取消，依簽核（或取消）時間由新到舊，預設最新 100 筆。查詢參數：

| 參數 | 規則 |
| --- | --- |
| `status` | `APPROVED`、`REJECTED` 或 `CANCELLED`；省略為全部 |
| `q` | 關鍵字，去空白後最多 100 字，不分大小寫，比對單號、主題、內容、提單人帳號、簽核人帳號、簽核備註與處理人姓名 |
| `from`、`to` | 簽核日期的台北日期（`YYYY-MM-DD`），`from` 不可晚於 `to` |
| `limit` | 1～500 的整數，預設 100 |

成功回 `{ "department": { "id", "name" }, "total": 符合條件的總筆數, "limit": 本次上限, "tickets": [ ...最多 limit 筆 ] }`；條件無效回 400 `INVALID_PAYLOAD`。轉到其他部門後才被簽核的單屬於簽核部門的紀錄，但提單人仍看得到。

### 3.8 前端呈現摘要

提出需求單頁的結果視窗：`HANDLER` 送達「姓名（部門）」、方式「已指定處理人，直接送達」；`DEPARTMENT` 送達部門名稱、方式「AI 依主題與內容判斷部門」，有 `basis` 時多一列「判斷依據」；`FALLBACK` 方式「內容未對應到明確部門」，說明「先送「{部門}」，由人工分派部門」；視窗另有前往狀態追蹤頁的連結。429 非額度錯誤依 `retry_after` 倒數（超過 300 秒或沒有秒數時只顯示提示）；額度用盡、503 不倒數；401 清除本分頁登入狀態並回登入頁。完整的狀態對應見開發規格書「送出結果與錯誤處理」。

狀態追蹤頁 `tickets.html` 有兩個分頁，依需求單「進行中／已結案」切分而不是依身分：

- 「表單追蹤」分兩區。「待簽核」先列送達本部門、等我簽核的需求單（標籤「待本部門簽核」，顯示提單人，卡片內有備註欄、「轉單到其他部門」、「替提單人取消」（原因必填）與「退回」「簽核」按鈕），再列我送出且仍在等待的需求單（標籤「我提出的」，可取消，原因選填）；同一張單同時符合兩者時只列一次並保留簽核操作。「已退回」列我提出但被退回的需求單，附退回人與原因，可按「重新提出」把主題與內容帶到提出需求單頁（透過本分頁的 sessionStorage 草稿，帶入後即清除）。分頁計數為兩區的總筆數。
- 「已完成」以 `GET /api/tickets/completed` 列出我提出且已結案的需求單與本部門的簽核紀錄（我提出的加上「我提出的」標籤），預設最新 100 筆，可用關鍵字、結果（全部／已簽核／已退回／已取消）、簽核日期區間與「今天」「近 7 天」「近 30 天」「不限日期」常用條件查詢。

每張卡片都顯示狀態、送達對象、判斷依據、簽核人與備註、轉單紀錄與歷程。403、404、409 的提示顯示在卡片內，401 回登入頁。頂欄的帳號選單顯示所屬部門。`#completed` 直接開啟已完成分頁。

---

## 4. 錯誤處理與 HTTP 狀態碼規範

為確保前端 GitHub Pages 在面對網路異常或後端故障時能維持良好之 UI/UX 狀態（如解除按鈕鎖定、顯示友善錯誤提示），後端必須遵守以下標準 HTTP 狀態碼回應原則。

### 錯誤回應 JSON 格式

所有非 2xx 狀態碼之錯誤回應，統一採用包含 `error` 物件之 JSON 格式；有等待時間時另有 `error.retry_after`（整數秒）並回相同的 `Retry-After` 標頭：

```json
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "message": "subject 必須是 1 到 100 字元的非空白字串"
  }
}
```

訊息是繁體中文；後端不輸出供應商（Gemini）的原始錯誤、金鑰或需求單內容。

### HTTP 狀態碼對照表

| HTTP 狀態碼 | 錯誤代碼 | 觸發時機 | 前端處置 |
| --- | --- | --- | --- |
| `200 OK` | N/A | 請求處理成功 | 依 `route` 顯示結果視窗 |
| `400 Bad Request` | `INVALID_PAYLOAD` | JSON 無法解析、登入欄位不合規定、需求單欄位不合規定或指定的處理人不存在 | 「送出的內容不符合規定，請檢查後再試」加後端訊息 |
| `401 Unauthorized` | `UNAUTHORIZED`、`USER_NOT_FOUND`、`INVALID_CREDENTIALS` | 憑證缺少、無效或過期；登入失敗 | 登入頁顯示訊息；其他頁清除登入狀態並回登入頁 |
| `403 Forbidden` | `FORBIDDEN` | 不是送達部門的成員卻嘗試簽核或轉單；既不是提單人也不是送達部門成員卻嘗試取消 | 顯示後端訊息 |
| `404 Not Found` | `NOT_FOUND`、`TICKET_NOT_FOUND` | 未知路由或方法不符；簽核、轉單或取消時查無需求單 | 提示後端版本與網址；查無需求單時顯示後端訊息 |
| `409 Conflict` | `TICKET_ALREADY_DECIDED` | 需求單已簽核、退回或取消 | 顯示提示並重新整理清單 |
| `413 Payload Too Large` | `PAYLOAD_TOO_LARGE` | JSON 本文超過 16 KB | 提示縮短內容 |
| `429 Too Many Requests` | `RATE_LIMIT_EXCEEDED`、`REQUEST_IN_PROGRESS`、`LOGIN_RATE_LIMITED` | HTTP 請求頻率、冷卻、處理中、登入失敗過多或 Gemini 上游限流 | 依 `retry_after` 倒數（最多 300 秒） |
| `429 Too Many Requests` | `DAILY_QUOTA_EXCEEDED`、`GLOBAL_QUOTA_EXCEEDED` | 帳號或全站今日額度耗盡 | 顯示台北午夜重置提示，不倒數 |
| `500 Internal Error` | `SERVER_ERROR` | 未設定 Gemini 金鑰、模型輸出未通過驗證、上游失敗或逾時、其他未預期錯誤 | 顯示系統暫時無法使用提示，解除送出鎖定 |
| `503 Service Unavailable` | `SERVICE_BUSY`、`LIMIT_STORE_UNAVAILABLE`、`TICKET_STORE_UNAVAILABLE` | 全站並行滿載、保護計數容量不足、限制儲存無法使用或需求單檔案無法讀寫 | 稍後重試，不自動重送、不倒數 |

Gemini 上游 429 未提供本地等待值時 `retry_after` 使用十秒；每日額度用盡時的 `retry_after` 是到台北午夜的秒數，前端不應拿它做倒數。
