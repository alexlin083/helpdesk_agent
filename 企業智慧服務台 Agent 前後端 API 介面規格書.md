---
title: 企業智慧服務台 Agent 前後端 API 介面規格書
tags: [中原資管碩, 人工智慧與流程自動化實務研討]

---

# 企業智慧服務台 Agent 前後端 API 介面規格書

本規格書為成員 A（後端與架構主導）與成員 B（前端與 UI/UX 設計）之間的標準介面合約（API Contract），旨在規範 GitHub Pages 前端網頁與部署於 AWS Elastic Beanstalk 之 Node.js Express 後端 API 服務間的通訊協定、JSON 資料綱要、動態決策路由邏輯與錯誤處理機制。

---

## 1. 系統概觀與傳輸規範

前後端通訊採用標準 RESTful API 架構，傳輸層全面實施 HTTPS 加密。為配合前端託管於 GitHub Pages 且後端部署於 AWS Elastic Beanstalk 之跨網域環境，後端必須妥善設定跨來源資源共享（CORS）標頭。

通訊基礎設定規格如下：

* **基礎 API 網址 (Base URL)**：`https://<aws-beanstalk-domain>.elasticbeanstalk.com`
* **資料傳輸格式 (Content-Type)**：`application/json; charset=utf-8`
* **跨網域存取控制 (CORS)**：後端必須允許來源網域 `https://<github-username>.github.io`，並開放 `POST` 與 `OPTIONS` 請求方法。
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

### 請求主體 (Request Body)

請求主體包含使用者輸入之查詢字串。前端於發送請求前應進行基礎去空白處理。

| 欄位名稱 (Field) | 資料型別 (Type) | 必填 (Required) | 說明與限制 (Description & Constraints) |
| --- | --- | --- | --- |
| `message` | `string` | 是 | 使用者輸入之提問文字，長度介於 1 至 500 字元之間 |

---

## 3. 回應資料字典與結構說明

後端於完成 RAG 檢索與 LLM 信心度評估後，統一回傳 HTTP 200 OK 狀態碼與 JSON 回應物件。回應結構劃分為四大核心區塊：意圖識別、檢索引據、信心與路由、以及工單轉派實體。

### 回應主體欄位定義

下表詳細定義回應 JSON 物件中各欄位的型別、可能值與用途說明：

| 欄位名稱 (Field) | 資料型別 (Type) | 可能值 / 範例 | 說明 (Description) |
| --- | --- | --- | --- |
| `intent` | `string` | `IT_SUPPORT`, `HR_POLICY`, `HARDWARE_FACILITY`, `UNKNOWN` | 經由 LLM 識別之問題意圖分類標籤 |
| `retrieved_sources` | `array[object]` | 檢索文檔陣列 | 本地向量知識庫中相似度最高之 Top-3 規章段落卡片資訊 |
| `retrieved_sources[].doc_name` | `string` | `VPN連線故障排查手冊.md` | 引據之內部規章或 SOP 文件名稱 |
| `retrieved_sources[].relevance` | `number` | `0.52` ~ `0.95` | 向量 Cosine Similarity 相似度分數（介於 0.00 至 1.00 之間） |
| `confidence_score` | `number` | `0` ~ `100` | LLM 自主評估之解答信心分數，為整數型態 |
| `action_route` | `string` | `AUTO_REPLY`, `ESCALATE_TICKET` | 系統決策分流代碼 |
| `reply_text` | `string` | 對話文字 | 直接呈現於左側對話框之 Agent 對話解答或指引文字 |
| `ticket_payload` | `object` \| `null` | 工單物件或 `null` | 當 `action_route` 為 `ESCALATE_TICKET` 時產出之結構化工單；自動秒回時為 `null` |

### 結構化工單物件 (Ticket Payload Schema)

當信心分數不足或判定為需要人工處置之疑難與緊急案件時，`ticket_payload` 欄位將包含以下細部屬性：

| 工單屬性 (Attribute) | 資料型別 (Type) | 說明 (Description) |
| --- | --- | --- |
| `ticket_id` | `string` | 系統自動生成之唯一工單編號（格式如 `TK-98214` 或 `TICK-YYYYMM-XXXX`） |
| `level` | `string` | 工單緊急程度（如 `P1_URGENT`, `P2_HIGH`, `P3_NORMAL`） |
| `department` | `string` | 自動指派處置之權責部門（如 `總務與硬體組`, `IT資訊服務台`, `HR人力資源部`） |
| `action_required` | `string` | 建議派工執行動作或現場處理摘述 |

---

## 4. 動態決策分流與信心度評估機制

後端 Agent 決策管線的核心邏輯在於「知道自己是否具備足夠資訊回答問題」。後端整合 RAG 檢索到的文檔切片與 LLM 推理結果，計算出綜合信心分數（`confidence_score`），並依據設定之門檻進行雙軌自動化分流：

