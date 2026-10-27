import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler.js';
import { departmentService } from '../services/departmentService.js';
import { accountService } from '../services/accountService.js';
import { judgeTicket } from '../services/ticketJudge.js';
import { ticketStore } from '../services/ticketStore.js';
import { usageService } from '../services/usageService.js';
import { chatTasks } from '../services/chatTasks.js';
import { logger } from '../utils/logger.js';

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
 * 解析並驗證「已完成」查詢的條件：狀態、關鍵字、台北日期範圍與筆數上限。
 * @param {object} query Express 解析後的查詢參數。
 * @returns {{status: string, keyword: string, from: string, to: string, limit: number}} 已驗證的條件。
 * @throws {HttpError} 400 INVALID_PAYLOAD。
 */
export function parseCompletedQuery(query = {}) {
  const status = typeof query.status === 'string' && query.status ? query.status : '';
  if (status && !COMPLETED_STATUSES.includes(status)) throw new HttpError(400, 'INVALID_PAYLOAD', 'status 必須是 APPROVED、REJECTED 或 CANCELLED');
  const keyword = typeof query.q === 'string' ? query.q.trim() : '';
  if (Array.from(keyword).length > LIMITS.keyword) throw new HttpError(400, 'INVALID_PAYLOAD', `q 最多 ${LIMITS.keyword} 字元`);
  const from = typeof query.from === 'string' && query.from ? query.from : '';
  const to = typeof query.to === 'string' && query.to ? query.to : '';
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value && (!DATE_PATTERN.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)))) throw new HttpError(400, 'INVALID_PAYLOAD', `${name} 必須是 YYYY-MM-DD 的日期`);
  }
  if (from && to && from > to) throw new HttpError(400, 'INVALID_PAYLOAD', 'from 不可晚於 to');
  let limit = COMPLETED_DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== '') {
    limit = Number(query.limit);
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
 * 建立需求單處理器；指定處理人時直接送達並保存，沒有指定時才預扣用量、呼叫 Gemini 判斷部門，再保存需求單。
 * 處理人就是登入帳號（handler_id 為帳號名稱），由帳號服務查詢所屬部門。
 * @param {object} [options={}] 可注入的依賴，供測試使用替身。
 * @param {object} [options.departments=departmentService] 部門查詢服務。
 * @param {object} [options.accounts=accountService] 帳號查詢服務（處理人名單）。
 * @param {Function} [options.judge=judgeTicket] 部門判斷函式。
 * @param {object} [options.store=ticketStore] 需求單儲存。
 * @param {object} [options.usage=usageService] 配額服務。
 * @param {object} [options.tasks=chatTasks] 工作追蹤器，關機時等待既有需求單處理完成。
 * @returns {Function} Express 非同步處理器。
 */
export function createTicketHandler({ departments = departmentService, accounts = accountService, judge = judgeTicket, store = ticketStore, usage = usageService, tasks = chatTasks } = {}) {
  /**
   * 處理一張需求單：① 憑證 → ② 欄位 → ③ 指定處理人（直接保存並回應）；未指定 → ④ 預扣用量 → ⑤ 判斷部門 → ⑥ 分流 → ⑦ 保存需求單 → ⑧ 回應並釋放租約。
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
 * 建立部門名單處理器；部門取自部門設定檔，每個部門的處理人（handlers）為該部門的登入帳號；不呼叫 Gemini、不扣額度。
 * @param {object} [departments=departmentService] 部門查詢服務。
 * @param {object} [accounts=accountService] 帳號查詢服務。
 * @returns {Function} Express 處理器。
 */
export function createDepartmentsHandler(departments = departmentService, accounts = accountService) {
  /**
   * 回傳部門與處理人名單（id、name、type、duty、business、handlers）。
   * @param {import('express').Request} req 已驗證請求。
   * @param {import('express').Response} res 回應。
   * @returns {void}
   */
  return function departmentsHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ departments: departments.list().map((department) => ({ ...department, handlers: accounts.handlersOf(department.id) })) });
  };
}

/**
 * 建立「我的需求單」處理器：回傳憑證身分提出的所有需求單，最新的在前。
 * @param {object} [store=ticketStore] 需求單儲存。
 * @returns {Function} Express 非同步處理器。
 */
