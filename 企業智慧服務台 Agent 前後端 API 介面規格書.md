---
title: 企業智慧服務台 Agent 前後端 API 介面規格書
tags: [中原資管碩, 人工智慧與流程自動化實務研討]

---

# 企業智慧服務台 Agent 前後端 API 介面規格書

本規格書為成員 A（後端與架構主導）與成員 B（前端與 UI/UX 設計）之間的標準介面合約（API Contract），旨在規範 GitHub Pages 前端網頁與部署於 AWS Elastic Beanstalk 之 Node.js Express 後端 API 服務間的通訊協定、JSON 資料綱要、動態決策路由邏輯與錯誤處理機制。

---


## 文件適用範圍與實作狀態

本次依據 [知識庫提交指南](backend/data/knowledge-submissions/README.md)、[單筆填寫範本](backend/data/knowledge-submissions/單筆資料填寫範本.md) 與三部門範例，補充來源卡片的擴充契約。本次僅更新規格文件，未變更後端、前端或執行中的知識庫。

| 項目 | 目前程式 | 本文件的擴充目標 |
| --- | --- | --- |
| 知識庫輸入 | 讀取 `backend/data/knowledgeBase.json`，主要使用 doc_name、content | 審核後整合 MD 主資料的十一個欄位 |
| MD 與驗證情境 | 不自動載入，也不作為聊天請求本文 | MD 是資料交付來源，驗證情境獨立作為測試依據 |
| retrieved_sources | 每筆只回傳 doc_name、relevance | 加入段落 ID、分類、摘要、部門、版本、日期、來源連結與資料狀態 |
| 右側來源卡片 | 文件名與相似度 | 顯示第 3 節定義的來源資訊與狀態標示 |
| 登入、userID、配額與錯誤 | 已實作後端驗證及限制 | 保留現有端點與既有成功回應頂層欄位 |

第 3 節的擴充來源欄位、第 5 節的擴充 JSON 範例及對應畫面需求是後續實作契約，**不是目前 API 已回傳的內容**。串接現有後端時仍以第 3.1 節為準。擴充完成後維持 `/api/agent/chat`，以新增來源欄位的方式演進，不在本次新增版本端點。

## 1. 系統概觀與傳輸規範

前後端通訊採用標準 RESTful API 架構，正式部署的傳輸層使用 HTTPS；本機開發可使用 HTTP。為配合前端託管於 GitHub Pages 且後端部署於 AWS Elastic Beanstalk 之跨網域環境，後端必須妥善設定跨來源資源共享（CORS）標頭。

通訊基礎設定規格如下：

* **基礎 API 網址 (Base URL)**：`https://<aws-beanstalk-domain>.elasticbeanstalk.com`
* **資料傳輸格式 (Content-Type)**：`application/json; charset=utf-8`
* **跨網域存取控制 (CORS)**：後端必須允許來源網域 `https://<github-username>.github.io`，並開放 `GET`、`POST` 與 `OPTIONS` 請求方法。
* **環境變數管理**：敏感資訊如 `GEMINI_API_KEY` 嚴禁包含於前端代碼或程式庫中，統一交由 AWS Elastic Beanstalk 後端環境變數進行管理。

---

## 2. 核心對話端點規格

本系統主要之 Agent 檢索與對話功能統一經由 `/api/agent/chat` 端點處理。前端傳入使用者輸入之問題或點擊之快捷範例，後端執行 RAG 檢索與 Gemini LLM 推理後，回傳包含解答、檢索來源、信心分數與路由處置之結構化 JSON。

端點詳細資訊如下：

* **HTTP 方法**：`POST`
* **端點路徑**：`/api/agent/chat`
* **功能說明**：接收使用者提問，觸發後端向量相似度檢索（RAG）與 Gemini LLM 推理，進行意圖分類與動態分流評估，並回傳前端戰情室所需之完整決策資料。

### 請求標頭 (Request Headers)

| 標頭名稱 (Header Name) | 標頭值 (Value) | 說明 (Description) |
| --- | --- | --- |
| `Content-Type` | `application/json` | 指定請求主體格式為 JSON |
| `Accept` | `application/json` | 指定預期接收之回應格式為 JSON |
| `Authorization` | `Bearer <token>` | 對話與用量端點必填，token 由後端登入核發 |