```
[使用者提問] ➔ [Cosine Similarity 檢索 Top-3] ➔ [Gemini LLM 評估] ➔ confidence_score
                                                                     │
                         ┌───────────────────────────────────────────┴───────────────────────────────────────────┐
                         ▼                                                                                       ▼
         confidence_score >= 75                                                                  confidence_score < 75
    【自動秒回 AUTO_REPLY】                                                                 【轉派工單 ESCALATE_TICKET】
 - 直接輸出高信心知識庫解答                                                               - 回傳急救說明並建置結構化工單
 - ticket_payload 設為 null                                                              - 產出包含 level/department 之 ticket_payload
```

分流門檻與處置規則詳細說明：

* **高信心度常規解答 (`confidence_score >= 75`)**：
  * **決策標籤**：`AUTO_REPLY`（自動秒回）
  * **前端渲染**：右側戰情室 Step 3 顯示綠色成功標籤，左側對話框輸出平滑打字機完整解答。`ticket_payload` 欄位為 `null`。
* **低信心度/疑難工單轉派 (`confidence_score < 75`)**：
  * **決策標籤**：`ESCALATE_TICKET`（轉派工單）
  * **前端渲染**：右側戰情室 Step 3 顯示紅色/黃色警告標籤，並於右側面板下方展開 `ticket_payload` 之 JSON 結構預覽卡片，左側對話框顯示緊急應變提示與已自動立案通知。

---

## 5. 前後端溝通情境範例 JSON

為使成員 A 與成員 B 能進行獨立模組測試與 Mock Data 開發，以下提供兩種典型業務情境之 Request/Response JSON 範例。

### 情境一：高信心度常規查詢 (AUTO_REPLY)

使用者詢問 VPN 設定排查，知識庫包含完整標準 SOP，系統觸發自動秒回。

#### 請求 JSON (Request)
```json
{
  "message": "VPN 連不上如何排查？"
}
```

#### 回應 JSON (Response HTTP 200)
```json
{
  "intent": "IT_SUPPORT",
  "retrieved_sources": [
    {
      "doc_name": "VPN連線故障排查手冊.md",
      "relevance": 0.89
    },
    {
      "doc_name": "企業遠端工作資安規範.md",
      "relevance": 0.74
    }
  ],
  "confidence_score": 88,
  "action_route": "AUTO_REPLY",
  "reply_text": "請先檢查 Cisco AnyConnect 用戶端是否已更新至最新版本。排查步驟如下：1. 確認網路連線正常；2. 檢查雙重驗證 (2FA) 認證碼；3. 切換至備用 VPN 伺服器通道。",
  "ticket_payload": null
}
```

---

### 情境二：低信心度與緊急報修 (ESCALATE_TICKET)

使用者回報辦公室設備冒煙異常，屬於高風險硬體事件，知識庫無直接維修說明，系統觸發自動開立 P1 工單並指派總務組。

#### 請求 JSON (Request)
```json
{
  "message": "辦公室螢幕狂閃冒煙了！"
}
```

#### 回應 JSON (Response HTTP 200)
```json
{
  "intent": "HARDWARE_FACILITY",
  "retrieved_sources": [
    {
      "doc_name": "總務資產報修流程.md",
      "relevance": 0.52
    }
  ],
  "confidence_score": 42,
  "action_route": "ESCALATE_TICKET",
  "reply_text": "偵測到硬體嚴重異常狀況，請先拔除電源以確保安全！系統已自動為您開立緊急硬體報修工單並指派總務組處理。",
  "ticket_payload": {
    "ticket_id": "TK-98214",
    "level": "P1_URGENT",
    "department": "總務與硬體組",
    "action_required": "現場硬體檢測與更換"
  }
}
```

---

## 6. Gemini LLM 內部 JSON Structured Output 規範

為確保 Node.js 後端呼叫 Google Gemini API（`gemini-1.5-flash` 或 `gemini-2.0-flash`）時能穩定解析模型輸出，後端必須於 API 呼叫設定中啟用 `responseMimeType: "application/json"`，並於 System Instruction 帶入以下約束綱要。

### 後端送至 Gemini API 之 System Instruction 範本

```text
You are an Enterprise Helpdesk AI Agent. Analyze the user query alongside the provided Top-3 retrieved knowledge base contexts.
You must output ONLY a valid JSON object matching the schema below without any markdown formatting wrappers or conversational introductory text.

Schema constraint:
{
  "intent": "IT_SUPPORT" | "HR_POLICY" | "HARDWARE_FACILITY" | "UNKNOWN",
  "confidence_score": integer (0 to 100),
  "action_route": "AUTO_REPLY" | "ESCALATE_TICKET",
  "reply_text": "string (the answer to display to user)",
  "ticket_payload": object or null (must contain ticket_id, level, department, action_required if action_route is ESCALATE_TICKET)
}

Rule: If information in retrieved context is insufficient or query indicates emergency hardware/personnel issues, set confidence_score < 75 and action_route to ESCALATE_TICKET.
```

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
| `429 Too Many Requests` | `RATE_LIMIT_EXCEEDED` | Gemini API 免費層或後端流量超出限制 | 提示使用者「系統繁忙中，請稍後 10 秒再試」 |
| `500 Internal Error` | `SERVER_ERROR` | 後端向量計算失敗或 Gemini API 服務異常 | 顯示系統維護提示，並解除前端傳送按鈕鎖定 |



###### tags: `中原資管碩` `人工智慧與流程自動化實務研討` 