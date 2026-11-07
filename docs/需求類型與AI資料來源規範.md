# 需求類型與 AI 資料來源規範

需求類型的撰寫格式、每個鍵的意義、目前七種類型的內容、新增類型的步驟與完整範例，以及分類評測，都以這份文件為準；自動生成、送單與簽核的 API 合約見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.15、3.16 節，部署操作見 [Docker 與 Lightsail 部署操作手冊](Docker與Lightsail部署操作手冊.md)第 5.9 節

本文內容對應目前的程式（`backend/src/services/requestTypes/`）與設定（`backend/data/requestTypes/`）。範例中的帳號、部門、品項與數字都是假資料。

## 1. 基本觀念

- **程式不寫死任何需求類型**：後端與前端都沒有「請假」「設備」這類專屬程式；需求類型的一切（給 AI 的說明與範例、欄位、計算、額度帳與檢查、需求內容的固定文字、簽核與轉單規則）都寫在設定檔裡；請假申請、打卡補登、VPN 申請、報修、設備申請、採購申請與一般需求都是這樣定義的，新增類型只要加 JSON 檔與目錄項目
- **一種需求類型 = 一個 JSON 檔。** 例如 `leave.json` 是請假申請、`equipment.json` 是設備申請、`general.json` 是一般需求。同一種需求的所有規則只在這一個檔案，AI 不會被其他類型的內容混淆，人也容易找到要改的地方。
- **目錄 `_catalog.json` 把它們串起來。** 目錄列出所有類型與它們的摘要、AI 的共通指示，以及 AI 可以呼叫的「工具」（資料來源）。
- **AI 決定要看哪份定義、查哪些資料**：一次對話怎麼使用這些設定見第 3 節，AI 每回合讀取的內容見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.16 節
- **AI 只提供建議，伺服器做最後決定**：不論 AI 填了什麼，伺服器都會依定義重新驗證欄位、計算數字、檢查額度，再依定義產生需求內容

## 2. 檔案位置、載入與錯誤

```text
backend/data/requestTypes/
├── _catalog.json      目錄：AI 共通指示、類型清單、預設類型、AI 工具
├── leave.json         請假申請（版本 2）
├── attendance.json    打卡補登（版本 1）
├── vpn.json           VPN 申請（版本 1）
├── repair.json        報修（版本 1）
├── equipment.json     設備申請（版本 1）
├── purchase.json      採購申請（版本 1）
└── general.json       一般需求（版本 1，預設類型）
```

- 這些檔案屬於規則設定，跟程式一起提交 Git、一起建置：`backend/Dockerfile` 把整個 `data/requestTypes/` 資料夾複製進 backend image；這個資料夾不在 volume 裡，不要在執行中的容器內修改（容器重建後就會遺失）；人員資料不在 image 內，只存在 volume 的資料庫
- 載入與驗證：`src/index.js` 在開啟資料庫與監聽之前，由 `src/services/requestTypes/registry.js` 讀取並驗證目錄與目錄列出的每個定義檔；部門設定檔 `data/departments.json` 也在啟動時驗證；缺檔或內容不符都會在監聽前啟動失敗，需求類型的錯誤記錄 `request_types.failed`，`detail` 指出檔名與鍵路徑（例如 `equipment.json fields[2].type 未知的欄位型別「slider」…`）；日誌的完整欄位見 [backend/README.md](../backend/README.md)「日誌與排查」
- 驗證項目包括：JSON 語法、只允許已知的頂層鍵、欄位型別與規則、能力名稱、渲染佔位文字只能參照存在的欄位或計算結果、參照的工具存在且能提供該欄位型別的選項、部門 id 存在於部門設定檔、額度表在允許清單內、目錄工具的 `access` 與 `params` 符合能力的合約；哪些拼錯的鍵會報錯、哪些會被默默忽略，見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.15 節
- 通用引擎 `src/services/requestTypes/`（`registry`、`fieldTypes`、`capabilities`、`renderer`、`evaluator`、`draftEngine`、`aiAssistant`、`claudeAssistant`、`workflow`）不含任何類型專屬的程式
- 修改後要重新啟動後端；Docker 部署要重新建置並更新 backend image（步驟見部署手冊第 5.9 節）；前端依定義自動產生畫面，因此只新增或修改需求類型時 web image 不必更新
- 修改後請對照本文件逐一核對鍵名，並實際操作一次（第 13 節步驟 9）

### 2.1 目前的需求類型

順序與 `_catalog.json` 的 `types` 相同，`default_type` 為 `general`：

| id | 版本 | 名稱 | 送達部門 | 流程（`workflow.route`） | 可轉單 | 本人可簽核 | AI 可用工具 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `leave` | 2 | 請假申請 | 人力資源部（`dept-hr-1`，固定） | `FORM` | 否（`FORM_TICKET_LOCKED`「請假單不能轉出人資部」） | 否（「不能簽核自己提出的請假單」） | `colleagues`、`my_leave_balance`、`department_directory` |
| `attendance` | 1 | 打卡補登 | 人力資源部（`dept-hr-1`，固定） | `FORM` | 否（`FORM_TICKET_LOCKED`「打卡補登由人力資源部處理，不能轉單」） | 否 | `department_directory` |
| `vpn` | 1 | VPN 申請 | 資訊管理一部（`dept-it-1`，固定） | `FORM` | 否（`FORM_TICKET_LOCKED`「VPN 申請由資訊管理一部處理，不能轉單」） | 否 | `department_directory` |
| `repair` | 1 | 報修 | 總務與硬體組（`dept-ga-1`，固定） | `FORM` | 是 | 否 | `department_directory` |
| `equipment` | 1 | 設備申請 | 總務與硬體組（`dept-ga-1`，固定） | `FORM` | 是 | 否 | `department_directory` |
| `purchase` | 1 | 採購申請 | 採購部（`dept-pur-1`，固定） | `FORM` | 否（`FORM_TICKET_LOCKED`「採購申請由採購部處理，不能轉單」） | 否 | `department_directory` |
| `general` | 1 | 一般需求（`default_type`） | 由對話決定：AI 信心分數 ≥ 75 時採用，否則由使用者選擇 | `DEPARTMENT`（`judgement.source: 'draft'`，保存 `request_type`） | 是 | 否（「不能簽核自己提出的需求單」） | `department_directory` |

目前所有類型都沒有設定 `handler`，不提供指定處理人；請假以外的類型都沒有計算、額度帳與檢查；設備申請、打卡補登、VPN 申請、報修與採購申請的內容是示範用的預設值，可依實際需求修改；打卡補登、VPN 申請、報修、採購申請與一般需求的欄位見本節下方

**請假 `leave.json`（版本 2）**：

