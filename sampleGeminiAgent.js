// geminiAgent.js
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

// 初始化 SDK，自動從 process.env.GEMINI_API_KEY 讀取金鑰
const ai = new GoogleGenAI();

/**
 * 定義回傳的 JSON Schema
 * 嚴格對應專案規格書的定義
 */
const agentResponseSchema = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      description: "問題意圖分類，例如: IT_SUPPORT, HR_POLICY, FACILITY_REPORT, UNKNOWN",
    },
    retrieved_sources: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          doc_name: { type: Type.STRING },
          relevance: { type: Type.NUMBER, description: "相關度分數 0 ~ 1" },
        },
        required: ["doc_name", "relevance"],
      },
    },
    confidence_score: {
      type: Type.INTEGER,
      description: "回答信心指數 (0 ~ 100)。若相關規章充足且明確則 >= 75，若缺乏依據或為硬體重大故障則 < 75",
    },
    action_route: {
      type: Type.STRING,
      description: "決策路徑，僅能為 'AUTO_REPLY' 或 'ESCALATE_TICKET'",
    },
    reply_text: {
      type: Type.STRING,
      description: "向使用者展示的回覆內容。若為派工單，請向使用者告知處理進度並安撫",
    },
    ticket_payload: {
      type: Type.OBJECT,
      description: "若 action_route 為 ESCALATE_TICKET 時必填，否則回傳 null",
      properties: {
        ticket_id: { type: Type.STRING },
        priority: { type: Type.STRING, description: "P1_URGENT, P2_HIGH, P3_NORMAL" },
        category: { type: Type.STRING },
        assigned_to: { type: Type.STRING },
        summary: { type: Type.STRING },
      },
    },
  },
  required: ["intent", "retrieved_sources", "confidence_score", "action_route", "reply_text"],
};

/**
 * 呼叫 Gemini Agent 核心推理函式
 * @param {string} userMessage 使用者提問
 * @param {Array} retrievedDocs 向量比對檢索到的前幾筆參考規章
 */
export async function runHelpdeskAgent(userMessage, retrievedDocs = []) {
  // 組合檢索到的知識庫 Context
  const contextString = retrievedDocs.length > 0
    ? retrievedDocs.map((doc, idx) => `[文件 ${idx + 1}: ${doc.title}]\n${doc.content}`).join("\n\n")
    : "（目前無直接關聯之規章文件）";

  const prompt = `
使用者最新提問：
"${userMessage}"

系統檢索到的參考規章文件（RAG Context）：
${contextString}

請根據系統指導方針與上述參考資訊，進行分析並回傳標準 JSON 物件。
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // 使用最新、速度極快且有免費額度的 Flash 模型
      contents: prompt,
      config: {
        // 設定系統角色與決策原則
        systemInstruction: `你是一個企業內部的「智慧服務台 Agent (Smart Helpdesk Agent)」。
你的職責是解讀同仁提問，比對參考規章：
1. 若參考文件中包含確切解答（如 VPN 設定、請假流程），且問題不涉及重大設備破壞：
   - action_route 設為 "AUTO_REPLY"
   - confidence_score 設為 75 ~ 95
   - reply_text 給出親切、明確的排查步驟或規章解答。
2. 若問題涉及硬體實體毀損（如螢幕冒煙、電線起火）、規章缺乏依據或需主管額外核准：
   - action_route 設為 "ESCALATE_TICKET"
   - confidence_score 設為 30 ~ 65
   - 必須填寫完整的 ticket_payload（指派適當部門，例如：總務與硬體組、資訊安全課），並提醒使用者注意當下安全。`,
        responseMimeType: "application/json",
        responseSchema: agentResponseSchema,
        temperature: 0.2, // 保持邏輯嚴謹與決策穩定
      },
    });

    // 解析 LLM 回傳的結構化 JSON
    const resultJson = JSON.parse(response.text);
    return resultJson;
  } catch (error) {
    console.error("Gemini API 調用失敗:", error);
    throw error;
  }
}