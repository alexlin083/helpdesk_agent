import { HttpError } from '../../middleware/errorHandler.js';
import { DEFAULT_TIMEZONE_OFFSET, localToday } from '../../utils/dates.js';
import { approvalFailure, evaluateForm, labelsOf, parseFormInput, renderContent } from './evaluator.js';
import { isPlainObject } from './fieldTypes.js';

const DEFAULT_SELF_APPROVAL = '不能簽核自己提出的需求單';

/**
 * 驗證送出時附帶的 form（POST /api/tickets 的 form）：必須是物件、id 為現有需求類型、version 與目前定義相同，fields 依定義嚴格解析。
 * @param {unknown} raw 請求本文的 form。
 * @param {object} types 需求類型目錄。
 * @returns {{type: object, input: Record<string, string>}} 需求類型與整理後的欄位值。
 * @throws {HttpError} 400 INVALID_PAYLOAD（格式、類型不存在、欄位錯誤）、409 FORM_VERSION_CHANGED。
 */
export function parseFormSubmission(raw, types) {
  if (!isPlainObject(raw)) throw new HttpError(400, 'INVALID_PAYLOAD', 'form 必須是物件');
  const type = types.find(raw.id);
  if (!type) throw new HttpError(400, 'INVALID_PAYLOAD', '找不到指定的需求類型');
  if (raw.version !== type.version) throw new HttpError(409, 'FORM_VERSION_CHANGED', '需求類型的定義已更新，請重新按「自動生成」確認');
  return { type, input: parseFormInput(raw.fields, type) };
}

/**
 * 決定送達部門：類型有固定部門時為該部門（忽略請求的 department_id）；否則請求必須帶存在的 department_id。
 * @param {object} type 需求類型。
 * @param {unknown} departmentId 請求本文的 department_id。
 * @param {object} departments 部門查詢服務。
 * @returns {object} 部門。
 * @throws {HttpError} 400 INVALID_PAYLOAD：型別不符、缺少或部門不存在。
 */
export function submissionDepartment(type, departmentId, departments) {
  if (type.departmentId) return departments.findDepartment(type.departmentId);
  if (!(departmentId === undefined || departmentId === null || typeof departmentId === 'string')) throw new HttpError(400, 'INVALID_PAYLOAD', 'department_id 必須是字串或 null');
  if (!departmentId) throw new HttpError(400, 'INVALID_PAYLOAD', '這個需求類型需要指定處理部門（department_id）');
  const department = departments.findDepartment(departmentId);
  if (!department) throw new HttpError(400, 'INVALID_PAYLOAD', '指定的部門不存在');
  return department;
}

/**
 * 驗證指定處理人（選填）：需求類型沒有 handler 設定時不接受指定處理人（目前所有類型都沒有設定，提出需求單頁也已不提供）；
 * 有設定時必須是送達部門的一般帳號，handler.not_self 為 true 時不能是提單人本人。
 * @param {object} options 參數。
 * @param {object} options.type 需求類型。
 * @param {string|null|undefined} options.handlerId 請求的 handler_id。
 * @param {object} options.department 送達部門。
 * @param {object} options.user 憑證身分。
 * @param {object} options.accounts 帳號查詢服務（findHandler）。
 * @returns {{id: string, name: string}|null} 處理人；未指定時 null。
 * @throws {HttpError} 400 INVALID_PAYLOAD：類型不提供指定處理人、處理人不存在、不屬於部門或是本人。
 */
export function submissionHandler({ type, handlerId, department, user, accounts }) {
  if (!handlerId) return null;
  if (!type.handler) throw new HttpError(400, 'INVALID_PAYLOAD', `「${type.name}」不提供指定處理人`);
  const found = accounts.findHandler(handlerId);
  if (!found) throw new HttpError(400, 'INVALID_PAYLOAD', '指定的處理人不存在');
  if (found.department.id !== department.id) throw new HttpError(400, 'INVALID_PAYLOAD', `指定的處理人不屬於「${department.name}」`);
  if (type.handler?.notSelf && found.handler.id === user.username) throw new HttpError(400, 'INVALID_PAYLOAD', '指定處理人不能是提單人本人');
  return { id: found.handler.id, name: found.handler.name };
}

/**
 * 建立送出時在 IMMEDIATE 寫入交易內執行的檢查（與寫入同一筆交易，避免兩張單同時通過額度或重疊檢查）。依序：
 * 1. 以 submit 階段驗證欄位與計算：缺必填 400「表單還缺少：…」、格式不符 400（第一個錯誤訊息，例如帳號在期間內已有申請）；
 * 2. 依定義重新產生固定文字，content 必須包含這段文字（換行統一為 \n 後比對），否則 400；
 * 3. submit 階段的 checks：第一個失敗以定義的 error.code 回 409；
 * 通過後呼叫 onAccepted 交出驗證結果（供呼叫端在同一筆交易內補上要保存的表單資料）。
 * @param {object} options 參數。
 * @param {object} options.type 需求類型。
 * @param {Record<string, string>} options.input 已整理的欄位值。
 * @param {object} options.user 憑證身分。
 * @param {{id: string, name: string}} options.department 送達部門。
 * @param {{id: string, name: string}|null} options.handler 指定處理人。
 * @param {string} options.content 已驗證的需求內容。
 * @param {object} options.types 需求類型目錄。
 * @param {object} options.accounts 帳號查詢服務。
 * @param {object} options.departments 部門查詢服務。
 * @param {Function} options.clock 時間來源（今天）。
 * @param {(evaluation: object) => void} options.onAccepted 通過時的回呼，收到 evaluateForm 的結果。
 * @returns {(helpers: object) => void} 交給 dataStore.insert 的 guard。
 */
