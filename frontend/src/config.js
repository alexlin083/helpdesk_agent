/**
 * 從設定模組的部署位置推導 API 基底網址，讓前端置於 /helpdesk/ 等子路徑時保留該前綴。
 * service 會再附加 /api；不依目前頁面深度推導，避免管理頁與追蹤頁產生不同的 API 網址。
 * 保留 localhost:5173 的 Python 開發方式及沒有 location 的 Node 測試，兩者使用 localhost:3000。
 * 本設定只有公開網址，不包含密碼或 Gemini 金鑰，也不讀取 .env。
 * @param {object} [options={}] 可注入的瀏覽器及模組位置，供部署情境測試使用。
 * @param {Location|URL} [options.location=globalThis.location] 目前瀏覽器位置；無瀏覽器環境時使用本機後端。
 * @param {string|URL} [options.moduleUrl=import.meta.url] 本設定模組的完整網址，其上一層為前端專案根目錄。
 * @returns {string} 不含尾斜線及 /api 的 API 基底網址。
 * @throws {TypeError} 傳入的模組網址無法解析時拋出。
 */
export function resolveApiBaseUrl({ location = globalThis.location, moduleUrl = import.meta.url } = {}) {
  if (!location || (location.hostname === 'localhost' && location.port === '5173')) return 'http://localhost:3000';
  return new URL('../', moduleUrl).href.replace(/\/$/, '');
}

export const API_BASE_URL = resolveApiBaseUrl();
