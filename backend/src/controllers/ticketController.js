import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler.js';
import { departmentService } from '../services/departmentService.js';
import { accountService } from '../services/personnel/accountService.js';
import { judgeTicket } from '../services/ai/providers.js';
import { dataStore } from '../services/storage/dataStore.js';
import { usageService } from '../services/usageService.js';
import { taskTracker } from '../services/taskTracker.js';
import { logger } from '../utils/logger.js';
import { getRequestTypes } from '../services/requestTypes/registry.js';
import { assertApproval, assertTransfer, parseFormSubmission, storedForm, submissionDepartment, submissionGuard, submissionHandler } from '../services/requestTypes/workflow.js';

// 自動生成對話確認部門的需求單，保存與回應使用的固定判斷依據。
export const DRAFT_BASIS = '依 AI 對話確認送達';
const LIMITS = { subject: 100, content: 2000, comment: 200, keyword: 100 };
const DECISIONS = { APPROVE: 'APPROVED', REJECT: 'REJECTED' };
const COMPLETED_STATUSES = ['APPROVED', 'REJECTED', 'CANCELLED'];
const COMPLETED_DEFAULT_LIMIT = 100;
const COMPLETED_MAX_LIMIT = 500;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 把 ISO 時間轉成台北時間（UTC+8）的日期字串，供日期範圍篩選使用。
 * @param {string} iso ISO 8601 時間。
 * @returns {string} YYYY-MM-DD；無法解析時回傳空字串。
 */
function taipeiDate(iso) {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : '';
}

/**
 * 判斷 YYYY-MM-DD 字串是否為真實存在的日期：格式相符，且轉成 UTC 日期後再格式化仍等於原字串。
 * 用來拒絕 2024-02-31、2026-13-40 這類 Date.parse 會自動進位或格式正確卻不存在的日期。
 * @param {string} value 待檢查的日期字串。
 * @returns {boolean} 是否為有效日期。
 */
function isCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * 解析並驗證「已完成」查詢的條件：狀態、關鍵字、台北日期範圍與筆數上限。
 * 規則：
 * - status、q、from、to、limit 省略時使用預設；有提供但不是字串（例如重複鍵產生的陣列或巢狀物件）一律回 400，不默默忽略篩選。
 * - 空字串視同省略（status、from、to、limit）；q 去除首尾空白後最多 100 個 Unicode code points。
 * - from、to 必須是實際存在的 YYYY-MM-DD 日期（以 UTC 日期往返比對），from 不可晚於 to。
 * - limit 只接受純十進位整數字串（不接受 0x10、1e2、+5、空白等），範圍 1～500，預設 100。
 * @param {object} [query={}] Express 解析後的查詢參數。
 * @returns {{status: string, keyword: string, from: string, to: string, limit: number}} 已驗證的條件。
 * @throws {HttpError} 400 INVALID_PAYLOAD：參數型別、狀態、日期、範圍或筆數不合規定。
 */
export function parseCompletedQuery(query = {}) {
  for (const name of ['status', 'q', 'from', 'to', 'limit']) {
    if (query[name] !== undefined && typeof query[name] !== 'string') throw new HttpError(400, 'INVALID_PAYLOAD', `${name} 只能提供一次且必須是字串`);
  }
  const status = query.status || '';
  if (status && !COMPLETED_STATUSES.includes(status)) throw new HttpError(400, 'INVALID_PAYLOAD', 'status 必須是 APPROVED、REJECTED 或 CANCELLED');
  const keyword = (query.q ?? '').trim();
  if (Array.from(keyword).length > LIMITS.keyword) throw new HttpError(400, 'INVALID_PAYLOAD', `q 最多 ${LIMITS.keyword} 字元`);
  const from = query.from || '';
  const to = query.to || '';
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value && !isCalendarDate(value)) throw new HttpError(400, 'INVALID_PAYLOAD', `${name} 必須是 YYYY-MM-DD 的日期`);
  }
  if (from && to && from > to) throw new HttpError(400, 'INVALID_PAYLOAD', 'from 不可晚於 to');
  let limit = COMPLETED_DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== '') {
    limit = /^\d{1,4}$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > COMPLETED_MAX_LIMIT) throw new HttpError(400, 'INVALID_PAYLOAD', `limit 必須是 1 到 ${COMPLETED_MAX_LIMIT} 的整數`);
  }
  return { status, keyword, from, to, limit };
}