export function submissionGuard({ type, input, user, department, handler, content, types, accounts, departments, clock, onAccepted }) {
  /**
   * 在交易內驗證並檢查；失敗時拋錯讓交易回滾。
   * @param {object} helpers 交易內的 ledger 查詢。
   * @returns {void}
   * @throws {HttpError} 400 或 409。
   */
  return function guard(helpers) {
    const today = localToday(clock(), type.timezoneOffset ?? DEFAULT_TIMEZONE_OFFSET).date;
    const departmentRef = { id: department.id, name: department.name };
    const evaluation = evaluateForm({ type, input, user, department: departmentRef, registry: types, accounts, departments, helpers, today, phase: 'submit' });
    if (evaluation.missing.length) throw new HttpError(400, 'INVALID_PAYLOAD', `表單還缺少：${labelsOf(type, evaluation.missing).join('、')}`);
    if (evaluation.invalid.length) throw new HttpError(400, 'INVALID_PAYLOAD', evaluation.invalid[0].message);
    const rendered = renderContent(type, { values: evaluation.values, computedMap: evaluation.computedMap, department: departmentRef, handler, departments });
    if (!content.replace(/\r\n?/gu, '\n').includes(rendered)) throw new HttpError(400, 'INVALID_PAYLOAD', '需求內容與表單資料不一致，請重新按「自動生成」確認');
    const [failure] = evaluation.failures;
    if (failure) throw new HttpError(409, failure.code, failure.message);
    onAccepted(evaluation);
  };
}

/**
 * 組出保存在需求單的表單資料：id、version、name、欄位值、計算結果、欄位與計算的名稱快照，有 ledger 時另存類別、數量、期間（與起訖）快照，
 * 讓之後定義改版時舊需求單仍能顯示與計算額度。
 * @param {object} type 需求類型。
 * @param {object} evaluation evaluateForm 的結果。
 * @returns {object} 表單資料。
 */
export function storedForm(type, evaluation) {
  const labels = {};
  for (const field of type.fields) labels[field.key] = field.label;
  for (const computation of type.computations) labels[computation.key] = computation.label;
  return { id: type.id, version: type.version, name: type.name, fields: evaluation.values, computed: evaluation.computedMap, labels,
    ...(evaluation.ledger ? { ledger: evaluation.ledger } : {}) };
}

/**
 * 取得需求單所屬的需求類型 id：FORM 單取保存的 form.id，依需求類型送出的 DEPARTMENT 單（例如一般需求）取 request_type.id；
 * 舊流程（只帶 department_id、指定處理人或 AI 判斷）建立的單沒有需求類型，回傳 null。
 * @param {object} ticket 需求單。
 * @returns {string|null} 需求類型 id。
 */
export function ticketTypeId(ticket) {
  return ticket.form?.id ?? ticket.request_type?.id ?? null;
}

/**
 * 簽核交易內的規則（在「送達部門成員」與「狀態為待簽核」檢查之後）：依需求單所屬需求類型（見 ticketTypeId）的 workflow.approver
 * 判斷提單人本人能否簽核或退回；沒有需求類型或定義已不在目錄時一律視為不能（提單人不能簽核自己的單）。
 * 核准時另對帶 form 的單執行 on 包含 approve 的檢查。
 * @param {object} options 參數。
 * @param {object} options.types 需求類型目錄。
 * @param {object} options.ticket 需求單複本。
 * @param {object} options.user 憑證身分。
 * @param {'APPROVE'|'REJECT'} options.action 動作。
 * @param {object} options.helpers 交易內的 ledger 查詢。
 * @returns {void}
 * @throws {HttpError} 403 FORBIDDEN（本人簽核，訊息取自定義的 approver.message，沒有時為「不能簽核自己提出的需求單」）、409（定義的檢查錯誤代碼）。
 */
export function assertApproval({ types, ticket, user, action, helpers }) {
  const typeId = ticketTypeId(ticket);
  const type = typeId ? types.find(typeId) : null;
  const notRequester = type ? type.workflow.approver.notRequester : true;
  if (notRequester && ticket.requester?.user_id === user.userID) throw new HttpError(403, 'FORBIDDEN', type?.workflow.approver.message ?? DEFAULT_SELF_APPROVAL);
  if (type && ticket.form && action === 'APPROVE') {
    const failure = approvalFailure(type, ticket, helpers);
    if (failure) throw new HttpError(409, failure.code, failure.message);
  }
}

/**
 * 轉單規則（在「送達部門成員」與「狀態為待簽核」檢查之後）：有需求類型的單（見 ticketTypeId）依其 workflow.transfer 判斷能否轉出，
 * 不能時以定義的 transfer_error 回 409（沒有設定時為 FORM_TICKET_LOCKED）。定義已不在目錄時，帶 form 的單不能轉出、其他單可以；
 * 沒有需求類型的舊流程單可以轉出。
 * @param {object} options 參數。
 * @param {object} options.types 需求類型目錄。
 * @param {object} options.ticket 需求單複本。
 * @returns {void}
 * @throws {HttpError} 409 不能轉單。
 */
export function assertTransfer({ types, ticket }) {
  const typeId = ticketTypeId(ticket);
  if (!typeId) return;
  const type = types.find(typeId);
  if (type ? type.workflow.transfer : !ticket.form) return;
  const error = type?.workflow.transferError ?? { code: 'FORM_TICKET_LOCKED', message: `固定表單的需求單由「${ticket.department_name}」處理，不能轉單` };
  throw new HttpError(409, error.code, error.message);
}