### 請求主體 (Request Body)

請求主體只需使用者問題與登入帳號 userID。前端先去除問題首尾空白，後端再次驗證 1～500 個 Unicode code points，JSON 本文上限 16 KB。不要將知識庫十一個欄位、來源相似度或驗證情境中的 expected_* 傳入聊天請求。

| 欄位名稱 (Field) | 資料型別 (Type) | 必填 (Required) | 說明與限制 (Description & Constraints) |
| --- | --- | --- | --- |
| `message` | `string` | 是 | 使用者輸入之提問文字，長度介於 1 至 500 字元之間 |
| `userID` | `string` | 是 | 固定識別碼，例如 `user-admin1`；必須與驗證後憑證身分相同，配額以憑證身分計算 |

### 課堂展示登入與 userID

前端首頁為登入頁 `index.html`，後端驗證成功後導向 `chat.html`。帳號限定 `admin1`～`admin10`，登入密碼由後端 `DEMO_PASSWORD` 提供，沒有內建預設值，並由授課者私下提供給使用者。其他帳號顯示「查無使用者」，已知帳號密碼不符顯示「密碼錯誤」。

| 帳號 | 固定 userID |
| --- | --- |
| `admin1` | `user-admin1` |
| `admin2` | `user-admin2` |
| `admin3` | `user-admin3` |
| `admin4` | `user-admin4` |
| `admin5` | `user-admin5` |
| `admin6` | `user-admin6` |
| `admin7` | `user-admin7` |
| `admin8` | `user-admin8` |
| `admin9` | `user-admin9` |
| `admin10` | `user-admin10` |

`POST /api/auth/login` 接收 `{ "username": "admin1", "password": "<PASSWORD>" }`，成功回傳 `{ "token": "<JWT>", "expiresAt": 1790000000000, "user": { "username": "admin1", "userID": "user-admin1" } }`；`expiresAt` 是 epoch 毫秒，範例數值僅示意。JWT 以 HS256 簽署，預設兩小時有效，驗證簽章、期限、發行者與受眾。

前端只在 sessionStorage 保存後端核發的憑證、期限及身分，不保存密碼、不在前端比對密碼。對話與用量 API 必須傳送 `Authorization: Bearer <token>`；對話本文另傳 `userID`，與憑證不符時回傳 403。前端登出清除本分頁憑證，不代表伺服器撤銷；舊憑證在期限內仍有效。變更簽章金鑰會使既有憑證失效。

### 限流與配額

| 項目 | 預設限制 | 環境參數 |
| --- | --- | --- |
| 帳號冷卻 | 每次獲准執行後至少 10 秒 | `CHAT_COOLDOWN_SECONDS` |
| 帳號並行 | 同時 1 筆 | 固定 |
| 全站並行 | 同時 2 筆 | `GLOBAL_CONCURRENCY` |
| 帳號每日配額 | 30 次 | `USER_DAILY_LIMIT` |
| 全站每日配額 | 100 次，十組帳號共同使用 | `GLOBAL_DAILY_LIMIT` |
| 登入失敗 | 每 IP 每 15 分鐘最多 10 次，封鎖後正確帳密也需等待 | `LOGIN_FAILURE_LIMIT`、`LOGIN_WINDOW_SECONDS` |

後端先驗證憑證、輸入及 userID，再原子性檢查冷卻／並行／配額並預扣一次 Agent 用量，之後才呼叫 Gemini。被拒絕的請求不扣額；獲准後的上游錯誤仍計入用量，不自動重送。一次 Agent 包含多個上游 API 呼叫，次數配額不等同金額或 token 上限。每天台北時間 00:00 重置每日計數，跨午夜仍保留冷卻與執行中租約。

記憶體模式僅供本機單一程序，重啟會歸零。production 強制要求 DynamoDB，透過同一項目的版本條件寫入，同時更新帳號／全站配額與租約，避免多 instance 超額。儲存故障時回傳 503，不退回記憶體放行。程序崩潰的租約最多保留 180 秒；失敗的配額不退還。此單項目方案適用本課堂規模，不作高流量用途。