/**
 * 判斷一張已完成的需求單是否符合查詢條件；關鍵字不分大小寫，比對單號、主題、內容、提單人與簽核人帳號。
 * @param {object} ticket 需求單。
 * @param {object} conditions parseCompletedQuery 的結果。
 * @returns {boolean} 是否符合。
 */
export function matchesCompleted(ticket, conditions) {
  if (!COMPLETED_STATUSES.includes(ticket.status)) return false;
  if (conditions.status && ticket.status !== conditions.status) return false;
  const decidedOn = taipeiDate(ticket.decision?.at ?? ticket.updated_at);
  if (conditions.from && decidedOn < conditions.from) return false;
  if (conditions.to && decidedOn > conditions.to) return false;
  if (conditions.keyword) {
    const needle = conditions.keyword.toLowerCase();
    const haystack = [ticket.ticket_id, ticket.subject, ticket.content, ticket.requester?.username, ticket.decision?.by_username, ticket.decision?.comment, ticket.handler?.name]
      .filter((value) => typeof value === 'string').join('\n').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/**
 * 驗證需求單文字欄位：必須是字串，去除首尾空白後以 Unicode code points 計算長度並落在 1～上限。
 * @param {unknown} value 請求本文的欄位值。
 * @param {'subject'|'content'} field 欄位名稱，用於錯誤訊息與上限。
 * @returns {string} 去除首尾空白後的文字。
 * @throws {HttpError} 400 INVALID_PAYLOAD。
 */
function requireText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || Array.from(text).length > LIMITS[field]) {
    throw new HttpError(400, 'INVALID_PAYLOAD', `${field} 必須是 1 到 ${LIMITS[field]} 字元的非空白字串`);
  }
  return text;
}

/**
 * 建立新需求單記錄的共同欄位：單號、時間、提單人與初始狀態「待簽核」。
 * @param {object} user 憑證身分（username、userID、department）。
 * @param {string} subject 主題。
 * @param {string} content 需求內容。
 * @returns {object} 尚未填入送達資訊的需求單。
 */
function baseTicket(user, subject, content) {
  const now = new Date().toISOString();
  return {
    ticket_id: `TK-${randomUUID()}`,
    created_at: now,
    updated_at: now,
    requester: { user_id: user.userID, username: user.username, department_id: user.department.id, department_name: user.department.name },
    subject,
    content,
    status: 'PENDING',
    decision: null,
    history: [{ at: now, event: 'SUBMITTED', by_user_id: user.userID, by_username: user.username }],
  };
}

/**
 * 建立需求單處理器，依本文決定送達方式：
 * - 帶 form（自動生成確認的需求類型）：依需求類型定義重新驗證版本、欄位、計算、檢查與需求內容（與寫入同一筆交易），
 *   依定義的 workflow.route 送達：FORM 送定義的固定部門並保存表單資料，DEPARTMENT 送 department_id 指定的部門（judgement.source 為 draft，另保存 request_type { id, version } 供簽核與轉單規則查詢定義）；不呼叫 Gemini、不扣額度；
 * - 帶 department_id（自動生成對話確認的部門，舊版前端流程）：送達該部門（route DEPARTMENT，judgement.source 為 draft）；
 * - 指定處理人：直接送達處理人所屬部門並保存；
 * - 都沒有：預扣用量、呼叫 Gemini 判斷部門，再保存需求單。
 * 處理人就是登入帳號（handler_id 為帳號名稱），由帳號服務查詢所屬部門。
 * @param {object} [options={}] 可注入的依賴，供測試使用替身。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @param {object} [options.accounts=accountService] 帳號查詢服務（處理人名單）。
 * @param {Function} [options.judge=judgeTicket] 部門判斷函式。
 * @param {object} [options.store=dataStore] 需求單儲存。
 * @param {object} [options.usage=usageService] 配額服務。
 * @param {object} [options.tasks=taskTracker] 工作追蹤器，關機時等待既有需求單處理完成。
 * @param {object} [options.types] 需求類型目錄；省略時使用預設目錄。
 * @param {Function} [options.clock=Date.now] 時間來源（日期規則的今天）。
 * @returns {Function} Express 非同步處理器。
 */
