import { readFileSync } from 'node:fs';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';

// 連接器設定檔的位置：和這支程式放在同一個資料夾（backend/src/services/connectors），提交 Git；只列出支援與規劃中的外部服務，不含任何金鑰
// 不放 backend/data：後端 Dockerfile 只複製 data 底下列出的檔，放在 src 底下才會由既有的 COPY src ./src 帶進映像，Dockerfile 不用改
const DEFAULT_FILE = new URL('./connectors.json', import.meta.url);
const STATUSES = new Set(['available', 'planned']);
const ID_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * 讀取並驗證連接器設定檔，回傳查詢介面；設定錯誤時拋出帶鍵路徑的錯誤（正式服務經 createLazyRegistry 使用，失敗時只停用連接功能）
 * 可用（available）的連接器必須有 provider、至少一個權限等級，每個等級要有 id、名稱、scopes 與開放的工具；規劃中（planned）的只需要名稱與說明
 * 提供者相關的畫面文字也放這裡，前端只讀資料：connect_hint（按連接前的提示，例如未驗證應用程式的警告）、account_page（到哪裡收回授權），都是選填字串
 * @param {object} [options={}] 選項
 * @param {URL|string} [options.file] 設定檔位置，測試可以換成暫存檔
 * @param {object} [options.raw] 直接提供設定內容（測試用），有提供時不讀檔
 * @returns {{list: () => object[], find: (id: string) => object|null, level: (connector: object, levelId: string) => object|null}} 連接器查詢
 * @throws {Error} code CONNECTORS_INVALID：設定格式錯誤，訊息含鍵路徑
 */
export function createConnectorRegistry({ file = DEFAULT_FILE, raw } = {}) {
  const data = raw ?? JSON.parse(readFileSync(file, 'utf8'));
  /**
   * 拋出設定錯誤
   * @param {string} path 鍵路徑
   * @param {string} message 說明
   * @returns {never} 一律拋出
   * @throws {Error} code CONNECTORS_INVALID
   */
  function fail(path, message) { throw Object.assign(new Error(`connectors.json ${path}：${message}`), { code: 'CONNECTORS_INVALID' }); }
  if (!data || !Array.isArray(data.connectors)) fail('connectors', '必須是陣列');
  const seen = new Set();
  const connectors = data.connectors.map(/** 驗證並凍結一個連接器 @param {object} item 設定 @param {number} index 位置 @returns {object} 連接器 */ (item, index) => {
    const at = `connectors[${index}]`;
    if (typeof item?.id !== 'string' || !ID_PATTERN.test(item.id)) fail(`${at}.id`, '必須是小寫英數與底線');
    if (seen.has(item.id)) fail(`${at}.id`, `重複的 id ${item.id}`);
    seen.add(item.id);
    if (!STATUSES.has(item.status)) fail(`${at}.status`, '只接受 available 或 planned');
    if (typeof item.name !== 'string' || !item.name.trim()) fail(`${at}.name`, '必須是非空字串');
    if (typeof item.description !== 'string') fail(`${at}.description`, '必須是字串');
    for (const key of ['connect_hint', 'account_page']) if (item[key] !== undefined && typeof item[key] !== 'string') fail(`${at}.${key}`, '必須是字串');
    const texts = { connectHint: item.connect_hint ?? '', accountPage: item.account_page ?? '' };
    if (item.status === 'planned') return Object.freeze({ id: item.id, name: item.name, provider: item.provider ?? null, status: 'planned', description: item.description, never: [], levels: [], ...texts });
    if (typeof item.provider !== 'string' || !item.provider) fail(`${at}.provider`, '可用的連接器必須指定 provider');
    if (!Array.isArray(item.levels) || !item.levels.length) fail(`${at}.levels`, '可用的連接器至少要有一個權限等級');
    const levels = item.levels.map(/** 驗證權限等級 @param {object} level 等級 @param {number} k 位置 @returns {object} 等級 */ (level, k) => {
      const lat = `${at}.levels[${k}]`;
      if (typeof level?.id !== 'string' || !ID_PATTERN.test(level.id)) fail(`${lat}.id`, '必須是小寫英數與底線');
      for (const key of ['name', 'summary']) if (typeof level[key] !== 'string' || !level[key].trim()) fail(`${lat}.${key}`, '必須是非空字串');
      for (const key of ['scopes', 'reads', 'tools']) {
        if (!Array.isArray(level[key]) || !level[key].length || level[key].some(/** 檢查字串 @param {unknown} v 值 @returns {boolean} 不是字串時 true */ (v) => typeof v !== 'string' || !v)) fail(`${lat}.${key}`, '必須是非空字串陣列');
      }
      return Object.freeze({ id: level.id, name: level.name, summary: level.summary, scopes: Object.freeze([...level.scopes]), reads: Object.freeze([...level.reads]), tools: Object.freeze([...level.tools]) });
    });
    const never = Array.isArray(item.never) ? item.never.filter(/** 只留字串 @param {unknown} v 值 @returns {boolean} 字串時 true */ (v) => typeof v === 'string') : [];
    return Object.freeze({ id: item.id, name: item.name, provider: item.provider, status: 'available', description: item.description, never: Object.freeze(never), levels: Object.freeze(levels), ...texts });
  });
  const byId = new Map(connectors.map(/** 依 id 建索引 @param {object} item 連接器 @returns {[string, object]} 鍵值 */ (item) => [item.id, item]));
  return {
    /** 依設定檔順序列出全部連接器 @returns {object[]} 連接器 */
    list() { return connectors; },
    /** 依 id 找連接器 @param {string} id 連接器 id @returns {object|null} 連接器，沒有時 null */
    find(id) { return byId.get(id) ?? null; },
    /** 找連接器的某個權限等級 @param {object} connector 連接器 @param {string} levelId 等級 id @returns {object|null} 等級，沒有時 null */
    level(connector, levelId) { return connector.levels.find(/** 比對 id @param {{id: string}} item 等級 @returns {boolean} 相符時 true */ (item) => item.id === levelId) ?? null; },
  };
}