前端送出後保留至少十秒倒數；請求完成後依用量 API 的剩餘冷卻更新。後端拒絕請求時提供實際等待時間；每日額度耗盡僅顯示午夜重置提示，不啟動數萬秒倒數。重新整理或多分頁也受到後端限制。

`GET /api/agent/usage` 需登入，不扣 Agent 配額、不呼叫 Gemini，回傳：

```json
{
  "userDailyLimit": 30,
  "userRemaining": 29,
  "globalDailyLimit": 100,
  "globalRemaining": 99,
  "resetAt": "2026-10-15T16:00:00.000Z",
  "cooldownSeconds": 8
}
```

對話成功 JSON 維持既有欄位，另以 `X-User-Remaining`、`X-Global-Remaining` 回應標頭提供預扣後剩餘次數。CORS 允許 `Authorization`，並公開 `Retry-After` 與上述兩個用量標頭給前端讀取。

---

## 3. 回應資料字典與來源擴充契約

### 3.1 現行成功回應

成功使用 HTTP 200，直接回傳決策物件，不包 success 或 data。頂層維持以下六個欄位；本次不新增由前端指定分類、分流或工單等級的參數。

| 欄位 | 型別 | 規則 |
| --- | --- | --- |
| `intent` | string | 本次問題意圖，僅限 IT_SUPPORT、HR_POLICY、HARDWARE_FACILITY、UNKNOWN |
| `retrieved_sources` | array of object | 相似度排序的最多三個段落，沒有文件時為空陣列；現行每筆僅含 doc_name、relevance |
| `confidence_score` | integer | 0～100；為模型評估，非經校準的正確率，也不是來源相似度 |
| `action_route` | string | 僅限 AUTO_REPLY、ESCALATE_TICKET |
| `reply_text` | string | 非空白回答或人工處理說明，前端以純文字呈現 |
| `ticket_payload` | object 或 null | 自動回答為 null；轉派時必須為完整工單物件 |

現行來源物件的最小格式如下。以下數值為格式示例，不代表固定檢索結果：

```json
{
  "doc_name": "VPN連線故障排查手冊.md",
  "relevance": 0.89
}
```

### 3.2 知識庫主資料與 API 欄位對應

MD 中每筆主資料提供十一個 key。整理者審核後才整合至 knowledgeBase.json；目前沒有 Markdown 匯入端點，也沒有自動載入此資料夾的機制。

| MD 主資料欄位 | 型別與約束 | 擴充後的 API 位置／用途 |
| --- | --- | --- |
| `id` | 非空白 string，全資料庫唯一，如 IT-001 | retrieved_sources[].id，識別段落與追蹤版本 |
| `category` | 固定 INTENTS 之一 | retrieved_sources[].category，來源段落的分類 |
| `doc_name` | 非空白 string；同文件多段可重複 | retrieved_sources[].doc_name，文件名稱 |
| `section_title` | 非空白 string | retrieved_sources[].section_title，引用段落標題 |
| `content` | 非空白 string，含適用條件、步驟、例外與人工處理條件 | 後端建立向量並提供 Gemini 的完整依據；來源卡片採 summary，不在此擴充回應預設傳送全文 |
| `summary` | 非空白 string，一至兩句且不增加正文沒有的規則 | retrieved_sources[].summary，來源卡片摘要 |
| `department` | 固定部門名稱，依第 3.4 節對應 | retrieved_sources[].department，來源流程權責部門 |
| `version` | 非空白 string，如 1.0 | retrieved_sources[].version，原樣顯示，不當數字計算 |
| `updated_at` | YYYY-MM-DD 的有效日期 | retrieved_sources[].updated_at，最後整理／核對日期，前端直接顯示日期字串 |
| `source_url` | HTTP／HTTPS 網址或 JSON null | retrieved_sources[].source_url，原始文件連結；無法提供或無權公開時為 null |
| `data_status` | OFFICIAL、PENDING_REVIEW、SIMULATED | retrieved_sources[].data_status，區分正式、待確認與模擬來源 |

擴充來源回應另加 `relevance`（number，0～1，由後端計算，顯示至四位小數），不屬於組員手填的主資料。主資料中的其餘十個欄位直接由選中的本地段落取得，不讓 Gemini 重新撰寫或捏造。全文 content 可供內部檢索與推理，但不因加入前端來源卡片而重複回傳。