| key | label | 型別與規則 |
| --- | --- | --- |
| `applicant` | 請假人 | self |
| `leave_type` | 假別 | enum：事假、病假、特休；必填；也是額度帳的類別 |
| `start_at` | 請假起始時間 | datetime（`YYYY-MM-DDTHH:mm`，台北時間）；必填 |
| `end_at` | 請假截止時間 | datetime（`YYYY-MM-DDTHH:mm`，台北時間）；必填；必須晚於 `start_at`（「請假截止時間必須晚於請假起始時間」） |
| `agent` | 代理人 | account；必填；候選來自 `colleagues`；同部門、不可為本人、啟用中、`start_at`～`end_at` 期間內不可也有待簽核或已核准的請假（不可選者 `reason`「此期間已有請假」，選了則為「這位同事在此期間也有請假，不能擔任代理人」） |
| `note` | 備註 | text，最多 200 字；選填 |

- 工作日曆 `calendar`：`timezone_offset` 為 `+08:00`、上班時段 09:00～12:00 與 13:00～18:00、週一到週五、`holidays` 只開放 2026 與 2027 年度（目前為空陣列，其他年度「{year} 年度尚未開放請假」）、單位 1 分鐘、最少 1 分鐘、最多 14 天（「請假期間最多 14 天」）、不可跨年度（「請假期間不可跨年度，請分開申請」）
- 計算 `minutes`（請假時數，`work_minutes`，顯示為 `hours_minutes`）：期間與工作日（扣除 `holidays`）上班時段的重疊，依單位向上取整；為 0 時「請假期間沒有落在上班時段」；例：2026-12-01（週二）09:30～17:30 為 150 + 270 = 420 分鐘（7 小時 0 分鐘）
- 額度帳：類別 `leave_type`、數量 `minutes`、期間為 `start_at` 的年度、額度表 `leave_entitlements`
- 檢查：`ledger_balance`（draft、submit、approve；409 `LEAVE_BALANCE_INSUFFICIENT`「假別剩餘時數不足」；摘要「{leave_type}剩餘時數」）、`ledger_overlap`（draft、submit；409 `LEAVE_OVERLAP`「這段時間已有請假單」）
- 版本相容：請假定義由版本 1 升為 2（欄位不變，規則併入同一檔）；已保存的單保留自己的 `form.version`，因此版本 1 的請假單仍可顯示、計入剩餘時數、阻擋期間重疊、讓同事在 `colleagues` 中顯示為不可擔任代理人，也可以簽核；以 `version: 1` 送出新單回 409 `FORM_VERSION_CHANGED`

**設備申請 `equipment.json`（版本 1）**：內容就是第 13 節的範例；欄位為申請人（self，自動填入、一律非必填）、設備品項（text，最多 50 字）、數量（number，整數 1～50）、用途說明（text，最多 200 字）、需要日期（date，不可早於台北今天）、送交地點（text，最多 50 字），申請人以外全部必填

**打卡補登、VPN 申請、報修、採購申請（各為版本 1）**：只用既有的欄位型別與工具（`department_directory`）；`self` 欄位（申請人或報修人）由後端填入目前帳號

| 類型 | key | label | 型別與規則 |
| --- | --- | --- | --- |
| `attendance` | `punch_kind` | 補登類別 | enum：上班、下班；必填 |
| `attendance` | `punch_at` | 實際打卡時間 | datetime；必填（目前的欄位規則沒有「不可晚於現在」，未來時間不會被擋） |
| `attendance` | `reason` | 補登原因 | enum：忘記打卡、打卡機故障、因公外出、其他；必填 |
| `attendance` | `note` | 說明 | text，最多 200 字；選填（渲染時空白為「無」） |
| `vpn` | `start_date` | 使用起始日期 | date；必填；不可早於今天（台北） |
| `vpn` | `end_date` | 使用截止日期 | date；必填；必須晚於 `start_date`（同一天也不行） |
| `vpn` | `target` | 連線對象 | text，最多 100 字；必填 |
| `vpn` | `purpose` | 用途 | text，最多 200 字；必填 |
| `vpn` | `device` | 使用電腦 | enum：公司配發電腦、個人電腦；必填 |
| `repair` | `asset` | 故障設備 | text，最多 50 字；必填 |
| `repair` | `location` | 所在位置 | text，最多 50 字；必填 |
| `repair` | `symptom` | 故障狀況 | text，最多 300 字、保留換行；必填 |
| `repair` | `urgency` | 緊急程度 | enum：一般、急件；必填 |
| `purchase` | `item` | 採購品項 | text，最多 50 字；必填 |
| `purchase` | `quantity` | 數量 | number，整數 1～999；必填 |
| `purchase` | `budget` | 預估總金額 | number，整數 1～10,000,000（新台幣）；必填；需求內容顯示為「新台幣 N 元」 |
| `purchase` | `purpose` | 採購用途 | text，最多 200 字；必填 |
| `purchase` | `needed_by` | 需要日期 | date；必填；不可早於今天（台北） |
| `purchase` | `supplier` | 建議供應商 | text，最多 50 字；選填（渲染時空白為「未指定」） |

**一般需求 `general.json`（版本 1，`default_type`）**：欄位只有 `description`（需求說明，text，最多 1000 字、保留換行，必填）；部門由 `department_directory` 提供候選，AI 信心分數 ≥ 75（`department.min_confidence`）時採用，否則請使用者選；不提供指定處理人（固定文字只有需求說明與處理部門兩行）；`workflow` 設定 `approver: { not_requester: true, message: "不能簽核自己提出的需求單" }` 與 `transfer: true`：提單人不能簽核或退回自己的一般需求，送達部門的成員可以轉單；送出後的單保存 `request_type: { id: "general", version: 1 }`

### 2.2 前端取得的類型清單 `GET /api/forms`

前端以 `GET /api/forms` 取得類型清單、欄位與送達部門；權限、限流、回應結構與範例見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.15 節

- 前端由 `frontend/src/services/draftService.js` 的 `loadRequestTypes`、`normalizeRequestTypes` 取得並整理這份需求類型目錄；`frontend/src/utils/formFormatters.js` 提供通用的欄位值格式（日期與日期時間附星期）、「X 小時 Y 分鐘」、計算結果顯示、前端備援的需求內容預覽，以及保存的表單欄位與計算結果的「名稱：值」清單（`describeFormFields`、`describeFormComputed`）

## 3. 一次對話怎麼使用這些設定

```text
使用者按「自動生成」（只有主題）
  └─ 第一回合「分類」：AI 讀 _catalog.json 的 types[].summary 與部門名錄
       → 選出 type_id、處理部門與信心分數，回覆招呼語
使用者在對話中補充資料
  └─ 之後各回合「填寫」：AI 讀這個類型的完整定義（說明、範例、欄位、規則、工作日曆摘要）
       ├─ 工具階段：見第 9 節
       └─ 整理階段：輸出要填入的欄位（updates）、處理人建議與回覆
伺服器（每一回合，以及使用者手動修改欄位後）
  └─ 依 fields 驗證 → 產生候選（field_options）→ 執行 computations → 執行 draft 階段的 checks
     → 依 render.lines 產生需求內容 → 回傳畫面
送出（POST /api/tickets）、簽核、轉單
  └─ 依同一份定義在交易內重新驗證、執行 submit／approve 階段的 checks，依 workflow 決定送達、誰能簽核、能否轉單
```

