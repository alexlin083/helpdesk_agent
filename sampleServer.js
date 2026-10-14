// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { runHelpdeskAgent } from './geminiAgent.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // 允許 GitHub Pages 跨域呼叫
app.use(express.json());

// 模擬本地知識庫段落（展示用，實際可讀取 JSON 檔或向量資料庫）
const mockKnowledgeBase = [
  {
    title: "VPN連線故障排查手冊.md",
    content: "若 AnyConnect VPN 無法連線，請確認：1. 是否已安裝最新版憑證。2. 確認網路未阻擋 443 Port。3. 帳號密碼是否過期，若過期請至帳號中心重新同步。"
  },
  {
    title: "人事請假與特休規範.md",
    content: "滿半年特休 3 天，滿一年特休 7 天。請假需提前 3 天於差勤系統送出申請，並由直屬主管核准。"
  },
  {
    title: "總務資產報修流程.md",
    content: "實體硬體損壞需填寫紙本報修單。若遇冒煙、電線裸露等緊急危害，應第一時間切斷電源並通報總務緊急電話。"
  }
];

// API 端點：對應規格書的 POST /api/agent/chat
app.post('/api/agent/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    console.log(`[Request 收到] 使用者提問: ${message}`);

    // 簡化的關聯檢索（Demo 時直接傳入相關規章片段）
    const agentDecision = await runHelpdeskAgent(message, mockKnowledgeBase);

    console.log(`[Agent 決策] 路由: ${agentDecision.action_route}, 信心分: ${agentDecision.confidence_score}`);
    return res.json(agentDecision);
  } catch (error) {
    return res.status(500).json({ 
      error: "內部伺服器錯誤", 
      details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Helpdesk Agent API 已在 http://localhost:${PORT} 啟動！`);
});