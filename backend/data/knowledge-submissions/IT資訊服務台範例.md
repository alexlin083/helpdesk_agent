# IT資訊服務台三筆範例

以下皆為課堂模擬資料，供組員參考填寫方式，未載入實際知識庫。驗證情境與主資料分開。

## IT-001 VPN 一般連線排查

```json
{
  "id": "IT-001",
  "category": "IT_SUPPORT",
  "doc_name": "遠端連線操作手冊",
  "section_title": "VPN 一般連線排查",
  "content": "課堂模擬 SOP。適用條件：已取得遠端連線權限的員工，VPN 無法連線且沒有資安警示。處理步驟：先確認一般網頁能正常開啟，再確認 VPN 用戶端及公司提供的憑證仍有效，接著確認帳號是否顯示密碼過期或鎖定。密碼過期時使用公司核准的帳號中心流程，不將密碼提供給他人。例外限制：不得自行停用防火牆、略過憑證檢查或安裝來源不明的設定。人工處理條件：完成上述檢查仍無法連線時，向 IT資訊服務台提供錯誤代碼、發生時間與裝置類型，由人工確認。",
  "summary": "VPN 無法連線時，依序確認網路、用戶端、憑證與帳號狀態。",
  "department": "IT資訊服務台",
  "version": "1.0",
  "updated_at": "2026-10-16",
  "source_url": null,
  "data_status": "SIMULATED"
}
```

```json
{
  "message": "我已經有 VPN 權限，但今天連不上，先檢查什麼？",
  "expected_intent": "IT_SUPPORT",
  "expected_action_route": "AUTO_REPLY",
  "expected_level": null,
  "expected_department": null,
  "expected_reply_points": ["確認一般網路連線", "確認用戶端與憑證狀態", "確認帳號是否過期或鎖定", "不得略過安全檢查"]
}
```

來源與審核：本組自訂模擬流程，未經企業審核。範例只測試「先如何排查」，不表示所有 VPN 故障都可自動解決。

## IT-002 專案共享資料夾權限申請

```json
{
  "id": "IT-002",
  "category": "IT_SUPPORT",
  "doc_name": "資訊權限申請辦法",
  "section_title": "專案共享資料夾無存取權限",
  "content": "課堂模擬政策。適用條件：員工因專案工作需新增共享資料夾權限。申請資料：提供資料夾名稱、工作用途及申請的存取範圍，不提供密碼或完整機密檔案。處理流程：由資料擁有者及直屬主管確認業務需要，IT資訊服務台核對核准紀錄後設定權限。例外限制：AI 不得承諾已開通，不得建議借用同事帳號。人工處理條件：權限變更一律需人工核准；若已影響當日多人共同作業，依本模擬政策以 P2 高優先工單確認。",
  "summary": "共享資料夾權限需資料擁有者與主管核准，再由 IT 人工設定。",
  "department": "IT資訊服務台",
  "version": "1.0",
  "updated_at": "2026-10-16",
  "source_url": null,
  "data_status": "SIMULATED"
}
```

```json
{
  "message": "我們專案組今天都打不開共享資料夾，請直接幫我們開權限。",
  "expected_intent": "IT_SUPPORT",
  "expected_action_route": "ESCALATE_TICKET",
  "expected_level": "P2_HIGH",
  "expected_department": "IT資訊服務台",
  "expected_reply_points": ["說明需要人工核准", "蒐集資料夾名稱與業務用途", "不得宣稱已開通權限", "產生建議工單資料"]
}
```

來源與審核：本組自訂模擬政策。P2 依據為當日多人作業受阻，並非所有權限申請一律 P2。

## IT-003 無法辨識問題的初步受理

```json
{
  "id": "IT-003",
  "category": "UNKNOWN",
  "doc_name": "服務台初步受理規範",
  "section_title": "缺少問題主題或必要資訊",
  "content": "課堂模擬受理規範。適用條件：提問沒有說明系統、設備或流程，無法確認所屬主題。受理時需請使用者補充遇到的事情、出現的訊息、發生時間及影響範圍，提醒不要提供密碼或敏感個資。例外限制：不得自行猜測故障原因、核准事項或負責部門。人工處理條件：仍無法分類的案件由 IT資訊服務台初步確認，使用 UNKNOWN 分類及 P3 一般工單；本規範不是其他未知專業問題的知識答案。",
  "summary": "問題資訊不足時先請使用者補充，再由 IT 服務台初步受理。",
  "department": "IT資訊服務台",
  "version": "1.0",
  "updated_at": "2026-10-16",
  "source_url": null,
  "data_status": "SIMULATED"
}
```

```json
{
  "message": "那個又不能用了，幫我處理一下。",
  "expected_intent": "UNKNOWN",
  "expected_action_route": "ESCALATE_TICKET",
  "expected_level": "P3_NORMAL",
  "expected_department": "IT資訊服務台",
  "expected_reply_points": ["請補充系統或設備名稱", "請補充錯誤訊息與影響範圍", "不得自行猜測原因", "由 IT 初步確認"]
}
```

來源與審核：本組自訂模擬受理流程。此筆用來覆蓋 UNKNOWN 的部門映射；正式蒐集時優先補充有明確主題的知識。