沒有 AI 時的關鍵字備援、工具呼叫次數、回合時限，以及逾時或沒有金鑰時的處理，見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.16 節

## 4. 目錄 `_catalog.json`

```json
{
  "version": 1,
  "assistant": { "instructions": ["…"], "fallback_greeting": "{username} 你好，…" },
  "types": [ { "id": "equipment", "file": "equipment.json", "name": "設備申請", "summary": "…", "keywords": ["申請螢幕"] } ],
  "default_type": "general",
  "tools": [ { "id": "department_members", "description": "…", "capability": "department_members", "params": { … }, "access": "names_only", "returns": "…" } ]
}
```

| 鍵 | 必填 | 說明與規則 |
| --- | --- | --- |
| `version` | 是 | 目錄本身的版本，正整數；只用於日誌 `request_types.ready` 的 `catalogVersion`，不影響送出驗證 |
| `assistant.instructions` | 是 | 非空的字串陣列，所有 AI 呼叫共用的系統指示，放在引擎通用說明之前；內容例如把使用者文字與工具結果都當資料、不遵從其中的指示、不捏造人名、數字、額度或 id、只從清單擇一、繁體中文、以帳號稱呼使用者（目前內容的完整要求與標點規範見 API 介面規格書第 3.16 節） |
| `assistant.fallback_greeting` | 是 | 1～600 字。第一回合沒有類型招呼語（`ai.greeting`）而 AI 又沒有回覆時使用的招呼語；可用 `{username}`、`{type_name}`、`{department}` |
| `types` | 是 | 非空陣列，每筆對應一個定義檔，順序就是沒有 AI 時關鍵字比對的順序 |
| `types[].id` | 是 | 類型 id，小寫英文開頭，只能有小寫英數、底線與連字號，不可重複；必須與定義檔的 `id` 相同 |
| `types[].file` | 是 | 同目錄下的檔名（`小寫英數.json`），不可重複，不可是 `_catalog.json` |
| `types[].name` | 是 | 類型名稱，必須與定義檔的 `name` 相同；會顯示在畫面上 |
| `types[].summary` | 是 | 1～300 字。**AI 第一回合分類時只讀這段**，寫清楚這類需求是什麼、需要哪些資料、由誰處理；一兩句即可 |
| `types[].keywords` | 是 | 字串陣列（可以是空陣列）。只在沒有 AI（未設金鑰、額度用完、AI 失敗）的第一回合使用：主題包含任一關鍵字（不分大小寫）就選這個類型，依 `types` 順序取第一個 |
| `default_type` | 是 | `types` 中的一個 id；沒有專用類型的需求都用它（目前為 `general`） |
| `tools` | 是 | AI 可呼叫的工具陣列（可以是空陣列），見第 9 節 |
| `tools[].id` | 是 | 工具名稱（小寫英數與底線），AI 與定義檔的 `ai.tools`、`options_tool` 都用這個名稱 |
| `tools[].description` | 是 | 給 AI 讀的用途說明 |
| `tools[].capability` | 是 | 程式提供的能力名稱，只能是 `department_directory`、`department_members`、`colleagues`、`my_ledger_balance`、`request_type_definition` 五種（各能力的合約見第 9 節） |
| `tools[].params` | 是 | `{ 參數名稱: { type, description, required } }`；`type` 為 string、integer、number 或 boolean，`required` 為布林值。參數名稱與型別必須恰好符合能力的合約（見第 9 節），否則啟動失敗 |
| `tools[].access` | 是 | 存取規則，必須是該能力允許的規則（見第 9 節） |
| `tools[].returns` | 是 | 給 AI 讀的回傳內容說明 |

## 5. 類型定義檔

定義檔的結構為 `{ id, version, name, department_id, department?, handler?, ai, fields, computations?, ledger?, checks?, render, workflow }`；頂層只允許下列鍵，以及計算參數引用的物件（例如請假的 `calendar`）：

| 鍵 | 必填 | 說明 |
| --- | --- | --- |
| `id` | 是 | 必須與目錄的 `types[].id` 相同 |
| `version` | 是 | 正整數；**修改欄位或規則時要加 1**（舊草稿與已送出的單怎麼處理見第 14 節） |
| `name` | 是 | 必須與目錄的 `types[].name` 相同 |
| `department_id` | 是 | 固定送達部門 id；`null` 表示由對話決定，此時必須有 `department` |
| `department` | `department_id` 為 null 時必填 | `{ options_tool, min_confidence }`；`options_tool` 必須是能提供部門選項的工具（目前為 `department_directory`），`min_confidence` 為 0～100 的整數 |
| `handler` | 否 | `{ options_tool, not_self }`：有這個鍵時自動生成畫面提供「指定處理人」；候選名單固定是處理部門的啟用中一般帳號（`not_self` 為 true 時排除提單人本人），不受 `options_tool` 影響；`options_tool` 只在載入時檢查，必須是能提供帳號選項的工具（慣例寫 `department_members`），執行時不會讀取；沒有這個鍵時不提供指定處理人（送出時帶 `handler_id` 的規則見 API 介面規格書第 3.3 節）；**目前所有類型都沒有設定**（2026-11-02 起提出需求單頁不提供指定處理人） |
| `ai` | 是 | 給 AI 的說明，見下表 |
| `fields` | 是 | 欄位陣列，至少一個，見第 6 節 |
| `computations` | 否 | 計算，見第 7.1 節 |
| `ledger` | 否 | 額度帳，見第 7.2 節 |
| `checks` | 否 | 檢查，見第 7.3 節；需要 `ledger` |
| `render` | 是 | `{ lines: [...] }`：需求內容的固定文字，見第 8 節 |
| `workflow` | 是 | 送達、簽核與轉單規則，見第 10 節 |

`ai` 的內容：

| 鍵 | 必填 | 說明 |
| --- | --- | --- |
| `ai.description` | 是 | 之後各回合 AI 讀的完整說明：這類需求是什麼、每個欄位要什麼、有哪些限制 |
| `ai.examples` | 是 | 字串陣列（可為空），使用者可能怎麼說，例如「下週一請病假」 |
| `ai.greeting` | 否 | 1～600 字的第一回合招呼語，可用 `{username}`（帳號）、`{type_name}`（類型名稱）、`{department}`（處理部門名稱） |
| `ai.ask_order` | 否 | 欄位 key 陣列，AI 詢問缺少資料的順序 |
| `ai.tools` | 否 | 這個類型允許 AI 呼叫的工具 id（必須在目錄 `tools` 中）。沒有列出的工具，AI 呼叫時一律被拒絕 |

