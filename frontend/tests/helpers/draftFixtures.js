import { normalizeDraftResponse } from '../../src/services/draftService.js';

// 「自動生成」測試共用的假資料：帳號、部門、需求類型定義與時數都是測試用的虛構值，不對應實際環境。
// 前端程式不認得任何特定需求類型；這裡的請假、一般需求、設備申請只是模擬後端定義檔產生的回應形狀。
export const HR = { id: 'dept-hr-test', name: '測試人資部' };
export const IT = { id: 'dept-it-test', name: '測試資訊部' };
export const GA = { id: 'dept-ga-test', name: '測試總務組' };
export const DEPARTMENT_OPTIONS = [HR, IT, GA];
export const HR_HANDLERS = [{ id: 'u-hr-a', name: 'hana.test' }, { id: 'u-hr-b', name: 'hugo.test' }];

// 模擬 leave.json（version 2）在 GET /api/forms 與草稿回應中的欄位定義。
export const LEAVE_TYPE = {
  id: 'leave', version: 2, name: '請假申請',
  fields: [
    { key: 'applicant', label: '請假人', type: 'self' },
    { key: 'leave_type', label: '假別', type: 'enum', options: ['事假', '病假', '特休'], required: true },
    { key: 'start_at', label: '請假起始時間', type: 'datetime', required: true },
    { key: 'end_at', label: '請假截止時間', type: 'datetime', required: true },
    { key: 'agent', label: '代理人', type: 'account', required: true },
    { key: 'note', label: '備註', type: 'text', max_length: 200 },
  ],
};
// 模擬 general.json：沒有固定部門，只有需求說明。
export const GENERAL_TYPE = { id: 'general', version: 1, name: '一般需求', fields: [{ key: 'description', label: '需求說明', type: 'text', required: true, max_length: 1000 }] };
// 模擬 equipment.json：固定送總務組，含數字與日期欄位。
export const EQUIPMENT_TYPE = {
  id: 'equipment', version: 1, name: '設備申請', department: GA,
  fields: [
    { key: 'applicant', label: '申請人', type: 'self' },
    { key: 'item', label: '設備品項', type: 'text', required: true, max_length: 50 },
    { key: 'quantity', label: '數量', type: 'number', required: true, min: 1, max: 50, integer: true },
    { key: 'purpose', label: '用途說明', type: 'text', required: true, max_length: 200 },
    { key: 'needed_by', label: '需要日期', type: 'date', required: true },
    { key: 'location', label: '送交地點', type: 'text', required: true, max_length: 50 },
  ],
};
export const AGENTS = [
  { id: 'kevin.test', name: 'kevin.test', available: true },
  { id: 'lisa.test', name: 'lisa.test', available: false, reason: '此期間也有請假' },
];
export const GREETING = 'tina.test 你好，這邊已經收到你想要請假的需求，根據您的需求您的業務將會由測試人資部進行處理';
export const PROMPT = '還需要：假別、請假起始時間、請假截止時間、代理人';
export const RENDERED = '[請假人]: tina.test\n[請假日期]: 2026-12-01（週二）\n[請假起始時間]: 09:30\n[請假截止時間]: 17:30\n[假別]: 事假\n[請假時數]: 7 小時 0 分鐘\n[代理人]: kevin.test\n[備註]: 無';
export const EMPTY_LEAVE_VALUES = { applicant: 'tina.test', leave_type: '', start_at: '', end_at: '', agent: '', note: '' };
export const FILLED_LEAVE_VALUES = { applicant: 'tina.test', leave_type: '事假', start_at: '2026-12-01T09:30', end_at: '2026-12-01T17:30', agent: 'kevin.test', note: '' };
export const LEAVE_MINUTES = { key: 'minutes', label: '請假時數', value: 420, text: '7 小時 0 分鐘' };
export const LEAVE_SUMMARY = '事假剩餘時數：112 小時 → 105 小時';

/**
 * 組出請假類型、尚未填寫的草稿回應（後端 JSON 形狀）；部門由類型固定，來源為 system。
 * @param {object} [overrides={}] 要覆寫的欄位。
 * @returns {object} POST /api/tickets/draft 的回應本文。
 */