export function createMyTicketsHandler(store = ticketStore) {
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
 * @param {object} [store=ticketStore] 需求單儲存。
 * @returns {Function} Express 非同步處理器。
 */
export function createDepartmentTicketsHandler(store = ticketStore) {
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
 * 讀取並驗證簽核或轉單的備註：可省略，字串去除首尾空白後最多 200 字。
 * @param {unknown} raw 請求本文的 comment。
 * @returns {string} 去除首尾空白後的備註，省略時為空字串。
 * @throws {HttpError} 400 INVALID_PAYLOAD。
 */
function readComment(raw) {
  if (!(raw === undefined || raw === null || typeof raw === 'string')) throw new HttpError(400, 'INVALID_PAYLOAD', 'comment 必須是字串');
  const comment = typeof raw === 'string' ? raw.trim() : '';
  if (Array.from(comment).length > LIMITS.comment) throw new HttpError(400, 'INVALID_PAYLOAD', `comment 最多 ${LIMITS.comment} 字元`);
  return comment;
}

/**
 * 建立「已完成」處理器：回傳憑證身分提出且已結案（已簽核、已退回、已取消）的需求單，加上其所屬部門已結案的需求單；
 * 依簽核（或取消）時間由新到舊，預設最新 100 筆，可用狀態、關鍵字與台北日期範圍篩選。
 * @param {object} [store=ticketStore] 需求單儲存。
 * @returns {Function} Express 非同步處理器。
 */
export function createCompletedTicketsHandler(store = ticketStore) {
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
 * 建立簽核處理器：送達部門的成員可對「待簽核」的需求單簽核或退回，並可附最多 200 字備註。
 * @param {object} [store=ticketStore] 需求單儲存。
 * @returns {Function} Express 非同步處理器。
 */
export function createDecisionHandler(store = ticketStore) {
  /**
   * 處理 POST /api/tickets/:id/decision。
   * @param {import('express').Request} req 已驗證請求，params.id 為單號，body 為 { action, comment }。
   * @param {import('express').Response} res 回應更新後的需求單 { ticket }。
   * @returns {Promise<void>}
   * @throws {HttpError} 400 欄位錯誤、403 不是送達部門成員、404 查無需求單、409 已簽核過、503 儲存失敗。
   */
  return async function decisionHandler(req, res) {
    const action = req.body?.action;
    if (!Object.hasOwn(DECISIONS, action)) throw new HttpError(400, 'INVALID_PAYLOAD', 'action 必須是 APPROVE 或 REJECT');
    const comment = readComment(req.body?.comment);
    const user = req.user;
    /**
     * 檢查權限與狀態後套用簽核結果。
     * @param {object} ticket 需求單複本。
     * @returns {object} 更新後的需求單。
     * @throws {HttpError} 403 或 409。
     */
    function apply(ticket) {
      if (ticket.department_id !== user.department.id) throw new HttpError(403, 'FORBIDDEN', '只有送達部門的成員可以簽核這張需求單');
      if (ticket.status !== 'PENDING') throw new HttpError(409, 'TICKET_ALREADY_DECIDED', ticket.status === 'CANCELLED' ? '這張需求單已經取消' : '這張需求單已經簽核過');
      const now = new Date().toISOString();
      ticket.status = DECISIONS[action];
      ticket.updated_at = now;
      ticket.decision = { by_user_id: user.userID, by_username: user.username, at: now, comment };
      ticket.history.push({ at: now, event: DECISIONS[action], by_user_id: user.userID, by_username: user.username, ...(comment ? { comment } : {}) });
      return ticket;
    }
    const ticket = await store.update(String(req.params.id), apply);
    logger('info', 'ticket.decided', { status: ticket.status, departmentId: ticket.department_id });
    res.set('Cache-Control', 'no-store');
    res.json({ ticket });
  };
}

/**
 * 建立取消處理器：提單人可取消自己「待簽核」的需求單；送達部門的成員也可替提單人取消，但必須填原因。
 * 取消後狀態為 CANCELLED，記錄保留在「已完成」清單，不刪除資料。
 * @param {object} [store=ticketStore] 需求單儲存。
 * @returns {Function} Express 非同步處理器。
 */
export function createCancelHandler(store = ticketStore) {
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
    const ticket = await store.update(String(req.params.id), apply);
    logger('info', 'ticket.cancelled', { cancelledBy: ticket.decision.cancelled_by, departmentId: ticket.department_id });
    res.set('Cache-Control', 'no-store');
    res.json({ ticket });
  };
}

/**
 * 建立轉單處理器：送達部門的成員可把「待簽核」的需求單轉到其他部門（可指定該部門的處理人），狀態維持待簽核。
 * 用於 AI 判斷錯誤或指定錯處理人時，由接到單的部門自行改派；轉單後只有新部門的成員可以處理。
 * @param {object} [store=ticketStore] 需求單儲存。
 * @param {object} [departments=departmentService] 部門查詢服務。
 * @param {object} [accounts=accountService] 帳號查詢服務（處理人名單）。
 * @returns {Function} Express 非同步處理器。
 */
export function createTransferHandler(store = ticketStore, departments = departmentService, accounts = accountService) {
  /**
   * 處理 POST /api/tickets/:id/transfer。
   * @param {import('express').Request} req 已驗證請求，params.id 為單號，body 為 { department_id, handler_id?, comment? }。
   * @param {import('express').Response} res 回應更新後的需求單 { ticket }。
   * @returns {Promise<void>}
   * @throws {HttpError} 400 欄位錯誤或目標與目前部門相同、403 不是送達部門成員、404 查無需求單、409 已簽核過、503 儲存失敗。
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
     * 檢查權限與狀態後改派部門與處理人，並寫入轉單歷程。
     * @param {object} ticket 需求單複本。
     * @returns {object} 更新後的需求單。
     * @throws {HttpError} 400 目標相同、403 或 409。
     */
    function apply(ticket) {
      if (ticket.department_id !== user.department.id) throw new HttpError(403, 'FORBIDDEN', '只有送達部門的成員可以轉這張需求單');
      if (ticket.status !== 'PENDING') throw new HttpError(409, 'TICKET_ALREADY_DECIDED', ticket.status === 'CANCELLED' ? '這張需求單已經取消' : '這張需求單已經簽核過');
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
export const listDepartments = createDepartmentsHandler();
export const listMyTickets = createMyTicketsHandler();
export const listDepartmentTickets = createDepartmentTicketsHandler();
export const listCompletedTickets = createCompletedTicketsHandler();
export const decideTicket = createDecisionHandler();
export const transferTicket = createTransferHandler();
export const cancelTicket = createCancelHandler();
