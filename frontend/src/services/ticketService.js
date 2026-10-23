import { API_BASE_URL } from '../config.js';
import { authService } from './authService.js';

// 狀態追蹤頁「重新提出」把主題與內容暫存在本分頁 sessionStorage 的鍵名，提出需求單頁讀取後即清除。
export const DRAFT_KEY = 'helpdesk.draft.v1';
const ROUTES = ['HANDLER', 'DEPARTMENT', 'FALLBACK'];
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
export const STATUS_LABELS = { PENDING: '待簽核', APPROVED: '已簽核', REJECTED: '已退回', CANCELLED: '已取消' };
const DECISIONS = ['APPROVE', 'REJECT'];
export const QUOTA_CODES = ['DAILY_QUOTA_EXCEEDED', 'GLOBAL_QUOTA_EXCEEDED'];
export const TICKET_LIMITS = { subject: 100, content: 2000, comment: 200 };
const REQUEST_TIMEOUT_MS = 20000;

export const MESSAGES = {
  network: '無法連線至後端，請確認網路、API 網址與 CORS 設定',
  ticketTimeout: '伺服器太久沒有回應，需求單可能已經送出，請先向處理人或部門確認，沒有收到再重新送出',
  listTimeout: '伺服器太久沒有回應，請稍後再試',
  ticketUnreadable: '伺服器已回應，但內容無法辨識，需求單可能已經送出，請先向處理人或部門確認，沒有收到再重新送出',
  listInvalid: '伺服器回應的格式不正確',
  decisionUnreadable: '伺服器已回應，但內容無法辨識，簽核結果可能已經生效，請重新整理清單確認',
  transferUnreadable: '伺服器已回應，但內容無法辨識，轉單可能已經生效，請重新整理清單確認',
  cancelUnreadable: '伺服器已回應，但內容無法辨識，取消可能已經生效，請重新整理清單確認',
  conflict: '這張需求單已經簽核過，請重新整理清單',
  loginRequired: '登入已失效，請重新登入',
  busy: '系統繁忙中，請稍後再試',
  quota: '今日額度已用完，將於台北時間午夜重置',
  invalid: '送出的內容不符合規定，請檢查後再試',
  forbidden: '沒有權限執行這個操作',
  notFound: '後端目前沒有提供這個功能（404），請確認後端版本與網址',
  tooLarge: '送出的內容太大，請縮短後再試',
  unavailable: '系統暫時忙碌，請稍後再試',
  serverError: '系統暫時無法使用，請稍後再試',
};