## 6. 欄位 `fields`

每個欄位共通的鍵：

| 鍵 | 必填 | 說明 |
| --- | --- | --- |
| `key` | 是 | 欄位代號：小寫英文開頭、小寫英數與底線；同一檔內不可重複；不可使用保留名稱 `department`、`handler`、`type_id`、`department_id`、`handler_id` |
| `label` | 是 | 顯示名稱，也用在錯誤訊息（例如「數量不可大於 50」） |
| `type` | 是 | 欄位型別，見下表 |
| `required` | 否 | 布林值，省略為 false；必填而空白時列為「待補」，送出時回 400「表單還缺少：{label}」 |

欄位型別：

| 型別 | 值的格式 | 型別專屬的鍵 | 伺服器檢查與訊息 |
| --- | --- | --- | --- |
| `self` | 目前登入的帳號 | 無 | 值一律由伺服器填入，使用者與 AI 都不能改；每個檔最多一個，一律不是必填。它的 `label` 也用在帳號欄位的訊息（例如「代理人不能是請假人本人」） |
| `enum` | 選項之一 | `options`：不重複的非空白字串陣列（必填） | 「{label}請從「A、B、C」擇一」 |
| `text` | 文字 | `max_length`：1～2000 的整數（必填）；`multiline`：布林值，true 時保留換行，否則把連續空白與換行合併成一個空白 | 「{label}最多 N 字」 |
| `number` | 阿拉伯數字（可有小數點與負號，千分位逗號會被去掉） | `min`、`max`：數字（`min` 不可大於 `max`）；`integer`：布林值 | 「{label}必須是數字」「{label}必須是整數」「{label}不可小於 N」「{label}不可大於 N」 |
| `date` | `YYYY-MM-DD`（也接受 `YYYY/M/D`，會補零） | `rules`：`after`（另一個 date 欄位的 key）、`not_before_today`（true 時不可早於台北今天） | 「{label}格式需為 YYYY-MM-DD」「{label}不可早於今天」「{label}必須晚於{另一欄 label}」 |
| `datetime` | `YYYY-MM-DDTHH:mm`（也接受空白分隔、斜線與 `:00` 秒數），台北時間 | `rules`：`after`（另一個 datetime 欄位的 key） | 「{label}格式需為 YYYY-MM-DDTHH:mm」「{label}必須晚於{另一欄 label}」 |
| `account` | 一般帳號名稱（例如 `kevin.ho`） | `options_tool`、`filters`、`unavailable_message`、`unavailable_reason`（見下方） | 「{label}必須是系統內的一般帳號」「{label}不能是{self label}本人」「{label}必須與{self label}同部門」，期間內已有申請時為 `unavailable_message` |
| `department` | 部門 id | `options_tool`（目前為 `department_directory`） | 「{label}必須是存在的部門」；需求內容中顯示部門名稱 |

`account` 欄位的設定：

| 鍵 | 說明 |
| --- | --- |
| `options_tool` | 候選來源工具：`colleagues`（本人部門的同事，不含本人）或 `department_members`（處理部門的成員）。伺服器每次都用同一個能力產生畫面上的下拉選單（`field_options`），與 AI 是否可用無關 |
| `filters.same_department` | true 時必須與提單人同部門 |
| `filters.not_self` | true 時不可是提單人本人 |
| `filters.active` | 說明用的旗標；帳號查詢本來就只接受啟用中、且部門仍存在的一般帳號，設成 false 也不會放寬 |
| `filters.not_busy_between` | 兩個不同的 date／datetime 欄位 key `[起, 迄]`；兩個欄位都有效時，這段期間內已有待簽核或已核准申請的帳號不可選。「已有申請」看的是**所有**定義了 `ledger_overlap` 檢查的類型（目前只有請假） |
| `unavailable_reason` | 不可選的帳號在下拉選單旁顯示的原因，預設「此期間已有其他申請」 |
| `unavailable_message` | 選了不可選的帳號時的錯誤訊息，預設「{label}在此期間已有其他申請，不能選擇」 |

其他規則：

- 每個欄位值（不分型別）最多 500 字；`text` 的 `max_length` 較大時以它為準。超過時視為格式錯誤的請求（400）。
- `rules` 只能用在 date 與 datetime；`rules.after` 必須指向另一個**相同型別**的欄位。`options_tool` 只能用在 account 與 department。
- AI 送來的值也會先依型別整理格式，再做同樣的檢查；AI 填錯只會讓欄位顯示「格式不符」，不會被直接採用。
- 前端「自動生成」視窗依回應 `type.fields` 的型別產生輸入元件：`self` 唯讀、`enum` 下拉、`text` 在 `max_length` 超過 100 或沒有上限時為多行（`frontend/src/components/propose/draftDialog.js` 的 `TEXTAREA_THRESHOLD`）、`number` 依 `min`／`max` 產生（整數時 step 1）、`date`、`datetime`（日期時間選擇器：月曆加時間按鈕與「其他時間」輸入；`rules.after` 指向前面同型別欄位的兩個欄位合併成一個期間欄位，`not_before_today` 停用今天以前；計算 `work_minutes` 使用的工作日曆會以 `type.calendars` 交給畫面，讓期間只列上班時段、停用非工作日與假日，並提供整天與各時段的快捷；詳見 API 規格書第 3.18 節）、`account`／`department` 為依 `field_options` 建立的下拉，不可選的項目停用並附原因（例如請假的代理人在期間內也請假）；多行輸入框只是畫面的呈現，與定義檔的 `multiline`（只影響是否保留換行）是兩件不同的事

## 7. 計算、額度帳與檢查

這三項只用在需要「由系統算出數字、扣額度、擋重複」的類型（例如請假）。沒有需要時整段省略即可（例如設備申請）。

### 7.1 計算 `computations`

```json
"computations": [
  { "key": "minutes", "label": "請假時數", "capability": "work_minutes",
    "args": { "start": "start_at", "end": "end_at", "calendar": "calendar" },
    "display": "hours_minutes",
    "messages": { "cross_year": "請假期間不可跨年度，請分開申請" } }
]
```

| 鍵 | 說明 |
| --- | --- |
| `key` | 計算結果的名稱（小寫英數與底線），不可與欄位 key 或保留名稱相同，可以在 `render.lines` 與 `ledger.amount` 引用 |
| `label` | 顯示名稱（畫面的計算結果、狀態追蹤卡片） |
| `capability` | 計算能力，目前只有 `work_minutes` |
| `args` | 能力需要的參數，見下方 |
| `display` | 選填，不需參數的篩選器名稱（`hours_minutes`、`date`、`time`），決定畫面與卡片上的格式 |
| `messages` | 選填，覆寫能力的錯誤訊息 |

**`work_minutes`**：計算一段期間落在上班時段的分鐘數。`args.start`、`args.end` 是兩個 datetime 欄位的 key；`args.calendar` 是這份定義中**工作日曆物件**的頂層鍵名（例如 `"calendar"`），該物件因此成為允許的頂層鍵：