export function createTicketHandler({ departments = departmentService, accounts = accountService, judge = judgeTicket, store = dataStore, usage = usageService, tasks = taskTracker,
  types, clock = Date.now } = {}) {
  /**
   * 處理自動生成確認的需求類型表單：驗證後依定義的流程送達。欄位驗證、計算、檢查與內容比對都在同一筆 IMMEDIATE 寫入交易內執行。
   * FORM 單保存 form（欄位與計算結果）；DEPARTMENT 單不保存欄位，只保存 request_type { id, version }，讓簽核與轉單依該類型的 workflow 判斷。
   * @param {object} user 憑證身分。
   * @param {string} subject 主題。
   * @param {string} content 需求內容。
   * @param {string|null|undefined} handlerId 指定處理人。
   * @param {unknown} raw 請求本文的 form。
   * @param {unknown} departmentId 請求本文的 department_id（只用於沒有固定部門的類型）。
   * @returns {Promise<object>} FORM：{ ticket_id, route, department, handler?, form: { id, version, name, computed }, status }；
   *   DEPARTMENT：{ ticket_id, route, department, handler?, basis, source: 'draft', status }。
   * @throws {HttpError} 400 欄位或內容錯誤、409 FORM_VERSION_CHANGED 或定義的檢查錯誤代碼、503 儲存失敗。
   */
  async function submitForm(user, subject, content, handlerId, raw, departmentId) {
    const registry = types ?? getRequestTypes();
    const { type, input } = parseFormSubmission(raw, registry);
    const department = submissionDepartment(type, departmentId, departments);
    const handler = submissionHandler({ type, handlerId, department, user, accounts });
    const route = type.workflow.route;
    const ticket = { ...baseTicket(user, subject, content), route, department_id: department.id, department_name: department.name, handler,
      judgement: route === 'DEPARTMENT' ? { source: 'draft', ai_department_id: department.id, confidence_score: null, basis: DRAFT_BASIS, model: null } : null,
      ...(route === 'DEPARTMENT' ? { request_type: { id: type.id, version: type.version } } : {}) };
    let accepted;
    /** 保存驗證結果；FORM 流程把表單資料存入需求單。@param {object} evaluation 驗證結果。@returns {void} */
    function onAccepted(evaluation) {
      accepted = evaluation;
      if (route === 'FORM') ticket.form = storedForm(type, evaluation);
    }
    await store.insert(ticket, { guard: submissionGuard({ type, input, user, department, handler, content, types: registry, accounts, departments, clock, onAccepted }),
      ledgerSpecOf: () => type.ledgerSpec });
    logger('info', 'ticket.form.saved', { route, typeId: type.id, departmentId: department.id, withHandler: Boolean(handler), computedCount: Object.keys(accepted.computedMap).length });
    const shared = { ticket_id: ticket.ticket_id, route, department: department.name, ...(handler ? { handler: { name: handler.name } } : {}) };
    if (route === 'DEPARTMENT') return { ...shared, basis: DRAFT_BASIS, source: 'draft', status: ticket.status };
    return { ...shared, form: { id: type.id, version: type.version, name: type.name, computed: accepted.computedMap }, status: ticket.status };
  }

  /**
   * 處理自動生成對話確認的部門：部門必須存在，指定處理人（選填）必須是該部門的成員；不呼叫 Gemini、不扣判斷額度。
   * judgement 記錄 source 'draft' 與確認的部門；後端不保存對話，因此 confidence_score 與 model 為 null。
   * @param {object} user 憑證身分。
   * @param {string} subject 主題。
   * @param {string} content 需求內容。
   * @param {string|null|undefined} handlerId 指定處理人。
   * @param {unknown} departmentId 請求本文的 department_id。
   * @returns {Promise<object>} 回應內容 { ticket_id, route: 'DEPARTMENT', department, handler?, basis, source: 'draft', status }。
   * @throws {HttpError} 400 部門或處理人錯誤、503 儲存失敗。
   */
  async function submitDraftDepartment(user, subject, content, handlerId, departmentId) {
    const department = departments.findDepartment(departmentId);
    if (!department) throw new HttpError(400, 'INVALID_PAYLOAD', '指定的部門不存在');
    let handler = null;
    if (handlerId) {
      const found = accounts.findHandler(handlerId);
      if (!found) throw new HttpError(400, 'INVALID_PAYLOAD', '指定的處理人不存在');
      if (found.department.id !== department.id) throw new HttpError(400, 'INVALID_PAYLOAD', `指定的處理人不屬於「${department.name}」`);
      handler = { id: found.handler.id, name: found.handler.name };
    }
    const ticket = { ...baseTicket(user, subject, content), route: 'DEPARTMENT', department_id: department.id, department_name: department.name, handler,
      judgement: { source: 'draft', ai_department_id: department.id, confidence_score: null, basis: DRAFT_BASIS, model: null } };
    await store.insert(ticket);
    logger('info', 'ticket.record.saved', { route: 'DEPARTMENT', source: 'draft', departmentId: department.id, withHandler: Boolean(handler) });
    return { ticket_id: ticket.ticket_id, route: 'DEPARTMENT', department: department.name, ...(handler ? { handler: { name: handler.name } } : {}),
      basis: DRAFT_BASIS, source: 'draft', status: ticket.status };
  }

  /**
   * 處理一張需求單：① 憑證 → ② 欄位 → 帶 form 走固定表單、帶 department_id 走對話確認的部門 → ③ 指定處理人（直接保存並回應）；
   * 都沒有 → ④ 預扣用量 → ⑤ 判斷部門 → ⑥ 分流 → ⑦ 保存需求單 → ⑧ 回應並釋放租約。
   * @param {import('express').Request} req 已由 authenticate 加入 req.user。
   * @param {import('express').Response} res 回應。
   * @returns {Promise<void>}
   * @throws {HttpError} 未登入、欄位錯誤、處理人不存在、限流、上游失敗或儲存無法寫入。
   */
  async function ticketHandler(req, res) {
    if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', '請先登入');
    const subject = requireText(req.body?.subject, 'subject');
    const content = requireText(req.body?.content, 'content');
    const handlerId = req.body?.handler_id;
    if (!(handlerId === undefined || handlerId === null || typeof handlerId === 'string')) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'handler_id 必須是字串或 null');
    }
    if (req.body.form !== undefined && req.body.form !== null) {
      res.json(await submitForm(req.user, subject, content, handlerId, req.body.form, req.body.department_id));
      return;
    }
    const departmentId = req.body.department_id;
    if (!(departmentId === undefined || departmentId === null || typeof departmentId === 'string')) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'department_id 必須是字串或 null');
    }
    if (departmentId) {
      res.json(await submitDraftDepartment(req.user, subject, content, handlerId, departmentId));
      return;
    }
    if (handlerId) {
      const found = accounts.findHandler(handlerId);
      if (!found) throw new HttpError(400, 'INVALID_PAYLOAD', '指定的處理人不存在');
      const ticket = { ...baseTicket(req.user, subject, content), route: 'HANDLER', department_id: found.department.id, department_name: found.department.name,
        handler: { id: found.handler.id, name: found.handler.name }, judgement: null };
      await store.insert(ticket);
      logger('info', 'ticket.assigned', { route: 'HANDLER', departmentId: found.department.id });
      res.json({ ticket_id: ticket.ticket_id, route: 'HANDLER', department: found.department.name, handler: { name: found.handler.name }, status: ticket.status });
      return;
    }
    const reservation = await usage.reserve(req.user.userID);
    res.set('X-User-Remaining', String(reservation.usage.userRemaining));
    res.set('X-Global-Remaining', String(reservation.usage.globalRemaining));
    logger('info', 'limits.reserved', { userID: req.user.userID, ...reservation.usage });
    let result;
    try {
      const decision = await judge({ subject, content });
      const ticket = { ...baseTicket(req.user, subject, content), route: decision.route, department_id: decision.department.id, department_name: decision.department.name,
        handler: null, judgement: { ai_department_id: decision.aiDepartment?.id ?? null, confidence_score: decision.confidence, basis: decision.basis, model: decision.model } };
      await store.insert(ticket);
      logger('info', 'ticket.record.saved', { route: decision.route, departmentId: decision.department.id });
      result = { ticket_id: ticket.ticket_id, route: decision.route, department: decision.department.name, ...(decision.basis ? { basis: decision.basis } : {}), status: ticket.status };
    } finally {
      await usage.release(req.user.userID, reservation.id);
    }
    res.json(result);
  }
  /**
   * 追蹤整次需求單處理（含預扣、判斷、保存與釋放租約），供關機流程等待。
   * @param {import('express').Request} req 請求。
   * @param {import('express').Response} res 回應。
   * @returns {Promise<void>} 完整處理結果。
   */
  return function trackedTicketHandler(req, res) {
    /** 執行本次需求單的完整生命週期。@returns {Promise<void>} 處理與租約清理。 */
    function executeTicket() { return ticketHandler(req, res); }
    return tasks.run(executeTicket);
  };
}