`category` 是某個來源段落的主題；頂層 `intent` 是本次提問的分類，兩者不要求相等。例如一個問題可能同時檢索到不同類別的段落。來源 department 也不等於本次工單 department，前端需分別標示「來源部門」與「建議處理部門」。

### 3.3 擴充相容規則與前端呈現

| 欄位／狀態 | 顯示與處理方式 |
| --- | --- |
| doc_name、section_title | 文件名稱與段落標題分開呈現；同文件多段可同時出現，不以文件名去重 |
| id | 作為來源卡片識別碼；舊資料沒有 id 時，暫以該次結果順序識別，不回寫假編號 |
| summary | 顯示簡短摘要，不拿 reply_text 假冒文件摘要 |
| category、department | 顯示來源類別與權責部門，固定值對應第 3.4 節 |
| version、updated_at | 顯示版本及整理／核對日期；日期不代表企業已審核或規章生效日 |
| source_url | 非 null 且為有效 HTTP／HTTPS 才提供「查看原始文件」連結；開新分頁使用 noopener／noreferrer；null 時不顯示可點擊連結，不組出本機檔案路徑 |
| OFFICIAL | 顯示「正式資料」，僅代表資料已按交付規則確認來源，不代表 AI 回答保證正確 |
| PENDING_REVIEW | 顯示「待確認」，不得顯示為正式規章 |
| SIMULATED | 明顯標示「課堂模擬資料」，不作為真實企業政策或法律依據 |
| relevance | 顯示 0～1 的向量餘弦相似度與進度條，不標成回答信心 |

新主資料提交時十一個欄位均需提供，只有 source_url 可填 null。相容舊資料時，API 的 doc_name、relevance 仍必填；新增 metadata 欄位在遷移期間可省略。前端缺少摘要、版本等資訊時隱藏該列或顯示「待補資料」，不得猜測、將缺值填成 OFFICIAL，或用今天日期補上 updated_at。null 不作為其他字串欄位的替代值。

後端現階段沒有依 data_status 自動篩選來源，整合者仍須人工審核。資料篩選或核准流程若需自動化，另訂需求；本規格不宣稱已有該功能。擴充完成前，現有前端驗證器仍只檢查 doc_name、relevance，額外欄位不會自動產生來源卡片畫面。

### 3.4 固定分類與工單格式

| INTENTS／category | departments 對應 |
| --- | --- |
| `IT_SUPPORT` | `IT資訊服務台` |
| `HR_POLICY` | `HR人力資源部` |
| `HARDWARE_FACILITY` | `總務與硬體組` |
| `UNKNOWN` | `IT資訊服務台` |

ROUTES 只允許 AUTO_REPLY、ESCALATE_TICKET；LEVELS 只允許 P1_URGENT、P2_HIGH、P3_NORMAL，不增加其他值。

| 工單欄位 | 型別 | 規則 |
| --- | --- | --- |
| `ticket_id` | string | 後端生成 TK- 加 UUID，模型或提交者不決定正式編號 |
| `level` | string | P1_URGENT（緊急）、P2_HIGH（高優先）、P3_NORMAL（一般）；需依本次情境與依據判斷 |
| `department` | string | 目標契約限定為上表中本次 intent 對應部門，不代表已派送 |
| `action_required` | string | 非空白的建議處理事項，不承諾已執行 |

AUTO_REPLY 的 ticket_payload 欄位仍必須存在，值為 null，此時沒有工單內部欄位；ESCALATE_TICKET 必須提供上述四個欄位，不能將 level 或 department 設為 null。

實作差異：現有後端已驗證 intent、level、route 與非空白欄位，但一般工單的 department 仍可來自模型字串，尚未完整強制上表映射；明確危險字詞才強制 HARDWARE_FACILITY／總務與硬體組。後續實作必須補齊此映射驗證，不能僅修改文件就視為已完成。

---

## 4. 分流與知識庫驗證情境

### 4.1 執行時決策

後端先檢索最多三個段落，再將段落內容與本次問題交給 Gemini。回應經後端檢查後，confidence_score 至少 75 時使用 AUTO_REPLY，低於 75 時使用 ESCALATE_TICKET。無文件、模型要求轉派或明確危險字詞時採保守轉派，不能僅因來源相似度高就自動認定可回答。