| 日曆鍵 | 說明 |
| --- | --- |
| `timezone_offset` | `±HH:mm`，例如 `+08:00`；也決定這個類型的「今天」 |
| `work_windows` | 依時間排序、不重疊的上班時段，例如 `[["09:00","12:00"],["13:00","18:00"]]` |
| `workdays` | 0～6 的不重複整數（0 為週日），例如 `[1,2,3,4,5]` |
| `holidays` | 以四位數年度為鍵、值為該年度內的 `YYYY-MM-DD` 假日陣列；**只有列出的年度可以計算**，其他年度回「{year} 年度尚未開放」 |
| `unit_minutes` | 正整數，結果依此向上取整 |
| `min_minutes` | 正整數，結果小於它時視為沒有落在上班時段 |
| `max_days` | 正整數，期間最多幾天 |
| `same_year` | 選填布林值（預設 true），起訖必須在同一年度 |

可覆寫的訊息（`messages`）：`cross_year`（跨年度）、`year_closed`（年度未開放，可用 `{year}`）、`max_days`（超過天數，可用 `{max_days}`）、`no_work_time`（沒有落在上班時段）；格式錯誤與「截止時間必須晚於起始時間」為固定訊息；計算失敗時，訊息會掛在對應的欄位上；例：2026-12-01（週二）09:30～17:30，在 09:00～12:00、13:00～18:00 的日曆下為 150 + 270 = 420 分鐘（7 小時 0 分鐘；請假目前的日曆設定見第 2.1 節）

### 7.2 額度帳 `ledger`

```json
"ledger": { "kind": "balance", "category_field": "leave_type", "amount": "minutes", "period_from": "start_at", "entitlement_table": "leave_entitlements" }
```

| 鍵 | 說明 |
| --- | --- |
| `kind` | 目前只有 `balance`（有額度、會被扣用） |
| `category_field` | 類別欄位：必須是**必填的 enum 欄位**，例如假別 |
| `amount` | 數量：`computations` 的 key，例如請假分鐘數 |
| `period_from` | 期間：date／datetime 欄位，取它的年度 |
| `entitlement_table` | 額度表名稱，必須在程式允許清單 `LEDGER_TABLES`（目前只有 `leave_entitlements`，類別只能是事假、病假、特休）；額度表的細節見 API 介面規格書第 3.15 節 |

剩餘額度的算法、送出時保存的 `form.ledger` 快照與新增額度表的限制，見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.4、3.15 節

### 7.3 檢查 `checks`

```json
"checks": [
  { "capability": "ledger_balance", "on": ["draft", "submit", "approve"],
    "error": { "code": "LEAVE_BALANCE_INSUFFICIENT", "message": "假別剩餘時數不足" }, "summary_label": "{leave_type}剩餘時數" },
  { "capability": "ledger_overlap", "on": ["draft", "submit"], "args": { "start": "start_at", "end": "end_at" },
    "error": { "code": "LEAVE_OVERLAP", "message": "這段時間已有請假單" } }
]
```

| 鍵 | 說明 |
| --- | --- |
| `capability` | `ledger_balance`（本次數量不可超過剩餘額度；剩餘＝額度表的年度額度，送出與核准都不會扣除，額度由人資在公司既有的系統處理）或 `ledger_overlap`（本人在期間內不可已有同類型的待簽核或已核准單）；都需要這份定義有 `ledger` |
| `on` | 在哪些階段執行：`draft`（自動生成畫面，失敗時欄位顯示錯誤、不能套用）、`submit`（送出時，與寫入在同一筆交易內）、`approve`（核准時在同一筆交易內重新計算；這張單已算在待簽核內，剩餘小於 0 才失敗，失敗時回 409 且不改變狀態） |
| `args` | `ledger_overlap` 需要 `{ start, end }`，兩個 date／datetime 欄位的 key |
| `error` | `{ code, message }`：檢查失敗時的錯誤代碼與訊息（回應方式見 API 介面規格書第 3.3、3.7 節） |
| `summary_label` | 選填（只對 `ledger_balance` 有意義），畫面摘要的名稱，可引用欄位，例如「{leave_type}剩餘時數」會產生「特休剩餘時數：112 小時 0 分鐘 → 105 小時 0 分鐘」（數量的計算有 `display: hours_minutes` 時以時分顯示，否則為數字） |

## 8. 需求內容的固定文字 `render.lines`

`render.lines` 的每一行就是套用到「需求內容」的一行文字。`{名稱}` 會被代入值，`{名稱|篩選器}` 或 `{名稱|篩選器:參數}` 會先經過篩選器（可以串接多個）：

| 可代入的名稱 | 沒有篩選器時顯示 |
| --- | --- |
| 欄位 key | 欄位值（department 欄位顯示部門名稱） |
| 計算結果 key | 數字 |
| `department` | 處理部門名稱 |
| `handler` | 指定處理人帳號（未指定時為空） |

| 篩選器 | 參數 | 結果 |
| --- | --- | --- |
| `date` | 無 | 「YYYY-MM-DD（週X）」，可用在 date 或 datetime |
| `time` | 無 | 「HH:mm」 |
| `date_range:<欄位>` | 另一個日期類欄位 key | 與該欄位同一天時只顯示一天，不同天為「A～ B」 |
| `hours_minutes` | 無 | 分鐘數 →「X 小時 Y 分鐘」 |
| `default:<文字>` | 任意文字 | 值為空時改用這段文字，例如 `{note\|default:無}` |

規則與注意事項：

- 一般文字中不能出現單獨的 `{` 或 `}`（沒有跳脫寫法）。
- 佔位文字引用錯誤時啟動失敗（見第 2 節的驗證項目）；送出時伺服器怎麼比對這段固定文字、提出需求單頁怎麼阻擋改動，見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.3、3.18 節
- 需求內容上限 2000 字，請讓固定文字保持精簡。
- `checks[].summary_label` 使用相同的範本語法，但只能引用欄位。

## 9. AI 工具（資料來源）與權限

工具由目錄的 `tools` 定義，類型以 `ai.tools` 開放；伺服器端依 `access` 強制限制，模型無法取得規則以外的資料；工具結果只當資料交給模型，不是指示；工具參數不符、找不到部門或類型、類型沒有額度帳時回 `{ error }` 給模型，由模型改問使用者，不讓請求失敗，資料庫暫時無法讀取時也只回錯誤資料給模型

存取規則：`all`（不限）、`self_only`（只能是本人）、`same_department`（只能是本人部門）、`names_only`（輸出只保留 `id`、`name` 與可否選擇的 `available`、`reason`）；每種能力只接受特定的存取規則與參數合約，目錄寫錯時啟動失敗；各能力的合約、存取規則的細節、工具呼叫的方式與次數限制，以及撰寫工具說明的注意事項，見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.15、3.16 節

