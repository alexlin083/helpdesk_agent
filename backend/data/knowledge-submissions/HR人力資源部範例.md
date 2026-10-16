# HR人力資源部三筆範例

以下皆為課堂模擬資料，不代表法定權益或正式企業人事政策，未載入實際知識庫。

## HR-001 一般請假申請流程

```json
{
  "id": "HR-001",
  "category": "HR_POLICY",
  "doc_name": "員工差勤作業手冊",
  "section_title": "一般請假申請步驟",
  "content": "課堂模擬流程。適用條件：員工詢問如何送出一般請假申請，不涉及特殊核准或假別資格爭議。處理步驟：登入公司核准的差勤系統，確認可用假別與餘額，填寫日期、時段與必要說明，送交直屬主管審核，再於申請紀錄確認狀態。例外限制：送出申請不代表已核准；可用天數、證明文件及特殊情況須依正式適用規章確認，本段不提供法定假別或天數判斷。人工處理條件：餘額異常、假別資格不明或特殊核准需求由 HR人力資源部確認。",
  "summary": "一般請假需在差勤系統確認假別與餘額、填寫資料並送主管審核。",
  "department": "HR人力資源部",
  "version": "1.0",
  "updated_at": "2026-10-16",
  "source_url": null,
  "data_status": "SIMULATED"
}
```

```json
{
  "message": "我想請假，要在哪裡送出申請？流程是什麼？",
  "expected_intent": "HR_POLICY",
  "expected_action_route": "AUTO_REPLY",
  "expected_level": null,
  "expected_department": null,
  "expected_reply_points": ["使用公司核准的差勤系統", "確認假別與餘額", "填寫日期與時段並送主管審核", "送出不等於核准"]
}
```

來源與審核：本組自訂模擬流程。此筆只回答操作步驟，不自行推定員工可休天數或法定權利。

## HR-002 忘記打卡的紀錄補正

```json
{
  "id": "HR-002",
  "category": "HR_POLICY",
  "doc_name": "員工差勤作業手冊",
  "section_title": "忘記打卡的補正申請",
  "content": "課堂模擬政策。適用條件：員工已實際出勤但忘記打卡，需補正出勤紀錄。處理步驟：由本人在差勤系統提出補正，填寫日期、實際上下班時間與原因，送交主管確認，再由 HR人力資源部依核准資料處理。例外限制：不得代替他人申請、虛構出勤時間或由 AI 直接修改紀錄。人工處理條件：補正必須有主管確認，由 HR 人工核對；未涉及當日薪資結算或多人系統異常者，依模擬政策列為 P3 一般工單。",
  "summary": "忘記打卡需本人提出補正，由主管與 HR 人工核對出勤紀錄。",
  "department": "HR人力資源部",
  "version": "1.0",
  "updated_at": "2026-10-16",
  "source_url": null,
  "data_status": "SIMULATED"
}
```

```json
{
  "message": "我昨天有來上班但忘記打卡，你可以直接幫我補上紀錄嗎？",
  "expected_intent": "HR_POLICY",
  "expected_action_route": "ESCALATE_TICKET",
  "expected_level": "P3_NORMAL",
  "expected_department": "HR人力資源部",
  "expected_reply_points": ["AI 不直接修改紀錄", "由本人提出補正申請", "需要主管確認與 HR 核對", "產生一般工單資料"]
}
```

來源與審核：本組自訂模擬政策。P3 依據為一般紀錄補正，不是任何差勤異常都同一等級。

## HR-003 當期薪資明細差異確認

```json
{
  "id": "HR-003",
  "category": "HR_POLICY",
  "doc_name": "薪資問題受理流程",
  "section_title": "當期薪資明細疑似差異",
  "content": "課堂模擬受理流程。適用條件：員工認為當期薪資明細的項目或金額與已核准紀錄不同。處理步驟：先由本人透過企業核准的人事窗口提出薪資期別與有疑問的項目；詳細明細只能透過企業允許的安全管道提供。例外限制：不要在 AI 聊天中輸入完整薪資單、銀行帳號、身分證字號或其他敏感資料；AI 不推算個人薪資、不判定實際應付金額。人工處理條件：涉及當期薪資發放且需查核個人紀錄時，依模擬政策列為 P2，由 HR人力資源部人工核對，不承諾調整金額或完成期限。",
  "summary": "當期薪資疑似差異需透過安全的人事管道，由 HR 人工核對。",
  "department": "HR人力資源部",
  "version": "1.0",
  "updated_at": "2026-10-16",
  "source_url": null,
  "data_status": "SIMULATED"
}
```

```json
{
  "message": "這期薪資明細和已核准的紀錄不一致，請幫我查清楚。",
  "expected_intent": "HR_POLICY",
  "expected_action_route": "ESCALATE_TICKET",
  "expected_level": "P2_HIGH",
  "expected_department": "HR人力資源部",
  "expected_reply_points": ["需要 HR 核對個人紀錄", "不要在聊天中提交敏感個資", "改用企業核准的安全管道", "不承諾調整金額或完成期限"]
}
```

來源與審核：本組自訂模擬流程，非薪資或勞動法規說明。P2 依據為當期發放事項需人工優先核對。