/** 需求單服務錯誤，保留狀態碼、錯誤代碼與等待秒數供畫面判斷倒數與導頁。 */
export class TicketServiceError extends Error {
  /**
   * 建立可供介面安全顯示的服務錯誤，不包含請求內容或憑證。
   * @param {string} message 繁體中文提示。
   * @param {object} [options={}] 錯誤屬性。
   * @param {number} [options.status=0] HTTP 狀態碼；0 表示本機驗證、連線或逾時錯誤。
   * @param {string} [options.code='CLIENT_ERROR'] 後端錯誤代碼或前端代碼（NETWORK_ERROR、TIMEOUT、INVALID_RESPONSE、LOGIN_REQUIRED、INVALID_PAYLOAD）。
   * @param {number} [options.retryAfter=0] 後端要求的等待秒數；沒有時為 0。
   */
  constructor(message, { status = 0, code = 'CLIENT_ERROR', retryAfter = 0 } = {}) {
    super(message);
    this.name = 'TicketServiceError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * 檢查值是否為非空白字串。
 * @param {unknown} value 待檢查值。
 * @returns {boolean} 是否含可顯示文字。
 */
function isText(value) { return typeof value === 'string' && value.trim().length > 0; }

/**
 * 以 Unicode code points 計算去除首尾空白後的字數，與後端的算法相同。
 * @param {unknown} value 輸入文字。
 * @returns {number} 字數；非字串視為 0。
 */
export function countCodePoints(value) { return typeof value === 'string' ? Array.from(value.trim()).length : 0; }

/**
 * 驗證主題與需求內容：必填，去除首尾空白後 1～上限字；兩欄一起檢查並回傳各自的提示。
 * @param {{subject: unknown, content: unknown}} fields 表單輸入。
 * @returns {{subject: string, content: string}} 每個欄位的錯誤提示，沒有錯誤時為空字串。
 */
export function validateTicketInput({ subject, content }) {
  const errors = { subject: '', content: '' };
  const subjectCount = countCodePoints(subject);
  const contentCount = countCodePoints(content);
  if (subjectCount === 0) errors.subject = '請填寫主題';
  else if (subjectCount > TICKET_LIMITS.subject) errors.subject = `主題最多 ${TICKET_LIMITS.subject} 字，目前 ${subjectCount} 字`;
  if (contentCount === 0) errors.content = '請填寫需求內容';
  else if (contentCount > TICKET_LIMITS.content) errors.content = `需求內容最多 ${TICKET_LIMITS.content} 字，目前 ${contentCount} 字`;
  return errors;
}

/**
 * 依 HTTP 狀態碼與後端錯誤本文組出畫面提示；規則見開發規格書「送出結果與錯誤處理」。
 * @param {number} status HTTP 狀態碼（非 2xx）。
 * @param {unknown} payload 後端回應本文（可能不是 JSON）。
 * @param {unknown} [retryHeader] Retry-After 標頭值，retry_after 缺漏時使用。
 * @returns {{message: string, code: string, retryAfter: number}} 提示、錯誤代碼與等待秒數。
 */
export function describeHttpError(status, payload, retryHeader) {
  const backend = payload && typeof payload === 'object' ? payload.error : undefined;
  const backendMessage = isText(backend?.message) ? backend.message.trim() : '';
  const code = isText(backend?.code) ? backend.code : status === 401 ? 'UNAUTHORIZED' : 'SERVER_ERROR';
  const retry = Number(backend?.retry_after ?? retryHeader);
  const retryAfter = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 0;
  let message;
  if (status === 401) message = MESSAGES.loginRequired;
  else if (status === 400) message = backendMessage ? `${MESSAGES.invalid}\n${backendMessage}` : MESSAGES.invalid;
  else if (status === 403) message = backendMessage || MESSAGES.forbidden;
  else if (status === 404) message = backendMessage && code === 'TICKET_NOT_FOUND' ? backendMessage : MESSAGES.notFound;
  else if (status === 409) message = backendMessage || MESSAGES.conflict;
  else if (status === 413) message = MESSAGES.tooLarge;
  else if (status === 429) message = backendMessage || (QUOTA_CODES.includes(code) ? MESSAGES.quota : MESSAGES.busy);
  else if (status === 503) message = backendMessage || MESSAGES.unavailable;
  else if (status >= 500) message = MESSAGES.serverError;
  else message = `伺服器回應異常（${status}）`;
  // 額度用盡與 503 不倒數：等待秒數清為 0，畫面只顯示提示。
  const countdown = status === 429 && !QUOTA_CODES.includes(code) ? retryAfter : 0;
  return { message, code, retryAfter: countdown };
}

/**
 * 整理 GET /api/departments 的回應；部門或處理人缺少 id 或 name 時整份名單視為格式不正確。
 * business 中不是文字的項目會被略過；type 缺漏為空字串；handlers 缺漏為空陣列。
 * @param {unknown} data 解析後的 JSON。
 * @returns {Array<object>} 正規化的部門陣列（id、name、type、duty、business、handlers）。
 * @throws {TicketServiceError} 格式不正確。
 */
export function normalizeDepartments(data) {
  const invalid = () => new TicketServiceError(MESSAGES.listInvalid, { status: 200, code: 'INVALID_RESPONSE' });
  if (!data || typeof data !== 'object' || !Array.isArray(data.departments)) throw invalid();
  const departments = [];
  for (const item of data.departments) {
    if (!item || typeof item !== 'object' || !isText(item.id) || !isText(item.name)) throw invalid();
    const handlers = [];
    for (const handler of Array.isArray(item.handlers) ? item.handlers : []) {
      if (!handler || typeof handler !== 'object' || !isText(handler.id) || !isText(handler.name)) throw invalid();
      handlers.push({ id: handler.id, name: handler.name.trim() });
    }
    const business = (Array.isArray(item.business) ? item.business : []).filter(isText).map((keyword) => keyword.trim());
    departments.push({ id: item.id, name: item.name.trim(), type: isText(item.type) ? item.type.trim() : '',
      duty: typeof item.duty === 'string' ? item.duty.trim() : '', business, handlers });
  }
  return departments;
}

/**
 * 整理 POST /api/tickets 的 2xx 回應；缺少 ticket_id 或 department、route 不在三個值內、
 * route 為 HANDLER 卻沒有 handler.name 時，視為無法辨識的回應。HANDLER 不保留 basis。
 * @param {unknown} data 解析後的 JSON。
 * @returns {object} ticket_id、route、department，HANDLER 另含 handler，有判斷依據時含 basis。
 * @throws {TicketServiceError} 回應無法辨識。
 */
export function normalizeTicketResponse(data) {
  const invalid = () => new TicketServiceError(MESSAGES.ticketUnreadable, { status: 200, code: 'INVALID_RESPONSE' });
  if (!data || typeof data !== 'object' || !isText(data.ticket_id) || !isText(data.department) || !ROUTES.includes(data.route)) throw invalid();
  const result = { ticket_id: data.ticket_id.trim(), route: data.route, department: data.department.trim() };
  if (data.route === 'HANDLER') {
    if (!data.handler || typeof data.handler !== 'object' || !isText(data.handler.name)) throw invalid();
    result.handler = { name: data.handler.name.trim() };
  }
  // HANDLER 沒有判斷依據欄位；只有 DEPARTMENT 與 FALLBACK 保留非空白的 basis。
  if (data.route !== 'HANDLER' && isText(data.basis)) result.basis = data.basis.trim();
  return result;
}

/**
 * 以登入憑證呼叫後端；單次最長等待 20 秒，不自動重送。連線失敗與逾時各自轉成固定提示。
 * @param {string} path 以 /api 開頭的路徑。
 * @param {object} options 請求設定。
 * @param {string} [options.method='GET'] HTTP 方法。
 * @param {object} [options.body] 要序列化成 JSON 的本文。
 * @param {string} options.timeoutMessage 逾時提示。
 * @returns {Promise<{response: Response, data: unknown, parsed: boolean}>} 回應與解析結果；本文不是 JSON 時 parsed 為 false。
 * @throws {TicketServiceError} 未登入、連線失敗或逾時。
 */
async function request(path, { method = 'GET', body, timeoutMessage }) {
  const token = authService.getAccessToken();
  if (!token) throw new TicketServiceError(MESSAGES.loginRequired, { status: 401, code: 'LOGIN_REQUIRED' });
  let response;
  try {
    response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new TicketServiceError(timeoutMessage, { code: 'TIMEOUT' });
    throw new TicketServiceError(MESSAGES.network, { code: 'NETWORK_ERROR' });
  }
  let data;
  let parsed = true;
  try { data = await response.json(); } catch { parsed = false; }
  return { response, data, parsed };
}

/**
 * 載入部門與處理人名單（GET /api/departments）；不呼叫 Gemini、不扣額度。
 * @returns {Promise<Array<object>>} 正規化的部門陣列。
 * @throws {TicketServiceError} 未登入、HTTP 錯誤（含 404 與 401）、連線失敗、逾時或格式不正確。
 */
export async function loadDepartments() {
  const { response, data, parsed } = await request('/api/departments', { timeoutMessage: MESSAGES.listTimeout });
  if (!response.ok) {
    const described = describeHttpError(response.status, parsed ? data : undefined, response.headers.get('Retry-After'));
    throw new TicketServiceError(described.message, { status: response.status, code: described.code, retryAfter: described.retryAfter });
  }
  if (!parsed) throw new TicketServiceError(MESSAGES.listInvalid, { status: response.status, code: 'INVALID_RESPONSE' });
  return normalizeDepartments(data);
}

/**
 * 送出需求單（POST /api/tickets）。先在前端去除首尾空白並驗證字數，再送 { subject, content, handler_id }；
 * 提單人由後端依憑證決定，本文不帶 userID。
 * @param {object} input 表單內容。
 * @param {string} input.subject 主題。
 * @param {string} input.content 需求內容。
 * @param {string} [input.handlerId] 指定處理人 id；空值代表不指定，由 AI 判斷部門。
 * @returns {Promise<object>} 經 normalizeTicketResponse 整理的結果。
 * @throws {TicketServiceError} 輸入無效、未登入、HTTP 錯誤、連線失敗、逾時或回應無法辨識。
 */
export async function submitTicket({ subject, content, handlerId }) {
  const errors = validateTicketInput({ subject, content });
  const firstError = errors.subject || errors.content;
  if (firstError) throw new TicketServiceError(firstError, { status: 400, code: 'INVALID_PAYLOAD' });
  const body = { subject: subject.trim(), content: content.trim(), handler_id: isText(handlerId) ? handlerId : null };
  const { response, data, parsed } = await request('/api/tickets', { method: 'POST', body, timeoutMessage: MESSAGES.ticketTimeout });
  if (!response.ok) {
    const described = describeHttpError(response.status, parsed ? data : undefined, response.headers.get('Retry-After'));
    throw new TicketServiceError(described.message, { status: response.status, code: described.code, retryAfter: described.retryAfter });
  }
  if (!parsed) throw new TicketServiceError(MESSAGES.ticketUnreadable, { status: response.status, code: 'INVALID_RESPONSE' });
  return normalizeTicketResponse(data);
}

/**
 * 整理後端保存的需求單記錄（我的需求單、部門需求單與簽核回應共用）；缺少單號、主題、狀態或送達部門時視為格式不正確。
 * @param {unknown} data 單筆需求單 JSON。
 * @returns {object} 正規化的需求單：ticket_id、created_at、updated_at、subject、content、status、route、department_id、department_name、
 *   handler（name 或 null）、requester（username、department_name）、judgement（basis、confidence_score 或 null）、decision（by_username、at、comment 或 null）、
 *   history（每筆含 event、at、by_username、comment，轉單事件另含 from_department_name、to_department_name、to_handler_name）。
 * @throws {TicketServiceError} 格式不正確。
 */
export function normalizeStoredTicket(data) {
  const invalid = () => new TicketServiceError(MESSAGES.listInvalid, { status: 200, code: 'INVALID_RESPONSE' });
  if (!data || typeof data !== 'object' || !isText(data.ticket_id) || !isText(data.subject) || !STATUSES.includes(data.status)
    || !isText(data.department_name) || !isText(data.created_at)) throw invalid();
  const handler = data.handler && typeof data.handler === 'object' && isText(data.handler.name)
    ? { name: data.handler.name.trim() } : null;
  const judgement = data.judgement && typeof data.judgement === 'object'
    ? { basis: isText(data.judgement.basis) ? data.judgement.basis.trim() : '', confidence_score: Number.isInteger(data.judgement.confidence_score) ? data.judgement.confidence_score : null } : null;
  const decision = data.decision && typeof data.decision === 'object'
    ? { by_username: isText(data.decision.by_username) ? data.decision.by_username : '', at: isText(data.decision.at) ? data.decision.at : '', comment: isText(data.decision.comment) ? data.decision.comment.trim() : '',
      cancelled_by: data.decision.cancelled_by === 'REQUESTER' || data.decision.cancelled_by === 'DEPARTMENT' ? data.decision.cancelled_by : '' } : null;
  const history = (Array.isArray(data.history) ? data.history : []).filter((item) => item && typeof item === 'object' && isText(item.event) && isText(item.at))
    .map((item) => ({ event: item.event, at: item.at, by_username: isText(item.by_username) ? item.by_username : '', comment: isText(item.comment) ? item.comment.trim() : '',
      from_department_name: isText(item.from_department_name) ? item.from_department_name : '', to_department_name: isText(item.to_department_name) ? item.to_department_name : '',
      to_handler_name: isText(item.to_handler_name) ? item.to_handler_name : '' }));
  return {
    ticket_id: data.ticket_id.trim(), created_at: data.created_at, updated_at: isText(data.updated_at) ? data.updated_at : data.created_at,
    subject: data.subject.trim(), content: typeof data.content === 'string' ? data.content : '', status: data.status,
    route: ROUTES.includes(data.route) ? data.route : 'FALLBACK', department_id: isText(data.department_id) ? data.department_id : '', department_name: data.department_name.trim(),
    handler, requester: { user_id: isText(data.requester?.user_id) ? data.requester.user_id : '', username: isText(data.requester?.username) ? data.requester.username : '', department_name: isText(data.requester?.department_name) ? data.requester.department_name : '' },
    judgement, decision, history,
  };
}

/**
 * 呼叫需求單查詢端點並檢查清單形狀；2xx 但格式不正確時視為格式錯誤。
 * @param {string} path 端點路徑。
 * @returns {Promise<object>} 解析後的 JSON（含 tickets 陣列）。
 * @throws {TicketServiceError} 未登入、HTTP 錯誤、連線失敗、逾時或格式不正確。
 */
async function fetchList(path) {
  const { response, data, parsed } = await request(path, { timeoutMessage: MESSAGES.listTimeout });
  if (!response.ok) {
    const described = describeHttpError(response.status, parsed ? data : undefined, response.headers.get('Retry-After'));
    throw new TicketServiceError(described.message, { status: response.status, code: described.code, retryAfter: described.retryAfter });
  }
  if (!parsed || !data || typeof data !== 'object' || !Array.isArray(data.tickets)) throw new TicketServiceError(MESSAGES.listInvalid, { status: response.status, code: 'INVALID_RESPONSE' });
  return data;
}

/**
 * 載入我提出的需求單（GET /api/tickets/mine），最新的在前。
 * @returns {Promise<Array<object>>} 正規化的需求單陣列。
 * @throws {TicketServiceError} 未登入、HTTP 錯誤、連線失敗、逾時或格式不正確。
 */
export async function loadMyTickets() {
  const data = await fetchList('/api/tickets/mine');
  return data.tickets.map(normalizeStoredTicket);
}

/**
 * 載入送達我所屬部門的需求單（GET /api/tickets/department）；待簽核在前。
 * @returns {Promise<{department: {id: string, name: string}, tickets: Array<object>}>} 部門與正規化的需求單陣列。
 * @throws {TicketServiceError} 未登入、HTTP 錯誤、連線失敗、逾時或格式不正確。
 */
export async function loadDepartmentTickets() {
  const data = await fetchList('/api/tickets/department');
  if (!data.department || !isText(data.department.id) || !isText(data.department.name)) throw new TicketServiceError(MESSAGES.listInvalid, { status: 200, code: 'INVALID_RESPONSE' });
  return { department: { id: data.department.id, name: data.department.name }, tickets: data.tickets.map(normalizeStoredTicket) };
}

/**
 * 簽核或退回一張需求單（POST /api/tickets/{id}/decision），備註去除首尾空白後最多 200 字。
 * @param {string} ticketId 單號。
 * @param {'APPROVE'|'REJECT'} action 簽核或退回。
 * @param {string} [comment=''] 備註。
 * @returns {Promise<object>} 更新後的需求單（normalizeStoredTicket 的結果）。
 * @throws {TicketServiceError} 輸入無效、未登入、403 不是送達部門、404 查無、409 已簽核過、連線失敗、逾時或回應無法辨識。
 */
export async function decideTicket(ticketId, action, comment = '') {
  if (!isText(ticketId)) throw new TicketServiceError('缺少需求單單號', { status: 400, code: 'INVALID_PAYLOAD' });
  if (!DECISIONS.includes(action)) throw new TicketServiceError('簽核動作無效', { status: 400, code: 'INVALID_PAYLOAD' });
  const note = typeof comment === 'string' ? comment.trim() : '';
  if (countCodePoints(note) > TICKET_LIMITS.comment) throw new TicketServiceError(`備註最多 ${TICKET_LIMITS.comment} 字，目前 ${countCodePoints(note)} 字`, { status: 400, code: 'INVALID_PAYLOAD' });
  const { response, data, parsed } = await request(`/api/tickets/${encodeURIComponent(ticketId.trim())}/decision`, { method: 'POST', body: { action, comment: note }, timeoutMessage: MESSAGES.listTimeout });
  if (!response.ok) {
    const described = describeHttpError(response.status, parsed ? data : undefined, response.headers.get('Retry-After'));
    throw new TicketServiceError(described.message, { status: response.status, code: described.code, retryAfter: described.retryAfter });
  }
  if (!parsed || !data || typeof data !== 'object') throw new TicketServiceError(MESSAGES.decisionUnreadable, { status: response.status, code: 'INVALID_RESPONSE' });
  try { return normalizeStoredTicket(data.ticket); } catch { throw new TicketServiceError(MESSAGES.decisionUnreadable, { status: response.status, code: 'INVALID_RESPONSE' }); }
}

/**
 * 把一張待簽核的需求單轉到其他部門（POST /api/tickets/{id}/transfer），可指定該部門的處理人並附最多 200 字備註。
 * @param {string} ticketId 單號。
 * @param {string} departmentId 目標部門 id。
 * @param {string} [handlerId=''] 目標部門的處理人 id；空值代表不指定。
 * @param {string} [comment=''] 備註。
 * @returns {Promise<object>} 更新後的需求單（normalizeStoredTicket 的結果）。
 * @throws {TicketServiceError} 輸入無效、未登入、400 目標無效、403 不是送達部門、404 查無、409 已簽核過、連線失敗、逾時或回應無法辨識。
 */
export async function transferTicket(ticketId, departmentId, handlerId = '', comment = '') {
  if (!isText(ticketId)) throw new TicketServiceError('缺少需求單單號', { status: 400, code: 'INVALID_PAYLOAD' });
  if (!isText(departmentId)) throw new TicketServiceError('請選擇要轉到的部門', { status: 400, code: 'INVALID_PAYLOAD' });
  const note = typeof comment === 'string' ? comment.trim() : '';
  if (countCodePoints(note) > TICKET_LIMITS.comment) throw new TicketServiceError(`備註最多 ${TICKET_LIMITS.comment} 字，目前 ${countCodePoints(note)} 字`, { status: 400, code: 'INVALID_PAYLOAD' });
  const body = { department_id: departmentId, handler_id: isText(handlerId) ? handlerId : null, comment: note };
  const { response, data, parsed } = await request(`/api/tickets/${encodeURIComponent(ticketId.trim())}/transfer`, { method: 'POST', body, timeoutMessage: MESSAGES.listTimeout });
  if (!response.ok) {
    const described = describeHttpError(response.status, parsed ? data : undefined, response.headers.get('Retry-After'));
    throw new TicketServiceError(described.message, { status: response.status, code: described.code, retryAfter: described.retryAfter });
  }
  if (!parsed || !data || typeof data !== 'object') throw new TicketServiceError(MESSAGES.transferUnreadable, { status: response.status, code: 'INVALID_RESPONSE' });
  try { return normalizeStoredTicket(data.ticket); } catch { throw new TicketServiceError(MESSAGES.transferUnreadable, { status: response.status, code: 'INVALID_RESPONSE' }); }
}

export const COMPLETED_DEFAULT_LIMIT = 100;

/**
 * 載入已完成清單（GET /api/tickets/completed）：我提出且已結案的需求單，加上本部門已簽核、退回或取消的需求單，依簽核時間由新到舊，預設最新 100 筆。
 * @param {object} [filters={}] 查詢條件。
 * @param {string} [filters.status] `APPROVED`、`REJECTED` 或空字串（全部）。
 * @param {string} [filters.q] 關鍵字（單號、主題、內容、提單人、簽核人），去除首尾空白後最多 100 字。
 * @param {string} [filters.from] 簽核日期起（台北日期 YYYY-MM-DD）。
 * @param {string} [filters.to] 簽核日期迄（台北日期 YYYY-MM-DD）。
 * @param {number} [filters.limit=100] 筆數上限，1～500。
 * @returns {Promise<{department: {id: string, name: string}, total: number, limit: number, tickets: Array<object>}>} 符合條件的總數與回傳的需求單。
 * @throws {TicketServiceError} 條件無效、未登入、HTTP 錯誤、連線失敗、逾時或格式不正確。
 */
export async function loadCompletedTickets({ status = '', q = '', from = '', to = '', limit = COMPLETED_DEFAULT_LIMIT } = {}) {
  const keyword = typeof q === 'string' ? q.trim() : '';
  if (countCodePoints(keyword) > 100) throw new TicketServiceError('關鍵字最多 100 字', { status: 400, code: 'INVALID_PAYLOAD' });
  if (from && to && from > to) throw new TicketServiceError('起始日期不可晚於結束日期', { status: 400, code: 'INVALID_PAYLOAD' });
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (keyword) params.set('q', keyword);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit !== COMPLETED_DEFAULT_LIMIT) params.set('limit', String(limit));
  const query = params.toString();
  const data = await fetchList(`/api/tickets/completed${query ? `?${query}` : ''}`);
  if (!data.department || !isText(data.department.id) || !isText(data.department.name) || !Number.isInteger(data.total) || data.total < 0) {
    throw new TicketServiceError(MESSAGES.listInvalid, { status: 200, code: 'INVALID_RESPONSE' });
  }
  return { department: { id: data.department.id, name: data.department.name }, total: data.total,
    limit: Number.isInteger(data.limit) && data.limit > 0 ? data.limit : limit, tickets: data.tickets.map(normalizeStoredTicket) };
}

/**
 * 取消一張待簽核的需求單（POST /api/tickets/{id}/cancel）。提單人可取消自己的單，送達部門的成員替提單人取消時必須填原因。
 * @param {string} ticketId 單號。
 * @param {string} [comment=''] 原因或備註，去除首尾空白後最多 200 字。
 * @returns {Promise<object>} 更新後的需求單（normalizeStoredTicket 的結果）。
 * @throws {TicketServiceError} 輸入無效、未登入、400 未填原因、403 無權限、404 查無、409 已簽核或已取消、連線失敗、逾時或回應無法辨識。
 */
export async function cancelTicket(ticketId, comment = '') {
  if (!isText(ticketId)) throw new TicketServiceError('缺少需求單單號', { status: 400, code: 'INVALID_PAYLOAD' });
  const note = typeof comment === 'string' ? comment.trim() : '';
  if (countCodePoints(note) > TICKET_LIMITS.comment) throw new TicketServiceError(`備註最多 ${TICKET_LIMITS.comment} 字，目前 ${countCodePoints(note)} 字`, { status: 400, code: 'INVALID_PAYLOAD' });
  const { response, data, parsed } = await request(`/api/tickets/${encodeURIComponent(ticketId.trim())}/cancel`, { method: 'POST', body: { comment: note }, timeoutMessage: MESSAGES.listTimeout });
  if (!response.ok) {
    const described = describeHttpError(response.status, parsed ? data : undefined, response.headers.get('Retry-After'));
    throw new TicketServiceError(described.message, { status: response.status, code: described.code, retryAfter: described.retryAfter });
  }
  if (!parsed || !data || typeof data !== 'object') throw new TicketServiceError(MESSAGES.cancelUnreadable, { status: response.status, code: 'INVALID_RESPONSE' });
  try { return normalizeStoredTicket(data.ticket); } catch { throw new TicketServiceError(MESSAGES.cancelUnreadable, { status: response.status, code: 'INVALID_RESPONSE' }); }
}
