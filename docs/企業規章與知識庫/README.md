# 企業規章與知識庫：組員實作指南

> 狀態：**已接上後端**（2026-11-15）：後端讀 `backend/src/services/knowledge/knowledge-base.json`（目前和本資料夾的 `knowledge-base.example.json` 內容相同），「自動生成」的 AI 用 `policy_lookup` 工具查詢並引用來源；本資料夾仍是組員撰寫與審核規章的地方，後端不讀這裡的檔案

## 1. 為什麼要做

原本 AI 只能查資料（同事、假別剩餘時數、部門名錄），無法回答「特休有幾天？」「VPN 可以用個人電腦嗎？」這類規章問題；本資料夾的工作分兩步：

```text
企業規章（給人看的完整條文） ──拆成主題──▶ 知識庫（給 AI 查詢的 JSON 資料）
```

## 2. 檔案與分工

| 檔案 | 內容 | 組員要做的事 |
| --- | --- | --- |
| [企業規章範例.md](企業規章範例.md) | 3 份規章：差勤（人資）、資安與 VPN（資訊）、設備與報修（總務） | 依格式補齊其他規章，或擴充現有條文 |
| [knowledge-base.example.json](knowledge-base.example.json) | 8 筆知識庫資料，內容取自上述規章 | 依欄位規則把規章拆成知識庫資料 |

建議範圍：每個需求類型至少有 1 份規章、2 筆知識庫資料。需求類型清單見 `backend/data/requestTypes/_catalog.json`，部門清單見 `backend/data/departments.json`。

## 3. 規章撰寫規則

1. 每份規章有編號（`POL-<部門>-<序號>`，例如 `POL-HR-01`）、權責部門 id、對應需求類型、版本、整理日期與 `SIMULATED` 標示。
2. 條文以「第 N 條（標題）」撰寫，一條只講一件事。
3. **每一條都要加標記**：
   - 【系統檢查】：系統已在需求類型 JSON 強制執行，括號內寫出對應設定。條文的數字、選項必須和 JSON 一致，先打開 JSON 核對，不要憑記憶寫。
   - 【說明】：只給 AI 回答時引用，系統不檢查。
   - 【待實作】：規章有寫但系統尚未檢查，交給開發者評估。
