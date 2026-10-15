// 本機後端預設位址。部署時改為實際的 HTTPS 後端 origin，不含 /api。
// 這是公開設定；不可在前端放入 Gemini API 金鑰。原生 ES Modules 不會讀取 .env。
export const API_BASE_URL = 'http://localhost:3000';