/**
 * 建立「我的需求單」處理器：回傳憑證身分提出的所有需求單，最新的在前。
 * @param {object} [store=dataStore] 需求單儲存。
 * @returns {Function} Express 非同步處理器。
 */
export function createMyTicketsHandler(store = dataStore) {
  /**
   * 列出提單人為目前身分的需求單。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應 { tickets }。
   * @returns {Promise<void>}
   */
  return async function myTicketsHandler(req, res) {
    const tickets = (await store.all()).filter((ticket) => ticket.requester?.user_id === req.user.userID)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    res.set('Cache-Control', 'no-store');
    res.json({ tickets });
  };
}

/**
 * 建立「部門需求單」處理器：回傳送達憑證身分所屬部門的所有需求單；待簽核的在前（最早的優先），其餘依更新時間由新到舊。
 * @param {object} [store=dataStore] 需求單儲存。
 * @returns {Function} Express 非同步處理器。
 */
export function createDepartmentTicketsHandler(store = dataStore) {
  /**
   * 列出送達目前身分所屬部門的需求單。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應 { department, tickets }。
   * @returns {Promise<void>}
   */
  return async function departmentTicketsHandler(req, res) {
    const department = req.user.department;
    /**
     * 待簽核優先、再依時間排序。
     * @param {object} left 左側需求單。
     * @param {object} right 右側需求單。
     * @returns {number} 排序比較值。
     */
    function order(left, right) {
      const leftPending = left.status === 'PENDING' ? 0 : 1;
      const rightPending = right.status === 'PENDING' ? 0 : 1;
      if (leftPending !== rightPending) return leftPending - rightPending;
      return leftPending === 0 ? left.created_at.localeCompare(right.created_at) : right.updated_at.localeCompare(left.updated_at);
    }
    const tickets = (await store.all()).filter((ticket) => ticket.department_id === department.id).sort(order);
    res.set('Cache-Control', 'no-store');
    res.json({ department: { id: department.id, name: department.name }, tickets });
  };
}