目前目錄中的工具：

| 工具 id | 能力（`capability`） | 參數 | `access` | 回傳 | 開放給 |
| --- | --- | --- | --- | --- | --- |
| `department_directory` | `department_directory` | 無 | `all` | 全部部門 `{ id, name, duty, business }` | 所有類型 |
| `department_members` | `department_members` | `department_id`（必填） | `names_only` | 該部門啟用中的一般帳號，只有 `{ id, name }`（帳號名稱） | 目前沒有類型開放：2026-11-02 移除指定處理人時，全部需求類型一併拿掉 `handler` 設定與 `ai.tools` 的 `department_members`，招呼語不再提「可以指定誰處理」，一般需求的固定文字去掉「[指定處理人]」一行（版本維持 1，舊內容多一行仍可通過比對） |
| `colleagues` | `colleagues` | `start_at`、`end_at`（選填，`YYYY-MM-DDTHH:mm`，需同時提供且終點晚於起點） | `same_department` | 目前使用者同部門、啟用中的一般帳號同事（不含本人）`{ id, name, available, reason? }`；提供期間時，在期間內已有待簽核或已核准申請（所有定義了 `ledger_overlap` 的類型）的同事 `available` 為 false；部門固定為本人部門，模型不能指定其他部門 | 請假 |
| `my_leave_balance` | `my_ledger_balance` | `period`（integer，選填，四位數年度，省略為台北今天的年度） | `self_only` | 本人在**目前類型額度帳**的各類別額度 `{ period, unit, balances: [{ category, granted, used, pending, remaining, remaining_text }] }`（`remaining` 為年度額度，`used`、`pending` 只是參考）；數字由伺服器從資料庫以唯讀查詢計算，固定查本人，模型帶入其他帳號的參數一律忽略；目前類型沒有 `ledger` 時回錯誤；不作為任何欄位的候選 | 請假 |
| `request_type_definition` | `request_type_definition` | `type_id`（必填） | `all` | 指定類型給 AI 的完整定義（說明、範例、欄位、計算名稱、送達部門） | 目前沒有任何類型在 `ai.tools` 開放，AI 實際上不會呼叫（已實作並通過驗證，未啟用） |

撰寫工具的注意事項：

- 權限由能力的程式碼與 `access` 規則強制，不靠 AI 自律；即使 AI 被使用者文字誘導，也拿不到規則以外的資料（例如 `my_leave_balance` 永遠只能查本人）。

## 10. 流程 `workflow`

`workflow` 的結構為 `{ route: 'FORM' | 'DEPARTMENT', approver?: { department: 'definition', not_requester, message? }, transfer?, transfer_error?: { code, message }, judgement?: { source: 'draft' } }`：

- `FORM` 需要固定部門（`department_id`），`DEPARTMENT` 需要 `department_id: null`
- `not_requester` 省略時為 true（不可本人簽核）；`transfer` 省略時依 route 決定（`FORM` 為不可轉單、`DEPARTMENT` 為可以）
- `DEPARTMENT` 單不保存 `form`，改保存 `request_type: { id, version }`，後端的本人簽核與轉單檢查依這個類型的定義判斷（`approve` 檢查只對帶 `form` 的單執行）
- 各鍵的完整行為（保存內容、簽核與轉單被拒時的回應與預設訊息、類型已不在目錄的單）見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.3、3.7、3.9、3.15 節

目前七種類型都設定 `not_requester: true`；可以轉單的是報修、設備申請與一般需求，請假、打卡補登、VPN 申請與採購申請都不能轉出送達部門（各類型的設定見第 2.1 節）

## 11. AI 看得到什麼、看不到什麼

每回合交給 AI 的資料、AI 看不到的設定、AI 輸出的限制，以及 AI 文字的標點整理（招呼語是否經過整理），見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.16 節

## 12. 什麼時候需要改程式

只要使用既有的欄位型別、能力、工具與額度表，新增或修改需求類型都**不需要改程式**。下列情況才需要修改 `backend/src/services/requestTypes/`：

- 新的欄位型別（`fieldTypes.js`，並同步前端依型別產生欄位的程式）。
- 新的計算或檢查能力（`capabilities.js` 的 `COMPUTATION_CAPABILITIES`、`CHECK_CAPABILITIES`）。
- 新的工具能力，也就是新的資料來源（`capabilities.js` 的 `TOOL_CAPABILITIES` 與 `executeTool`），並決定它允許的 `access`。
- 新的額度表（`storage/database.js` 的 `LEDGER_TABLES`，以及對應的資料庫遷移）。
- 新的渲染篩選器（`renderer.js` 的 `FILTERS`）。

新程式仍然不可以出現任何類型的 id、欄位 key 或領域用語（`backend/tests/requestTypes.test.js` 與 `frontend/tests/genericRequestTypes.test.js` 會掃描），並同步更新本文件與 API 規格書；其他開發約定見 [AGENTS.md](../AGENTS.md)

## 13. 一步一步新增需求類型：以 `equipment.json`（設備申請）為例

設備申請就是用這個流程加進來的，沒有修改任何程式。以下用它當範例；要新增其他類型時照著改名與欄位即可。

### 步驟 1：先決定內容

| 問題 | 設備申請的答案 |
| --- | --- |
| 類型 id 與名稱 | `equipment`、設備申請 |
| 送達哪個部門？固定還是對話決定？ | 固定送總務與硬體組 `dept-ga-1`（部門必須已在 `data/departments.json`，且該部門要有一般帳號才有人能簽核；需要新部門時先加入部門設定檔，再以 `scripts/personnel.js` 建立該部門的帳號，見部署手冊第 5.7 節） |
| 需要哪些欄位？哪些必填？格式限制？ | 申請人（自動填入的 self 欄位，一律非必填）、設備品項（50 字內）、數量（1～50 的整數）、用途說明（200 字內）、需要日期（不可早於今天）、送交地點（50 字內），申請人以外全部必填 |
| 需要系統計算、扣額度或擋重複嗎？ | 不需要（沒有 `computations`、`ledger`、`checks`） |
| AI 需要查哪些資料？ | 部門名錄（說明誰處理） |
| 能不能指定處理人？ | 不能（目前所有類型都不提供，定義檔不寫 `handler`） |
| 提單人能不能簽核自己的單？能不能轉單？ | 不能本人簽核；可以轉給其他部門 |

### 步驟 2：在目錄加一筆

在 `_catalog.json` 的 `types` 加入（放在 `general` 之前，讓關鍵字先比對到它）：

```json
{
  "id": "equipment",
  "file": "equipment.json",
  "name": "設備申請",
  "summary": "向總務申請配發電腦、螢幕、鍵盤滑鼠、周邊或其他辦公設備給自己或新人使用，需要品項、數量、用途、需要日期與送交地點，由總務與硬體組處理。設備壞了屬於報修，要對外購買屬於採購申請。",
  "keywords": ["設備申請", "申請設備", "申請電腦", "申請螢幕", "鍵盤", "滑鼠", "周邊"]
}
```