let cached;
/**
 * 取得正式設定檔的連接器查詢（第一次成功時讀檔並快取；失敗不快取，下次呼叫重新讀檔）
 * @returns {ReturnType<typeof createConnectorRegistry>} 連接器查詢
 * @throws {Error} code CONNECTORS_INVALID：設定格式錯誤；檔案不存在時為 ENOENT
 */
export function getConnectorRegistry() {
  cached ??= createConnectorRegistry();
  return cached;
}

/**
 * 建立延後載入的連接器查詢：外部服務連接是附加功能，設定檔不見或格式錯誤時只讓連接相關的 API 回 503，登入與需求單照常運作，
 * 不像需求類型那樣讓整個後端啟動失敗；建立時先試讀一次，失敗就寫一行錯誤日誌（含原因代碼與鍵路徑），之後每次使用都重新嘗試
 * @param {object} [options={}] 選項
 * @param {() => object} [options.load=getConnectorRegistry] 載入連接器查詢的函式（測試可注入失敗）
 * @param {Function} [options.log=logger] 日誌寫入
 * @returns {{list: Function, find: Function, level: Function}} 與 createConnectorRegistry 相同的查詢介面
 * @throws {HttpError} 各方法在設定無法載入時拋出 503 CONNECTORS_UNAVAILABLE
 */
export function createLazyRegistry({ load = getConnectorRegistry, log = logger } = {}) {
  /**
   * 取得已載入的查詢；失敗時轉成固定的 503，不把檔案路徑或設定內容回給前端
   * @returns {object} 連接器查詢
   * @throws {HttpError} 503 CONNECTORS_UNAVAILABLE
   */
  function loaded() {
    try { return load(); } catch { throw new HttpError(503, 'CONNECTORS_UNAVAILABLE', '外部服務連接暫時無法使用，請聯絡管理員'); }
  }
  try { load(); } catch (error) {
    log('error', 'connectors.config_failed', { reason: typeof error?.code === 'string' ? error.code : 'LOAD_FAILED', detail: String(error?.message ?? '').slice(0, 300) });
  }
  return {
    /** 列出全部連接器 @returns {object[]} 連接器 @throws {HttpError} 503 CONNECTORS_UNAVAILABLE */
    list() { return loaded().list(); },
    /** 依 id 找連接器 @param {string} id 連接器 id @returns {object|null} 連接器 @throws {HttpError} 503 CONNECTORS_UNAVAILABLE */
    find(id) { return loaded().find(id); },
    /** 找連接器的權限等級 @param {object} connector 連接器 @param {string} levelId 等級 id @returns {object|null} 等級 @throws {HttpError} 503 CONNECTORS_UNAVAILABLE */
    level(connector, levelId) { return loaded().level(connector, levelId); },
  };
}