/**
 * 讀取並驗證簽核、取消或轉單的備註：可省略（undefined），有提供時必須是字串，去除首尾空白後最多 200 個 Unicode code points。
 * null、數字、物件等非字串值一律回 400「comment 必須是字串」，與規格書 3.7／3.9／3.10 一致。
 * @param {unknown} raw 請求本文的 comment。
 * @returns {string} 去除首尾空白後的備註，省略時為空字串。
 * @throws {HttpError} 400 INVALID_PAYLOAD：不是字串或超過長度上限。
 */
function readComment(raw) {
  if (!(raw === undefined || typeof raw === 'string')) throw new HttpError(400, 'INVALID_PAYLOAD', 'comment 必須是字串');
  const comment = raw === undefined ? '' : raw.trim();
  if (Array.from(comment).length > LIMITS.comment) throw new HttpError(400, 'INVALID_PAYLOAD', `comment 最多 ${LIMITS.comment} 字元`);
  return comment;
}

/**
 * 建立「已完成」處理器：回傳憑證身分提出且已結案（已簽核、已退回、已取消）的需求單，加上其所屬部門已結案的需求單；
 * 依簽核（或取消）時間由新到舊，預設最新 100 筆，可用狀態、關鍵字與台北日期範圍篩選。
 * @param {object} [store=dataStore] 需求單儲存。
 * @returns {Function} Express 非同步處理器。
 */