`summary` 是 AI 分類的唯一依據，要寫出「什麼需求」「需要什麼資料」「誰處理」；有相近的類型時，再補一句分界，寫出容易混淆的情況該用哪一種，像上例的「設備壞了屬於報修」；目前目錄的 `summary` 與各定義的 `ai.description` 寫的分界包括：設備壞了要修屬於報修、要對外購買屬於採購申請，VPN 連不上屬於一般需求，打卡補登的那段時間沒有上班屬於請假申請

`keywords` 只在沒有 AI 時使用，選不容易誤判的詞（例如不要只寫「申請」），並注意依 `types` 順序取第一個相符的類型：比較專門的類型要排在前面（目前報修排在設備申請之前，「滑鼠故障」才會先比對到報修）

### 步驟 3：建立定義檔的基本資料

新增 `backend/data/requestTypes/equipment.json`：

```json
{
  "id": "equipment",
  "version": 1,
  "name": "設備申請",
  "department_id": "dept-ga-1"
}
```

`id`、`name` 必須和目錄完全相同。新類型的 `version` 從 1 開始。

### 步驟 4：寫給 AI 的說明

```json
"ai": {
  "description": "向總務申請配發電腦、螢幕、鍵盤滑鼠、周邊或辦公設備：需要設備品項、數量（1～50 的整數）、用途說明、需要日期（不可早於今天）與送交地點，由總務與硬體組處理。設備壞了要修屬於報修，要對外購買屬於採購申請。",
  "examples": ["想申請一台 27 吋螢幕", "新人需要兩組鍵盤滑鼠", "下週三前需要一台筆電"],
  "greeting": "{username} 你好，這邊已經收到你想要申請設備的需求，根據您的需求您的業務將會由總務與硬體組進行處理，由於設備申請需要您先提供一些基本的訊息，請告訴我你想申請的設備品項、數量、用途、需要日期與送交地點，我將會自動為您生成需求單給您送出；如果填寫過程中有遇到任何問題，可以隨時與我溝通，例如不清楚填寫格式等等",
  "ask_order": ["item", "quantity", "purpose", "needed_by", "location"],
  "tools": ["department_directory"]
}
```

- `description` 要寫出每個欄位的限制，AI 才會在對話中提醒使用者。
- `greeting` 有設定時，第一回合一律用這段文字。
- `tools` 只列需要的工具；這裡不需要 `colleagues` 或 `my_leave_balance`。

### 步驟 5：定義欄位

```json
"fields": [
  { "key": "applicant", "label": "申請人", "type": "self" },
  { "key": "item", "label": "設備品項", "type": "text", "required": true, "max_length": 50 },
  { "key": "quantity", "label": "數量", "type": "number", "required": true, "min": 1, "max": 50, "integer": true },
  { "key": "purpose", "label": "用途說明", "type": "text", "required": true, "max_length": 200 },
  { "key": "needed_by", "label": "需要日期", "type": "date", "required": true, "rules": { "not_before_today": true } },
  { "key": "location", "label": "送交地點", "type": "text", "required": true, "max_length": 50 }
]
```

畫面上的輸入元件由前端依型別自動產生（見第 6 節）；伺服器會產生「數量不可小於 1」「數量必須是整數」「需要日期不可早於今天」這類訊息，不需要另外寫

### 步驟 6：定義需求內容的固定文字

```json
"render": {
  "lines": [
    "[申請人]: {applicant}",
    "[設備品項]: {item}",
    "[數量]: {quantity}",
    "[用途說明]: {purpose}",
    "[需要日期]: {needed_by|date}",
    "[送交地點]: {location}"
  ]
}
```

套用後的需求內容會像這樣（假資料）：

```text
[申請人]: racky.huang
[設備品項]: 27 吋螢幕
[數量]: 1
[用途說明]: 開發用雙螢幕
[需要日期]: 2026-12-03（週四）
[送交地點]: 3F 資訊室
```

### 步驟 7：定義流程

```json
"workflow": {
  "route": "FORM",
  "approver": { "department": "definition", "not_requester": true },
  "transfer": true
}
```

`FORM` 表示送達固定部門並在需求單保存欄位；`not_requester: true` 讓總務同仁自己提出的申請由另一位同仁簽核；`transfer: true` 讓總務收到不屬於自己的申請時可以轉出。

### 步驟 8：在本機啟動並修正錯誤

```bash
cd backend
npm run dev
```

啟動成功與失敗時的日誌見 [backend/README.md](../backend/README.md)「日誌與排查」；失敗時依 `detail` 指出的檔名與鍵路徑修正，常見的 `detail` 範例與修正方式見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.15 節

### 步驟 9：實際操作一次

操作與驗收的步驟（不設金鑰時的自動生成、輸入錯誤值、套用送出、另一位帳號簽核與轉單按鈕、有金鑰時的 AI 填寫）見[部署手冊](Docker與Lightsail部署操作手冊.md)第 2.4 節第 7 點（設備申請）

### 步驟 10：測試、提交與部署

1. 在 `backend/` 與 `frontend/` 執行 `npm test`。只新增 JSON 不需要改測試；若要讓新類型有自己的測試，可參考 `backend/tests/requestTypes.test.js` 的「新增的打卡補登、VPN 申請、報修與採購申請只靠 JSON 定義運作」，或 `backend/tests/draftFlow.test.js` 中只用 JSON 定義的虛構類型（`overtime.json`）。
2. 在評測題庫加入這個類型的題目（第 15 節），執行 `npm run eval:classify`，確認新類型和其他類型都沒有被認錯。
3. 提交前檢查暫存內容，定義檔中不可有真實密碼、金鑰或個人資料（範例只用假資料）。
4. 依部署手冊第 5.9 節重新建置並更新 backend image；前端會依定義自動顯示，web image 不必更新；部署後若出現 `request_types.failed`，backend 會反覆重啟，網站的 API 請求會得到 502，`up --wait` 也會等不到健康狀態；這時換回部署前標記的 backend image 再 up，修正 JSON 後重新建置，資料庫不受影響

### 如果新類型也需要計算或額度

參考 `leave.json`：加入工作日曆物件與 `computations`（`work_minutes`）、`ledger`（類別欄位、數量、期間、額度表）與 `checks`（`ledger_balance`、`ledger_overlap`），並在 `render.lines` 用 `{minutes|hours_minutes}` 顯示計算結果；可用的額度表見第 7.2 節

## 14. 修改既有類型的注意事項