export function leaveResponse(overrides = {}) {
  return {
    intent: '請假申請', type: LEAVE_TYPE, department: HR, department_options: DEPARTMENT_OPTIONS, handler: null, handler_options: HR_HANDLERS,
    values: { ...EMPTY_LEAVE_VALUES }, sources: { applicant: 'system', department_id: 'system' }, missing: ['leave_type', 'start_at', 'end_at', 'agent'], invalid: [],
    field_options: { agent: AGENTS }, computed: [], summaries: [], reply: GREETING, prompt: PROMPT, ai_available: true, complete: false, rendered_content: null,
    tools_used: [], ...overrides,
  };
}

/**
 * 組出請假類型、全部欄位已完成的草稿回應（後端 JSON 形狀），含後端計算的時數與額度摘要。
 * @param {object} [overrides={}] 要覆寫的欄位。
 * @returns {object} POST /api/tickets/draft 的回應本文。
 */
export function completeLeaveResponse(overrides = {}) {
  return leaveResponse({
    values: { ...FILLED_LEAVE_VALUES }, sources: { applicant: 'system', department_id: 'system', leave_type: 'ai', start_at: 'ai', end_at: 'ai', agent: 'ai' }, missing: [],
    computed: [LEAVE_MINUTES], summaries: [LEAVE_SUMMARY], tools_used: ['colleagues', 'my_leave_balance'],
    reply: '已整理好請假內容，請確認右側欄位', prompt: '欄位都已確認，可以按 Apply 套用', complete: true, rendered_content: RENDERED, ...overrides,
  });
}

/**
 * 組出一般需求類型（沒有固定部門）的草稿回應（後端 JSON 形狀），含後端依 render 產生的即時預覽。
 * @param {object} [overrides={}] 要覆寫的欄位。
 * @returns {object} POST /api/tickets/draft 的回應本文。
 */
export function generalResponse(overrides = {}) {
  return {
    intent: '一般需求', type: GENERAL_TYPE, department: null, department_options: DEPARTMENT_OPTIONS, handler: null, handler_options: [],
    values: { description: '' }, sources: {}, missing: ['description', 'department_id'], invalid: [], field_options: {}, computed: [], summaries: [],
    reply: 'tina.test 你好，請描述你的需求，並確認處理部門', prompt: '還需要：需求說明、處理部門', ai_available: true, complete: false, rendered_content: null,
    preview_content: '[需求說明]: \n[處理部門]: \n[指定處理人]: 未指定', ...overrides,
  };
}

// 一般需求完成時的需求說明與後端整理的內容（測試用虛構文字）。
export const GENERAL_DESCRIPTION = '筆電開機要五分鐘';
export const GENERAL_RENDERED = '[需求說明]: 筆電開機要五分鐘\n[處理部門]: 測試資訊部';

/**
 * 組出一般需求類型、需求說明與處理部門都已確認的草稿回應（後端 JSON 形狀）：部門為測試資訊部、不指定處理人、可直接按 Apply。
 * 適合只想先「套用一次」再驗證送出流程（驗證、倒數、錯誤處理）的測試；部門不由類型固定，送出時會帶 departmentId。
 * 因為帶有需求類型（送出時會帶 form），套用後的需求內容必須保留 GENERAL_RENDERED，只能在前後補充文字；
 * 傳入 { type: null } 可模擬沒有需求類型表單的草稿（送出不帶 form，需求內容可自由編輯）。
 * @param {object} [overrides={}] 要覆寫的欄位，例如 handler 與 handler_options（模擬對話中指定處理人）或 type。
 * @returns {object} POST /api/tickets/draft 的回應本文。
 */
export function completeGeneralResponse(overrides = {}) {
  return generalResponse({ department: IT, values: { description: GENERAL_DESCRIPTION }, missing: [], complete: true, rendered_content: GENERAL_RENDERED,
    preview_content: GENERAL_RENDERED, ...overrides });
}