export function createCompletedTicketsHandler(store = dataStore) {
  /**
   * 處理 GET /api/tickets/completed?status=&q=&from=&to=&limit=。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應 { department, total, limit, tickets }。
   * @returns {Promise<void>}
   * @throws {HttpError} 400 查詢條件無效。
   */
  return async function completedTicketsHandler(req, res) {
    const conditions = parseCompletedQuery(req.query);
    const department = req.user.department;
    /**
     * 依簽核時間由新到舊排序。
     * @param {object} left 左側需求單。
     * @param {object} right 右側需求單。
     * @returns {number} 排序比較值。
     */
    function newestFirst(left, right) { return (right.decision?.at ?? right.updated_at).localeCompare(left.decision?.at ?? left.updated_at); }
    /**
     * 是否與憑證身分有關：提單人是本人，或送達部門是本人所屬部門。
     * @param {object} ticket 需求單。
     * @returns {boolean} 是否可見。
     */
    function visible(ticket) { return ticket.department_id === department.id || ticket.requester?.user_id === req.user.userID; }
    const matched = (await store.all()).filter((ticket) => visible(ticket) && matchesCompleted(ticket, conditions)).sort(newestFirst);
    res.set('Cache-Control', 'no-store');
    res.json({ department: { id: department.id, name: department.name }, total: matched.length, limit: conditions.limit, tickets: matched.slice(0, conditions.limit) });
  };
}

/**
 * 依需求單的需求類型取得 ledger 規格，交給儲存層在狀態改變時寫入額度異動紀錄
 * @param {object} registry 需求類型目錄
 * @param {object} ticket 需求單
 * @returns {object|null} ledger 規格；沒有 form、類型已不存在或類型沒有額度設定時為 null（不記錄）
 */
function ledgerSpecFor(registry, ticket) {
  return ticket?.form?.id ? registry.find(ticket.form.id)?.ledgerSpec ?? null : null;
}

/**
 * 建立簽核處理器：送達部門的成員可對「待簽核」的需求單簽核或退回，並可附最多 200 字備註。
 * 帶表單的需求單（ticket.form）依其需求類型定義的 workflow.approver 判斷提單人本人能否簽核或退回，核准時在同一筆交易內執行定義中 approve 階段的檢查。
 * 有額度的需求類型在同一筆交易內寫入一列額度異動紀錄（APPROVED 或 REJECTED，含前後剩餘）
 * @param {object} [store=dataStore] 需求單儲存。
 * @param {object} [types] 需求類型目錄；省略時使用預設目錄。
 * @returns {Function} Express 非同步處理器。
 */
export function createDecisionHandler(store = dataStore, types) {
  /**
   * 處理 POST /api/tickets/:id/decision。
   * @param {import('express').Request} req 已驗證請求，params.id 為單號，body 為 { action, comment }。
   * @param {import('express').Response} res 回應更新後的需求單 { ticket }。
   * @returns {Promise<void>}
   * @throws {HttpError} 400 欄位錯誤、403 不是送達部門成員或簽核自己的表單、404 查無需求單、409 已簽核過或定義的檢查未通過、503 儲存失敗。
   */
  return async function decisionHandler(req, res) {
    const action = req.body?.action;
    if (!Object.hasOwn(DECISIONS, action)) throw new HttpError(400, 'INVALID_PAYLOAD', 'action 必須是 APPROVE 或 REJECT');
    const comment = readComment(req.body?.comment);
    const user = req.user;
    /**
     * 檢查權限與狀態後套用簽核結果；檢查順序為部門 403 → 狀態 409 → 本人簽核 403（依需求類型定義，沒有需求類型的單一律不能由本人簽核）→ 定義的 approve 檢查 409。
     * @param {object} ticket 需求單複本。
     * @param {object} helpers 交易內的 ledger 查詢。
     * @returns {object} 更新後的需求單。
     * @throws {HttpError} 403 或 409。
     */
    function apply(ticket, helpers) {
      if (ticket.department_id !== user.department.id) throw new HttpError(403, 'FORBIDDEN', '只有送達部門的成員可以簽核這張需求單');
      if (ticket.status !== 'PENDING') throw new HttpError(409, 'TICKET_ALREADY_DECIDED', ticket.status === 'CANCELLED' ? '這張需求單已經取消' : '這張需求單已經簽核過');
      assertApproval({ types: types ?? getRequestTypes(), ticket, user, action, helpers });
      const now = new Date().toISOString();
      ticket.status = DECISIONS[action];
      ticket.updated_at = now;
      ticket.decision = { by_user_id: user.userID, by_username: user.username, at: now, comment };
      ticket.history.push({ at: now, event: DECISIONS[action], by_user_id: user.userID, by_username: user.username, ...(comment ? { comment } : {}) });
      return ticket;
    }
    const ticket = await store.update(String(req.params.id), apply, { ledgerSpecOf: (current) => ledgerSpecFor(types ?? getRequestTypes(), current) });
    logger('info', 'ticket.decided', { status: ticket.status, departmentId: ticket.department_id });
    res.set('Cache-Control', 'no-store');
    res.json({ ticket });
  };
}