4. 引用法規時只寫法規名稱與條次，並自行到[全國法規資料庫](https://law.moj.gov.tw/)查證；未查證前不要寫成確定的法律依據。
5. 不要寫入真實公司名稱、真實人名、電話、密碼或內部網址。

## 4. 知識庫欄位

| 欄位 | 型別 | 必填 | 填寫方式 |
| --- | --- | --- | --- |
| `id` | string | ✅ | `KB-<部門>-<序號>`，例如 `KB-HR-001`；全庫唯一，修改同筆時沿用 |
| `policy_id` | string | ✅ | 來源規章編號，例如 `POL-HR-01` |
| `doc_name` | string | ✅ | 規章名稱，AI 回答時會當作引用來源顯示 |
| `articles` | string[] | ✅ | 來源條次，例如 `["第 5 條"]` |
| `section_title` | string | ✅ | 這筆回答的主題，用員工會問的說法 |
| `content` | string | ✅ | 可獨立閱讀的完整內容，開頭寫「課堂模擬規章。」；不能出現規章沒有的規則；標【待實作】的條文在句末加「（系統尚未檢查）」；最多 600 字 |
| `summary` | string | ✅ | 一句話摘要，不可加入 content 沒有的內容；最多 120 字 |
| `department_id` | string | ✅ | 權責部門 id，只能用 `departments.json` 裡的 id |
| `request_types` | string[] | ✅ | 相關需求類型 id，例如 `["leave"]`；AI 會依目前的需求類型找資料 |
| `keywords` | string[] | ✅ | 3～6 個員工可能使用的詞，包含口語說法（例如「年假」） |
| `enforcement` | string | ✅ | `SYSTEM`（內容含系統檢查的規則）、`INFO`（純說明）、`PLANNED`（主要為待實作規則） |
| `related_fields` | string[] | ✅ | 相關的表單欄位 key（見需求類型 JSON 的 `fields`），沒有填 `[]` |
| `sample_questions` | string[] | ✅ | 至少 2 個這筆資料能回答的問題，之後作為驗證題目 |
| `version` | string | ✅ | 例如 `1.0` |
| `updated_at` | string | ✅ | `YYYY-MM-DD`，實際整理日期 |
| `source_url` | string 或 null | ✅ | 有可公開的來源網址才填，否則填 JSON 的 `null`（不是字串 `"null"`） |
| `data_status` | string | ✅ | 本專案一律填 `SIMULATED` |

**拆分原則**：一筆回答一個主題，大約 100～250 字；同一個主題的條文合成一筆（例如代理人、時數、期間合為「請假規定」），不相關的條文分開。

## 5. 交付流程與檢查清單

1. 在本資料夾新增或修改規章（可另開檔案，例如 `企業規章_財務.md`）與知識庫 JSON，使用分支並提交 Pull Request。
2. 提交前自我檢查：
   - [ ] 【系統檢查】的條文已和需求類型 JSON 核對一致
   - [ ] 每筆知識庫的 `policy_id`、`articles` 都找得到對應條文
   - [ ] `department_id`、`request_types`、`related_fields` 都是現有的 id 或 key
   - [ ] `content` 與 `summary` 沒有規章以外的規則
   - [ ] 全部標示 `SIMULATED`，沒有真實個資、密碼或內部網址
   - [ ] JSON 格式正確（可用 `node -e "JSON.parse(require('fs').readFileSync('檔名','utf8'))"` 檢查）
3. 另一位組員審核後合併。【待實作】的條文整理成清單交給開發者。

## 6. 後端的整合方式（開發者負責，已實作）

- 審核完成的知識庫放到 `backend/src/services/knowledge/knowledge-base.json`：放在 `src` 底下，由 Dockerfile 既有的 `COPY src ./src` 帶進映像，Dockerfile 不用改（`backend/data/` 底下只會複製 Dockerfile 列出的檔）；改完重啟後端，Docker 要重新建置映像
- 第一次查詢時讀取並驗證第 4 節的欄位與 id 不重複；檔案不見或格式錯誤時只有規章查詢回錯誤給 AI，後端照常啟動；`backend/tests/proposals.test.js` 會檢查每筆的 `request_types` 與 `department_id` 都是現有的 id
- `policy_lookup` 工具：依目前的需求類型（`request_types`）與關鍵字找出最多 3 筆，回傳 `id`、`doc_name`、`articles`、`section_title`、`content`、`enforcement`、`data_status` 給 AI；計分方式見 API 規格書第 3.15 節
- AI 只引用跟使用者情況有關的條文，並附上來源規章與條次；使用者問到規定卻查不到時回答沒有找到相關規章，不得自行編造，沒問就不提（2026-11-16 起）
- 依 `AGENTS.md` 同步更新 API 規格書與[需求類型與 AI 資料來源規範](../需求類型與AI資料來源規範.md)。

## 7. 待組員確認

- 規章範例「員工差勤管理規章」第 11 條（申請時程）：2026-11-16 依使用者決定，事假、特休從「請假日 3 個工作日前提出」改成「建議至少提早 1 個工作天提出」，系統不檢查也不擋送出；請假定義拿掉 `notice_workdays` 檢查並升為版本 4，知識庫兩份的 `KB-HR-004` 與規章範例同步改寫（`enforcement` 改為 `INFO`），AI 查得到這條建議；病假事後補提的部分沒改，仍請組員確認
- 要改回強制規定時，三處一起改：在 `backend/data/requestTypes/leave.json` 的 `checks` 加回 `capability` 為 `notice_workdays` 的一筆（寫法見[需求類型與 AI 資料來源規範](../需求類型與AI資料來源規範.md)第 7.3 節），知識庫兩份（`backend/src/services/knowledge/knowledge-base.json` 與本資料夾的 `knowledge-base.example.json`）的 `KB-HR-004` 與規章範例第 11 條改回規定的寫法；只改一邊會讓 AI 說出系統沒在檢查的規則，或系統擋了卻查不到依據；改完重啟後端，請假定義的 `version` 加 1
- 2026-11-16 使用者要求實測請假以外的需求對話，調整後七種需求類型都開放 `policy_lookup`，打卡補登與 VPN 申請另開放行事曆工具（使用者有連接時 AI 才看得到）；先前記錄的「其他需求類型這次不動」由這次的決定取代
- 知識庫沒有採購專屬的規章，採購單只查得到設備申請轉採購的那一條；要不要補金額門檻、比價家數這類規章，請組員決定