有流程文件不代表 AI 可以執行該流程。例如：詢問「如何申請權限」可說明 SOP；要求「直接開通權限」則涉及人工核准，需產生工單資料。UNKNOWN 由 IT 初步受理，不作其他專業領域的通用解答。

前端自動回答顯示綠色標籤；需人工處理顯示警告標籤與工單四欄及 JSON。緊急情境提供既有安全提示：遠離危險、避免接觸、聯絡現場負責人，僅在安全且可行時斷電。所有工單均為資料展示，不宣稱已立案、派送、通知真人、核准或完成處理。

### 4.2 驗證資料不屬於聊天合約

MD 的驗證情境是離線測試資料，與十一個主資料欄位分開。只將 message 作為問題送入對話 API，測試工具另提供登入憑證與 userID；不得把 expected_* 放入知識庫正文或要求模型照預期答案回傳。

| 驗證情境欄位 | 與執行時回應的關係 |
| --- | --- |
| message | 對話請求的 message |
| expected_intent | 比對頂層 intent，固定四種選項 |
| expected_action_route | 比對頂層 action_route，固定兩種選項 |
| expected_level | AUTO_REPLY 為 null；轉派時比對 ticket_payload.level |
| expected_department | AUTO_REPLY 為 null；轉派時比對 ticket_payload.department |
| expected_reply_points | 檢查 reply_text 是否涵蓋重點，不要求逐字相等 |

relevance、confidence_score、ticket_id 不由組員手填。範例回應中的數值及 UUID 只用於說明格式，不是測試必須完全相同的答案。以下情境矩陣來自三部門 MD，須在資料整合及程式擴充後再實測：

| 主資料 ID | 情境摘要 | 預期 intent | 預期 route | 預期 level | 預期工單部門 |
| --- | --- | --- | --- | --- | --- |
| IT-001 | VPN 一般連線排查 | IT_SUPPORT | AUTO_REPLY | null | null |
| IT-002 | 專案共享資料夾無存取權限 | IT_SUPPORT | ESCALATE_TICKET | P2_HIGH | IT資訊服務台 |
| IT-003 | 缺少問題主題或必要資訊 | UNKNOWN | ESCALATE_TICKET | P3_NORMAL | IT資訊服務台 |
| HR-001 | 一般請假申請步驟 | HR_POLICY | AUTO_REPLY | null | null |
| HR-002 | 忘記打卡的補正申請 | HR_POLICY | ESCALATE_TICKET | P3_NORMAL | HR人力資源部 |
| HR-003 | 當期薪資明細疑似差異 | HR_POLICY | ESCALATE_TICKET | P2_HIGH | HR人力資源部 |
| FAC-001 | 投影機與會議設備借用流程 | HARDWARE_FACILITY | AUTO_REPLY | null | null |
| FAC-002 | 投影設備無法顯示且影響當日會議 | HARDWARE_FACILITY | ESCALATE_TICKET | P2_HIGH | 總務與硬體組 |
| FAC-003 | 設備冒煙或起火的初步受理 | HARDWARE_FACILITY | ESCALATE_TICKET | P1_URGENT | 總務與硬體組 |

---

## 5. 擴充後的前後端串接範例

以下範例使用 MD 主資料的實際 key 與內容；**尚未載入 knowledgeBase.json，新增來源 metadata 也尚未由 API 回傳**。每個來源物件的 metadata 由後端從本地文件取得，只有 relevance 是本次檢索計算的數值。

以下各次呼叫都需 `POST /api/agent/chat`、`Content-Type: application/json` 與 `Authorization: Bearer <token>`。為方便閱讀，來源陣列只示意一筆；實際回傳最多三筆，不能把範例當成固定數量、排名或分數。

### 5.1 一般排查自動回答

請求本文：

```json
{
  "message": "我已經有 VPN 權限，但今天連不上，先檢查什麼？",
  "userID": "user-admin1"
}
```

目標成功回應：