/**
 * 建立取消處理器：提單人可取消自己「待簽核」的需求單；送達部門的成員也可替提單人取消，但必須填原因。
 * 取消後狀態為 CANCELLED，記錄保留在「已完成」清單，不刪除資料；有額度的需求類型同時寫入一列額度異動紀錄（釋放的時數與前後剩餘）
 * @param {object} [store=dataStore] 需求單儲存。
 * @param {object} [types] 需求類型目錄（查需求單類型的 ledger 規格）；省略時使用預設目錄
 * @returns {Function} Express 非同步處理器。
 */
export function createCancelHandler(store = dataStore, types) {
  /**
   * 處理 POST /api/tickets/:id/cancel。
   * @param {import('express').Request} req 已驗證請求，params.id 為單號，body 為 { comment? }。
   * @param {import('express').Response} res 回應更新後的需求單 { ticket }。
   * @returns {Promise<void>}
   * @throws {HttpError} 400 備註無效或部門取消未填原因、403 既不是提單人也不是送達部門成員、404 查無需求單、409 已簽核或已取消、503 儲存失敗。
   */
  return async function cancelHandler(req, res) {
    const comment = readComment(req.body?.comment);
    const user = req.user;
    /**
     * 判斷身分並套用取消。
     * @param {object} ticket 需求單複本。
     * @returns {object} 更新後的需求單。
     * @throws {HttpError} 400、403 或 409。
     */
    function apply(ticket) {
      const isRequester = ticket.requester?.user_id === user.userID;
      const isDepartment = ticket.department_id === user.department.id;
      if (!isRequester && !isDepartment) throw new HttpError(403, 'FORBIDDEN', '只有提單人或送達部門的成員可以取消這張需求單');
      if (ticket.status !== 'PENDING') throw new HttpError(409, 'TICKET_ALREADY_DECIDED', '這張需求單已經簽核或取消，不能再取消');
      const role = isRequester ? 'REQUESTER' : 'DEPARTMENT';
      if (role === 'DEPARTMENT' && !comment) throw new HttpError(400, 'INVALID_PAYLOAD', '替提單人取消時必須填寫原因');
      const now = new Date().toISOString();
      ticket.status = 'CANCELLED';
      ticket.updated_at = now;
      ticket.decision = { by_user_id: user.userID, by_username: user.username, at: now, comment, cancelled_by: role };
      ticket.history.push({ at: now, event: 'CANCELLED', by_user_id: user.userID, by_username: user.username, cancelled_by: role, ...(comment ? { comment } : {}) });
      return ticket;
    }
    const ticket = await store.update(String(req.params.id), apply, { ledgerSpecOf: (current) => ledgerSpecFor(types ?? getRequestTypes(), current) });
    logger('info', 'ticket.cancelled', { cancelledBy: ticket.decision.cancelled_by, departmentId: ticket.department_id });
    res.set('Cache-Control', 'no-store');
    res.json({ ticket });
  };
}

/**
 * 建立轉單處理器：送達部門的成員可把「待簽核」的需求單轉到其他部門（可指定該部門的處理人），狀態維持待簽核。
 * 用於 AI 判斷錯誤或指定錯處理人時，由接到單的部門自行改派；轉單後只有新部門的成員可以處理。
 * @param {object} [store=dataStore] 需求單儲存。
 * @param {object} [departments=departmentService] 部門查詢服務。
 * @param {object} [accounts=accountService] 帳號查詢服務（處理人名單）。
 * @param {object} [types] 需求類型目錄；省略時使用預設目錄。
 * @returns {Function} Express 非同步處理器。
 */
