// 後端測試共用的環境參數：本機模式、測試專用的假密碼、不帶 AI 金鑰、單程序記憶體限流、記憶體資料庫、不輸出日誌；
// 明確設定空值，讓 backend/.env 的實際金鑰與資料庫路徑不會滲進測試（env.js 以 override: false 讀取 .env，已存在的值優先）
export const TEST_ENV = Object.freeze({
  NODE_ENV: 'local',
  ADMIN_PASSWORD: 'test-admin-only-password',
  DEMO_PASSWORD: 'test-only-password',
  GEMINI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  LIMIT_STORE: 'memory',
  LOG_LEVEL: 'silent',
  DATABASE_FILE: ':memory:',
});

/**
 * 寫入測試共用的環境參數，再套用這個測試檔自己要改的值；必須在動態匯入 src 模組之前呼叫，
 * 因為 src/config/env.js 在被匯入時就讀取環境參數並建立設定
 * @param {Record<string, string>} [overrides={}] 這個測試檔要覆寫或新增的參數，例如暫存資料庫路徑或限流次數
 * @returns {void}
 * 副作用：直接修改 process.env，影響同一個測試程序內之後匯入的所有模組
 */
export function setupTestEnv(overrides = {}) {
  Object.assign(process.env, TEST_ENV, overrides);
}