```json
{
  "intent": "IT_SUPPORT",
  "retrieved_sources": [
    {
      "id": "IT-001",
      "category": "IT_SUPPORT",
      "doc_name": "遠端連線操作手冊",
      "section_title": "VPN 一般連線排查",
      "summary": "VPN 無法連線時，依序確認網路、用戶端、憑證與帳號狀態。",
      "department": "IT資訊服務台",
      "version": "1.0",
      "updated_at": "2026-10-16",
      "source_url": null,
      "data_status": "SIMULATED",
      "relevance": 0.89
    }
  ],
  "confidence_score": 88,
  "action_route": "AUTO_REPLY",
  "reply_text": "請先確認一般網頁可正常開啟，再確認 VPN 用戶端與公司憑證是否有效，以及帳號是否顯示過期或鎖定。不要停用防火牆或略過憑證檢查；若仍無法連線，請提供錯誤代碼、時間及裝置類型供 IT 確認。",
  "ticket_payload": null
}
```

### 5.2 需人工核准的高優先工單

請求本文：

```json
{
  "message": "我們專案組今天都打不開共享資料夾，請直接幫我們開權限。",
  "userID": "user-admin1"
}
```

目標成功回應：

```json
{
  "intent": "IT_SUPPORT",
  "retrieved_sources": [
    {
      "id": "IT-002",
      "category": "IT_SUPPORT",
      "doc_name": "資訊權限申請辦法",
      "section_title": "專案共享資料夾無存取權限",
      "summary": "共享資料夾權限需資料擁有者與主管核准，再由 IT 人工設定。",
      "department": "IT資訊服務台",
      "version": "1.0",
      "updated_at": "2026-10-16",
      "source_url": null,
      "data_status": "SIMULATED",
      "relevance": 0.86
    }
  ],
  "confidence_score": 62,
  "action_route": "ESCALATE_TICKET",
  "reply_text": "權限變更需要資料擁有者及直屬主管確認，AI 無法直接開通。請提供資料夾名稱、工作用途與需要的存取範圍，不要提供密碼。已產生工單資料，可於右側查看。",
  "ticket_payload": {
    "ticket_id": "TK-123e4567-e89b-42d3-a456-426614174000",
    "level": "P2_HIGH",
    "department": "IT資訊服務台",
    "action_required": "人工核對多人共享資料夾存取問題及核准紀錄"
  }
}
```

### 5.3 緊急設備事件

請求本文：

```json
{
  "message": "辦公室螢幕冒煙了，我現在該怎麼辦？",
  "userID": "user-admin1"
}
```

目標成功回應：

```json
{
  "intent": "HARDWARE_FACILITY",
  "retrieved_sources": [
    {
      "id": "FAC-003",
      "category": "HARDWARE_FACILITY",
      "doc_name": "設備異常緊急通報流程",
      "section_title": "設備冒煙或起火的初步受理",
      "summary": "設備冒煙等危險情況應先遠離並聯絡現場負責人，產生 P1 緊急工單資料。",
      "department": "總務與硬體組",
      "version": "1.0",
      "updated_at": "2026-10-16",
      "source_url": null,
      "data_status": "SIMULATED",
      "relevance": 0.52
    }
  ],
  "confidence_score": 42,
  "action_route": "ESCALATE_TICKET",
  "reply_text": "請先遠離危險設備，避免接觸；僅在安全且可行時切斷電源，並立即聯絡現場負責人。已產生緊急報修工單資料，可於工單資料區查看。",
  "ticket_payload": {
    "ticket_id": "TK-123e4567-e89b-42d3-a456-426614174000",
    "level": "P1_URGENT",
    "department": "總務與硬體組",
    "action_required": "請現場負責人確認安全並安排設備檢測"
  }
}
```

---

## 6. Gemini 內部輸出與後續實作範圍

### 6.1 模型輸出與對外回應的邊界

推理模型由後端 GEMINI_MODEL 設定，不在 API 契約綁定舊模型名稱。呼叫時使用 responseMimeType 為 application/json 與 responseSchema，模型輸出 intent、confidence_score、action_route、reply_text 及 ticket_payload。

retrieved_sources 由後端檢索結果組成，不能由模型提供或覆寫。新增來源 metadata 不需要增加模型輸出的同名欄位。現有 schema 仍要求模型轉派時提供完整 ticket_payload（含 ticket_id），但最終對外 ticket_id 由後端重新生成 UUID；模型編號不得直接當正式編號。