export function createTransferHandler(store = dataStore, departments = departmentService, accounts = accountService, types) {
  /**
   * 處理 POST /api/tickets/:id/transfer。
   * @param {import('express').Request} req 已驗證請求，params.id 為單號，body 為 { department_id, handler_id?, comment? }。
   * @param {import('express').Response} res 回應更新後的需求單 { ticket }。
   * @returns {Promise<void>}
   * @throws {HttpError} 400 欄位錯誤或目標與目前部門相同、403 不是送達部門成員、404 查無需求單、409 已簽核過或需求類型定義不允許轉單、503 儲存失敗。
   */
  return async function transferHandler(req, res) {
    const targetId = req.body?.department_id;
    const target = typeof targetId === 'string' ? departments.findDepartment(targetId) : null;
    if (!target) throw new HttpError(400, 'INVALID_PAYLOAD', '轉單的目標部門不存在');
    const handlerId = req.body?.handler_id;
    if (!(handlerId === undefined || handlerId === null || typeof handlerId === 'string')) throw new HttpError(400, 'INVALID_PAYLOAD', 'handler_id 必須是字串或 null');
    let handler = null;
    if (handlerId) {
      const found = accounts.findHandler(handlerId);
      if (!found) throw new HttpError(400, 'INVALID_PAYLOAD', '指定的處理人不存在');
      if (found.department.id !== target.id) throw new HttpError(400, 'INVALID_PAYLOAD', '指定的處理人不屬於目標部門');
      handler = { id: found.handler.id, name: found.handler.name };
    }
    const comment = readComment(req.body?.comment);
    const user = req.user;
    /**
     * 檢查權限與狀態後改派部門與處理人，並寫入轉單歷程；有需求類型的單（form 或 request_type）依其定義的 workflow.transfer 判斷能否轉出。
     * @param {object} ticket 需求單複本。
     * @returns {object} 更新後的需求單。
     * @throws {HttpError} 400 目標相同、403、409 TICKET_ALREADY_DECIDED 或定義的 transfer_error（預設 FORM_TICKET_LOCKED）。
     */
    function apply(ticket) {
      if (ticket.department_id !== user.department.id) throw new HttpError(403, 'FORBIDDEN', '只有送達部門的成員可以轉這張需求單');
      if (ticket.status !== 'PENDING') throw new HttpError(409, 'TICKET_ALREADY_DECIDED', ticket.status === 'CANCELLED' ? '這張需求單已經取消' : '這張需求單已經簽核過');
      assertTransfer({ types: types ?? getRequestTypes(), ticket });
      if (ticket.department_id === target.id) throw new HttpError(400, 'INVALID_PAYLOAD', '轉單的目標部門必須不同於目前部門');
      const now = new Date().toISOString();
      const from = { department_id: ticket.department_id, department_name: ticket.department_name };
      ticket.department_id = target.id;
      ticket.department_name = target.name;
      ticket.handler = handler;
      ticket.updated_at = now;
      ticket.history.push({ at: now, event: 'TRANSFERRED', by_user_id: user.userID, by_username: user.username,
        from_department_id: from.department_id, from_department_name: from.department_name, to_department_id: target.id, to_department_name: target.name,
        ...(handler ? { to_handler_name: handler.name } : {}), ...(comment ? { comment } : {}) });
      return ticket;
    }
    const ticket = await store.update(String(req.params.id), apply);
    logger('info', 'ticket.transferred', { fromDepartmentId: user.department.id, toDepartmentId: target.id, withHandler: Boolean(handler) });
    res.set('Cache-Control', 'no-store');
    res.json({ ticket });
  };
}

export const submitTicket = createTicketHandler();
export const listMyTickets = createMyTicketsHandler();
export const listDepartmentTickets = createDepartmentTicketsHandler();
export const listCompletedTickets = createCompletedTicketsHandler();
export const decideTicket = createDecisionHandler();
export const transferTicket = createTransferHandler();
export const cancelTicket = createCancelHandler();