/**
 * 建立「自動生成」草稿服務替身：記錄每次請求本文，並把 responder 回傳的後端 JSON 經 normalizeDraftResponse 整理後回傳，不連網路。
 * @param {Function} [responder=completeGeneralResponse] 依請求本文回傳後端 JSON 的函式 (input) => object。
 * @param {Array<object>} [calls=[]] 記錄請求本文（深拷貝）的陣列，測試可檢查送出的內容。
 * @returns {Function} 可注入 initProposePage 的 requestDraft 替身，回傳 Promise<object>（整理後的草稿）。
 */
export function fakeRequestDraft(responder = completeGeneralResponse, calls = []) {
  /**
   * 草稿替身：記錄請求並回傳整理後的回應。
   * @param {object} input 草稿請求本文。
   * @returns {Promise<object>} normalizeDraftResponse 整理後的草稿。
   */
  async function requestDraft(input) { calls.push(structuredClone(input)); return normalizeDraftResponse(responder(input)); }
  return requestDraft;
}

/**
 * 在提出需求單頁按「自動生成」、等待草稿整理完成後按 Apply，模擬使用者套用整理好的內容。
 * 主題必須已透過 input 事件填入（「自動生成」按鈕才會啟用）；需求內容原本有文字時 Apply 只會顯示取代／附加選擇，需由呼叫端再點選。
 * @param {object} nodes buildProposeDom 回傳的頁面節點（需含 draftButton 與 draftNodes）。
 * @param {object} page initProposePage 回傳的頁面控制器（需含 draftDialog）。
 * @returns {Promise<void>} 點下 Apply 並處理完成。
 */
export async function openAndApply(nodes, page) {
  await nodes.draftButton.click();
  await tick();
  await page.draftDialog.settled();
  await nodes.draftNodes.apply.click();
}

/**
 * 在提出需求單頁填入主題（觸發 input 事件以啟用「自動生成」按鈕），再按「自動生成」並套用，完成送出前必要的步驟。
 * @param {object} nodes buildProposeDom 回傳的頁面節點。
 * @param {object} page initProposePage 回傳的頁面控制器。
 * @param {string} subject 要填入的主題。
 * @returns {Promise<void>} 套用完成。
 */
export async function fillAndApply(nodes, page, subject) {
  nodes.subject.value = subject;
  await nodes.subject.dispatch('input');
  await openAndApply(nodes, page);
}

/**
 * 組出設備申請類型（固定部門由 type.department 提供，沒有 department_id 來源）的草稿回應（後端 JSON 形狀）。
 * @param {object} [overrides={}] 要覆寫的欄位。
 * @returns {object} POST /api/tickets/draft 的回應本文。
 */
export function equipmentResponse(overrides = {}) {
  return {
    intent: '設備申請', type: EQUIPMENT_TYPE, department: GA, department_options: DEPARTMENT_OPTIONS, handler: null, handler_options: [],
    values: { applicant: 'tina.test', item: '', quantity: '', purpose: '', needed_by: '', location: '' }, sources: { applicant: 'system' },
    missing: ['item', 'quantity', 'purpose', 'needed_by', 'location'], invalid: [], field_options: {}, computed: [], summaries: [],
    reply: 'tina.test 你好，設備申請將由測試總務組處理', prompt: '還需要：設備品項、數量、用途說明、需要日期、送交地點', ai_available: true, complete: false, rendered_content: null,
    ...overrides,
  };
}

/**
 * 建立可控制完成時機的 Promise。
 * @returns {{promise: Promise<unknown>, resolve: Function, reject: Function}} Promise 與它的 resolve、reject。
 */
export function deferred() {
  let resolve;
  let reject;
  /**
   * 保存 Promise 的 resolve 與 reject。
   * @param {Function} ok 完成函式。
   * @param {Function} fail 失敗函式。
   * @returns {void}
   */
  function executor(ok, fail) { resolve = ok; reject = fail; }
  const promise = new Promise(executor);
  return { promise, resolve, reject };
}

/**
 * 等待一輪計時器（讓 0 毫秒的驗證計時器觸發）與微任務。
 * @returns {Promise<void>}
 */
export function tick() {
  /**
   * 在下一輪計時器完成 Promise。
   * @param {Function} resolve 完成函式。
   * @returns {void}
   */
  function wait(resolve) { setTimeout(resolve, 0); }
  return new Promise(wait);
}