### 6.2 擴充實作清單

| 檔案／範圍 | 後續需要的調整 | 現況 |
| --- | --- | --- |
| knowledgeBase.json | 人工審核 MD 主資料後整合十一欄，驗證唯一 ID、日期、資料狀態及分類／部門映射 | 仍為三筆舊展示資料；MD 九筆未匯入 |
| knowledgeService.js | 保留段落 metadata；檢索依 doc_name、content 建向量，維持排序與 Top-3，不用 expected_* 作為依據 | 已會保留輸入物件欄位，但未驗證新增欄位 |
| geminiAgent.js | 將本地來源 metadata 明確映射到 retrieved_sources，維持 relevance 來自後端；補齊一般工單部門映射驗證 | 現行回應來源只映射 doc_name、relevance |
| frontend/src/services/agentService.js | 驗證擴充欄位型別／選項及 source_url，保留舊來源格式相容性 | 尚未驗證新增 metadata |
| frontend/src/components/DecisionPanel.js | 顯示第 3.3 節的來源卡片資訊，維持純文字、安全連結及缺值處理 | 來源卡片僅顯示文件名與相似度 |
| 測試 | 驗證 metadata 不由模型捏造、空來源／舊來源相容、九筆驗證情境及固定選項 | 需隨上述實作新增相應測試 |

本次不新增文件上傳、知識庫管理、來源全文查詢或工單派送端點。資料擴充不改變登入、userID、每日配額及冷卻規則。

---

## 7. 錯誤處理與 HTTP 狀態碼規範

為確保前端 GitHub Pages 在面對網路異常或後端故障時能維持良好之 UI/UX 狀態（如取消按鈕鎖定、顯示友善錯誤提示），後端必須遵守以下標準 HTTP 狀態碼回應原則。

### 錯誤回應 JSON 格式

所有非 200 狀態碼之錯誤回應，統一採用包含 `error` 物件之 JSON 格式：

```json
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "message": "請求主體缺失 message 欄位或內容為空白。"
  }
}
```

### HTTP 狀態碼對照表

| HTTP 狀態碼 | 錯誤代碼 (Error Code) | 觸發時機與說明 (Trigger Scenario) | 前端處置建議 (Frontend Action) |
| --- | --- | --- | --- |
| `200 OK` | N/A | 請求處理成功，順利回傳 Agent 對話與決策資料 | 正常解構 JSON 並更新對話與戰情室 UI |
| `400 Bad Request` | `INVALID_PAYLOAD` | 請求格式非合法 JSON 或 `message` 欄位空白 | 彈出警告訊息提醒使用者輸入有效文字 |
| `401 Unauthorized` | `UNAUTHORIZED`、`USER_NOT_FOUND`、`INVALID_CREDENTIALS` | 憑證無效或登入失敗 | 提示錯誤；對話憑證失效時回登入頁 |
| `403 Forbidden` | `USER_ID_MISMATCH` | 本文 userID 與憑證不符 | 不送往 Gemini |
| `429 Too Many Requests` | `RATE_LIMIT_EXCEEDED`、`REQUEST_IN_PROGRESS`、`LOGIN_RATE_LIMITED` | 冷卻、處理中、登入失敗過多或 Gemini 限流 | 依 `retry_after` 與 `Retry-After` 等待 |
| `429 Too Many Requests` | `DAILY_QUOTA_EXCEEDED`、`GLOBAL_QUOTA_EXCEEDED` | 帳號或全站今日額度耗盡 | 顯示台北午夜重置提示 |
| `503 Service Unavailable` | `SERVICE_BUSY`、`LIMIT_STORE_UNAVAILABLE` | 全站並行滿載或限制儲存無法使用 | 稍後重試，不自動重送 |
| `500 Internal Error` | `SERVER_ERROR` | 後端向量計算失敗或 Gemini API 服務異常 | 顯示系統維護提示，並解除前端傳送按鈕鎖定 |


有限制等待時間的錯誤會在 `error` 增加 `retry_after`（整數秒），並回傳相同的 `Retry-After` 標頭；Gemini 上游 429 未提供本地等待值時使用十秒。