- **改了欄位或規則就把 `version` 加 1**：畫面上舊版本的草稿送出時會得到 409 `FORM_VERSION_CHANGED`，請使用者重新確認；已送出的單保留舊版本，不會被改寫
- **改名稱（`label`）或刪除欄位**：已送出的單在狀態追蹤卡片上怎麼顯示，見 [API 介面規格書](企業智慧服務台%20Agent%20前後端%20API%20介面規格書.md)第 3.8 節
- **修改 `ledger` 或 `checks`**：已送出的單依自己保存的 `form.ledger` 快照計算額度；舊版本沒有快照的單（例如請假版本 1）改用定義指定的欄位與計算結果，因此不要隨意改類別欄位、數量或期間欄位的 key。
- **刪除或改名整個類型**：已送出的這類單仍保留，但 `form.id`（一般需求等 `DEPARTMENT` 類型為 `request_type.id`）已不在目錄時，帶表單的單改用單上保存的欄位名稱（快照）顯示且不能轉單，所有這類單都不能由提單人本人簽核；請先處理完這類待簽核的單再移除定義
- **改 `summary` 或 `keywords`**：只影響之後的分類，不影響已送出的單，也不需要改 `version`。改完重跑分類評測（第 15 節），確認沒有讓其他類型變差。

## 15. 分類評測

類型越多，第一回合越容易把相近的需求分錯；分類的準確度用評測腳本 `npm run eval:classify`（`backend/scripts/eval-classification.js`）量測，它是開發工具，不是 API，也不改變 API；腳本以題庫 `backend/evals/classification-cases.json`（目前 78 題，其中邊界題 16 題）量測第一回合分類的類型、部門、最常混淆的配對、邊界題與多輪結果是否一致，AI 與沒有 AI 時的關鍵字備援都能量測；每題的請求由 `draftEngine.js` 匯出的 `classificationRequest` 產生（自動生成與評測共用，提示詞與正式畫面相同），再直接呼叫 `assistant.classify`，和題庫的答案比對

```bash
cd backend
npm run eval:classify                          # 與服務相同：先用主要供應商，AI 失敗時改用有金鑰的備援
npm run eval:classify -- --provider anthropic  # 只用 Claude（比較兩家時使用；--provider gemini 只用 Gemini）
npm run eval:classify -- --repeat 3            # 每題三輪，看判斷穩不穩定
npm run eval:classify -- --offline             # 不呼叫 AI，只評測關鍵字備援
npm run eval:classify -- --min-accuracy 0.9    # 低於 90% 或有呼叫失敗時結束碼 1
```

- 需要 `backend/.env` 的 AI 金鑰與可用的模型（`--offline` 不需要）；不加 `--provider` 時與服務使用同一個助手與同一套備援規則：先用主要供應商（`AI_PROVIDER`，預設 Gemini），遇到限流、上游錯誤、回應格式異常或逾時（`src/services/ai/providers.js` 的 `DRAFT_FALLBACK_REASONS`）就改用有金鑰的另一家；報告會列出每個模型回答了幾題；加 `--provider gemini` 或 `--provider anthropic` 只用指定的一家、不切換備援，可以用同一份題庫比較兩家；每題呼叫一次 AI（重試另計），會用到 API 額度，但不經過 HTTP、不占用服務的每日自動生成額度，也不讀寫資料庫
- 限流、逾時與上游錯誤最多重試 2 次；最先完成的 3 題全部失敗時腳本會停止，其餘題目記為 `SKIPPED`，並提示檢查金鑰與模型名稱；加 `--verbose` 可以看到後端的錯誤日誌，例如 Gemini 回的狀態碼（模型名稱錯誤時為 404）
- 題庫格式：`{ "version": 1, "description": "說明（選填）", "cases": [ { "subject": "主題", "type": "類型 id" } ] }`；由對話決定部門的類型（一般需求）必須加 `"department": "部門 id"`；刻意測試兩種類型分界的題目可加 `"boundary": "容易混淆的類型 id"`，報告會另外統計邊界題；題庫在 `npm test` 會被驗證（`backend/tests/classificationEval.test.js`）
- 題目寫成使用者真的會輸入的主題：短句、口語，也要有說得不清楚的。每種類型至少放幾題靠近其他類型邊界的題目，例如「滑鼠不好用想換一個」（設備申請，不是報修）。
- 報告列出類型準確度、部門準確度、各類型的召回率與精確率、最常混淆的類型配對、邊界題（題庫的 `boundary`）準確度、多輪結果不一致的題目，以及答錯的題目；「部門準確度」照正式畫面的規則算：固定部門的類型一律送固定部門，一般需求的 AI 信心分數未達 `department.min_confidence`（75）時，畫面會請使用者自己選部門，這種題目不算答對，另外列出題數
- 看報告時先看「最常混淆」。同一對類型反覆互認，就修改兩邊的 `summary`（必要時連 `ai.description` 一起改），寫出分界，再重跑評測。不要為了讓某一題答對，把題目的字眼直接抄進摘要。
- 多輪結果不一致的題目，表示 AI 對它沒把握。主題本身模稜兩可時可以接受；若是常見的說法，就在摘要寫清楚。
- 解讀結果時要記得，題庫與類型摘要都由同一次開發撰寫，滿分不代表真實使用者的說法都能判對，之後宜加入實際的主題再測；2026-10-28 至 2026-11-02 的紀錄：以 Claude 實測 78 題，類型與部門準確度都是 100%、邊界題 16／16；關鍵字備援為 47.4%（37／78）；Gemini 的評測因 `gemini-2.5-flash` 回 404 與 429 沒有完成

目前的做法是把全部類型的摘要一次交給 AI，類型在幾十種以內時，提示詞的長度不是問題。若評測顯示類型變多後準確度明顯下降，再考慮改成先檢索出幾個候選類型、再交給 AI 判斷的方式（需要改程式，第 12 節），並用同一份題庫比較前後的結果。

## 16. 檢查清單

- [ ] 目錄 `types` 有這筆，`id`、`file`、`name` 與定義檔一致；`summary` 寫清楚需求、需要的資料與處理部門；`keywords` 不容易誤判。
- [ ] `department_id` 存在於 `data/departments.json`，該部門有一般帳號可以簽核；或 `department_id: null` 並設定 `department`。
- [ ] 每個欄位的 `key` 唯一、`label` 清楚、`type` 正確；必填與格式限制符合實際需求；text 欄位都有 `max_length`。
- [ ] `ai.description` 寫出每個欄位的限制；`ai.tools` 只開放需要的工具；需要固定說法時設定 `ai.greeting`。
- [ ] `render.lines` 涵蓋所有需要的欄位，總長度在需求內容 2000 字以內。
- [ ] `workflow` 的 `not_requester` 與 `transfer` 符合部門的實際作業。
- [ ] 修改既有類型時已把 `version` 加 1。
- [ ] 評測題庫有這個類型的題目（含邊界題），`npm run eval:classify` 沒有讓任何類型明顯變差。
- [ ] 啟動、操作與測試的檢查項目見部署手冊第 5.9 節，機密資訊的規則見 [AGENTS.md](../AGENTS.md)
