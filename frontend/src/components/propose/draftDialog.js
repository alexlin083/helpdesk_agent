import { element } from '../dom.js';
import { createDateTimeControl, layoutFields, periodLabel } from './dateTimeControl.js';
import { TicketServiceError, QUOTA_CODES, countCodePoints, TICKET_LIMITS } from '../../services/ticketService.js';
import { DRAFT_LIMITS } from '../../services/draftService.js';

// 會從後端 field_options 取得候選清單的欄位型別（帳號、部門）；其他型別的選項來自欄位定義本身。
const OPTION_FIELD_TYPES = new Set(['account', 'department']);
// 文字欄位的 max_length 超過這個字數（或沒有上限）時改用多行輸入。
const TEXTAREA_THRESHOLD = 100;
// 以日期時間選擇器（dateTimeControl.js）呈現的欄位型別。
const DATE_FIELD_TYPES = new Set(['date', 'datetime']);

export const DRAFT_TEXT = {
  send: '送出',
  sending: '整理中…',
  judging: '判斷中…',
  emptyMessage: '請先輸入要告訴助理的內容',
  noResult: '尚未取得整理結果，可在左側輸入訊息再試一次，或直接在右側欄位填寫',
  noAi: 'AI 助理目前無法使用，請直接在右側欄位填寫；填寫後系統仍會檢查格式與規則',
  aiErrors: {
    DAILY_QUOTA_EXCEEDED: '今日的 AI 對話額度已用完，將於台北時間午夜重置；請直接在右側欄位填寫',
    GLOBAL_QUOTA_EXCEEDED: '今日系統的 AI 對話額度已用完，將於台北時間午夜重置；請直接在右側欄位填寫',
  },
  unexpected: '發生未預期的錯誤，請稍後再試',
  validateFailed: '暫時無法檢查欄位：',
  manualHint: '仍可在右側欄位手動填寫，填好後按 Apply 套用',
  retryHint: '可稍後再輸入訊息重試，或直接在右側欄位填寫',
  undelivered: '（未送達）',
  status: { done: '✓ 已確認', missing: '• 待補', invalid: '! 格式不符', optional: '選填，可留空', checking: '檢查中…' },
  source: { user: '手動', ai: 'AI', system: '系統' },
  required: '必填',
  optional: '選填',
  chooseOption: '請選擇',
  chooseDepartment: '請選擇處理部門',
  departmentMissing: '請選擇處理部門',
  optionUnavailable: '目前無法選擇',
  noOptions: '目前沒有可選的項目，可以詢問助理',
  closeConfirm: '要關閉視窗嗎？已輸入的內容會保留，重新開啟時可以繼續',
  restartConfirm: '主題已變更，要依新主題重新開始嗎？選「取消」會沿用先前的對話與欄位',
  roles: { assistant: '服務台助理', user: '你', system: '系統', checklist: '還需要確認' },
};

/**
 * 組出套用後超過需求內容上限的提示。
 * @param {number} count 套用後的字數。
 * @returns {string} 提示文字。
 */
export function describeOverLimit(count) {
  return `套用後需求內容會是 ${count} 字，超過 ${TICKET_LIMITS.content} 字上限，請先縮短原本的需求內容`;
}

/**
 * 依 ai_error 組出「AI 無法使用」的提示；額度用盡有專用文字，其他代碼（未設定金鑰、逾時、上游錯誤）使用通用文字。
 * @param {{code: string}|string|null} aiError normalizeDraftResponse 整理後的 ai_error（{ code, message, retryAfter }），也接受只有代碼的字串。
 * @returns {string} 提示文字。
 */
export function describeAiUnavailable(aiError) {
  const code = typeof aiError === 'string' ? aiError : aiError?.code;
  return code && Object.hasOwn(DRAFT_TEXT.aiErrors, code) ? DRAFT_TEXT.aiErrors[code] : DRAFT_TEXT.noAi;
}

/**
 * 依欄位型別整理控制項的值（只依型別，不認得任何特定欄位）：日期時間只保留到分鐘（YYYY-MM-DDTHH:mm）、日期只保留 YYYY-MM-DD、
 * 數字去除首尾空白，其他型別原樣保留；不是字串時視為空字串。
 * @param {{type: string}} field 需求類型的欄位定義。
 * @param {unknown} value 控制項的值。
 * @returns {string} 要送給後端的值。
 */
export function normalizeControlValue(field, value) {
  const text = typeof value === 'string' ? value : '';
  if (field.type === 'datetime') return text.slice(0, 16);
  if (field.type === 'date') return text.slice(0, 10);
  if (field.type === 'number') return text.trim();
  return text;
}

/**
 * 組出需求類型結構的識別字串（類型 id 與版本；沒有類型時為 none），結構不同時面板要重建欄位。
 * @param {{id: string, version: number}|null} type 需求類型。
 * @returns {string} 識別字串。
 */
function structureKey(type) { return type ? `${type.id}@${type.version}` : 'none'; }

/**
 * 組出選項清單的識別字串，內容相同時不重建下拉選單（避免打斷使用者操作）。
 * @param {Array<object>} options 選項。
 * @returns {string} 識別字串。
 */
function optionsKey(options) { return JSON.stringify(options); }

/**
 * 依 id 在 { id, name } 選項中尋找項目。
 * @param {Array<{id: string, name: string}>} options 選項。
 * @param {string|null} id 要找的 id。
 * @returns {{id: string, name: string}|null} 找到的選項；沒有時為 null。
 */
function findOption(options, id) {
  if (!id) return null;
  for (const option of options) if (option.id === id) return option;
  return null;
}

/**
 * 建立「自動生成」對話框（ChatBox）：寬畫面左側是與服務台助理（AI）的對話、右側是需求內容面板（窄畫面改為上下排列）。
 * 面板完全依後端回應的需求類型定義（type.fields）繪製，前端不認得任何特定類型、欄位代號或領域文字：
 * self 唯讀、enum 下拉、text 單行或多行（max_length 超過 100 或沒有上限時多行）、number 數字輸入、date 日期與 datetime 日期時間（以分鐘為單位）
 * 使用日期時間選擇器（rules.after 互相對應的起訖欄位合併成一個期間選擇器，見 dateTimeControl.js 的 layoutFields）、
 * account／department 下拉（候選來自後端 field_options，不可選的項目停用並附原因）；不認得的型別以單行文字輸入呈現。
 * 後端依定義檔計算的結果（computed）與檢查摘要（summaries）以通用清單顯示。
 * 處理流程：
 * 1. 開啟時立即以 { subject } 呼叫 POST /api/tickets/draft，由後端判斷需求類型與處理部門，並以問候語作為第一則助理訊息，接著列出待補清單；
 * 2. 使用者在對話區輸入訊息後，帶 message、最近 6 則 history 與目前的面板 state 送出，AI 只更新使用者沒有手動修改過的欄位並回覆；
 * 3. 使用者也可以直接修改面板（欄位；類型沒有固定部門時另有處理部門），修改的欄位標記為手動並鎖定，約 400 毫秒後只做驗證（不帶 message，不呼叫 AI）；
 * 4. 後端回報完成（complete）後啟用 Apply，把後端整理好的 rendered_content 交給頁面。
 * 重要規則：所有文字以 textContent 放入；狀態（缺漏、格式錯誤、計算結果、摘要、完成與否）只採用與目前面板內容一致的回應，
 * 較早送出的驗證結果不會覆蓋較新的修改；AI 失敗時保留手動填寫；對話與欄位在關閉後保留，以相同主題重新開啟時接續，主題變更時詢問是否重新開始。
 * 面板不顯示判斷結果、需求內容預覽與指定處理人（套用後的內容會出現在頁面的需求內容欄）；處理部門只在類型沒有固定部門時顯示，讓使用者選擇或確認。
 * @param {object} nodes 對話框節點：dialog、close、log、typing、chatForm、message、messageCount、send、departmentField、departmentSelect、
 *   departmentSource、departmentStatus、fieldList、computed、summaries、prompt、error、applyChoice、replace、append、choiceCancel、cancel、apply、
 *   trigger（頁面上的「自動生成」按鈕）。
 * @param {object} options 設定與依賴。
 * @param {{username: string}} options.user 目前登入者（self 型別欄位沒有值時顯示這個帳號）。
 * @param {Function} options.requestDraft 草稿服務（draftService.requestDraft 或測試替身）。
 * @param {Function} options.getSubject 取得頁面主題的函式。
 * @param {Function} options.getContent 取得頁面需求內容的函式。
 * @param {Function} options.onApply 套用時呼叫，參數為 { content, draft }；draft 含 form（{ id, version, fields } 或 null）、formName、
 *   department（{ id, name }）、departmentFixed（部門是否由類型固定）、handler（一律 null，不再提供指定處理人）與 rendered（後端整理的內容）。
 * @param {Function} options.onLoginRequired 憑證失效時呼叫（回登入頁）。
 * @param {Window} options.win 視窗物件，提供 setTimeout、setInterval 與 confirm。
 * @param {number} [options.debounceMs=400] 手動修改後送出驗證前的等待毫秒數。
 * @param {() => number} [options.now=Date.now] 日期時間選擇器判斷「今天」使用的目前時間（測試可替換）。
 * @returns {object} 控制器：open、close、reset、settled、state、handleChatSubmit、handleMessageKeydown。
 */
export function createDraftDialog(nodes, { user, requestDraft, getSubject, getContent, onApply, onLoginRequired, win, debounceMs = 400, now = Date.now }) {
  const state = { seq: 0, generation: 0, inflight: new Set(), controls: new Map() };

  /**
   * 回到尚未開始的狀態（不動 seq 與 inflight，讓進行中的請求可以被辨識為過期）。
   * @returns {void}
   */
  function initialState() {
    Object.assign(state, {
      started: false, initialDone: false, hasResult: false, subject: '', history: [], log: [],
      type: null, fields: [], typeKey: '', values: {}, sources: {}, locked: new Set(), pendingKeys: new Set(),
      department: null, departmentId: null, departmentSource: '', departmentOptions: [], departmentEditVersion: -1, departmentLocked: false, departmentFixed: false,
      fieldOptions: {}, optionKeys: new Map(), departmentKey: '',
      missing: [], invalid: [], computed: [], summaries: [], intent: '', prompt: '', complete: false, rendered: null,
      version: 0, statusVersion: 0, appliedSeq: 0, pendingCount: 0, pendingAi: 0, aiNoticeShown: false,
      debounceTimer: null, waitUntil: 0, aiWaitUntil: 0, waitTimer: null,
    });
    state.controls.clear();
  }

  /**
   * 詢問使用者確認；視窗沒有 confirm 時視為同意。
   * @param {string} message 詢問文字。
   * @returns {boolean} 是否同意。
   */
  function ask(message) { return typeof win.confirm === 'function' ? Boolean(win.confirm(message)) : true; }

  /**
   * 在對話區加入一則訊息泡泡並捲到最新一則；同時記錄在 state.log（不等於送給後端的 history）。
   * @param {'assistant'|'user'|'system'|'checklist'} role 發言者；checklist 為後端產生的待補清單。
   * @param {string} text 訊息文字。
   * @returns {HTMLElement|null} 加入的泡泡；沒有文字時為 null。
   */
  function appendBubble(role, text) {
    if (!text) return null;
    state.log.push({ role, text });
    const bubble = element('div', `draft-bubble draft-bubble-${role}`);
    bubble.append(element('span', 'draft-bubble-role', DRAFT_TEXT.roles[role]), element('p', 'draft-bubble-text', text));
    nodes.log.append(bubble);
    nodes.log.scrollTop = nodes.log.scrollHeight;
    return bubble;
  }

  /**
   * 計算 HTTP 限流（429）剩餘的等待秒數；這段期間所有草稿請求（含只做驗證的呼叫）都要等待。
   * @returns {number} 向上取整的秒數，最小為零。
   */
  function remainingWait() { return Math.max(0, Math.ceil((state.waitUntil - Date.now()) / 1000)); }

  /**
   * 計算送出鈕剩餘的等待秒數：HTTP 限流與 AI 忙碌（ai_error.retry_after，只限制詢問 AI、不限制驗證）兩者取較晚者。
   * @returns {number} 向上取整的秒數，最小為零。
   */
  function sendWait() { return Math.max(0, Math.ceil((Math.max(state.waitUntil, state.aiWaitUntil) - Date.now()) / 1000)); }

  /**
   * 依 AI 請求進行中與限流倒數決定送出鈕與「整理中…」提示；訊息輸入框與面板一直可以編輯。
   * @returns {void}
   */
  function updateSend() {
    const remaining = sendWait();
    const busy = state.pendingAi > 0;
    nodes.send.disabled = busy || remaining > 0 || !state.started;
    nodes.send.textContent = remaining > 0 ? `請等 ${remaining} 秒` : DRAFT_TEXT.send;
    nodes.typing.textContent = busy ? DRAFT_TEXT.sending : '';
    nodes.typing.hidden = !busy;
    nodes.chatForm.setAttribute('aria-busy', String(busy));
  }

  /**
   * 倒數計時：到期後移除計時器並恢復送出鈕。
   * @returns {void}
   */
  function tickWait() {
    if (state.waitTimer !== null && sendWait() === 0) {
      win.clearInterval(state.waitTimer);
      state.waitTimer = null;
    }
    updateSend();
  }

  /**
   * 依後端要求的秒數開始倒數；超過 300 秒或沒有秒數時不倒數。
   * HTTP 429 的倒數同時延後驗證請求；aiOnly 為 true（AI 忙碌，回應仍為 200）時只停用送出鈕，手動修改的驗證照常送出。
   * @param {number} seconds 等待秒數。
   * @param {boolean} [aiOnly=false] 是否只限制詢問 AI。
   * @returns {void}
   */
  function startWait(seconds, aiOnly = false) {
    if (!(seconds > 0) || seconds > 300) return;
    if (state.waitTimer !== null) win.clearInterval(state.waitTimer);
    state[aiOnly ? 'aiWaitUntil' : 'waitUntil'] = Date.now() + seconds * 1000;
    state.waitTimer = win.setInterval(tickWait, 250);
    updateSend();
  }

  /**
   * 更新訊息的字數提示；超過 300 字時加上警示樣式。
   * @returns {void}
   */
  function updateMessageCount() {
    const count = countCodePoints(nodes.message.value);
    nodes.messageCount.textContent = `${count} / ${DRAFT_LIMITS.message}`;
    nodes.messageCount.classList.toggle('over-limit', count > DRAFT_LIMITS.message);
  }

  /**
   * 目前的狀態（缺漏、格式錯誤、完成與否）是否對應面板上的內容。
   * @returns {boolean} 是否一致（沒有尚未驗證的修改）。
   */
  function isFresh() { return state.statusVersion === state.version; }

  /**
   * Apply 只在後端回報完成、狀態與面板一致、有整理好的內容且沒有請求進行中時可用。
   * @returns {void}
   */
  function updateApply() {
    nodes.apply.disabled = !(state.hasResult && state.complete && state.rendered && isFresh() && state.pendingCount === 0);
  }

  /**
   * 取得要送給後端的欄位值：面板上的欄位，不含 self 型別（由後端依登入者填入）的欄位。
   * @returns {Record<string, string>} 欄位代號對應的文字值。
   */
  function currentFields() {
    const fields = {};
    for (const field of state.fields) if (field.type !== 'self') fields[field.key] = state.values[field.key] ?? '';
    return fields;
  }

  /**
   * 組出送給後端的面板狀態：鎖定清單含目前面板上手動修改過的欄位；使用者手動選過處理部門（類型沒有固定部門時）另加 department_id，
   * 讓後端不以 AI 結果改寫使用者的選擇。handler_id 一律為 null（不提供指定處理人）。intent 帶目前的判斷結果，讓只做驗證的呼叫保留 AI 先前的判斷。
   * @returns {{type_id: string|null, department_id: string|null, handler_id: string|null, intent: string, fields: Record<string, string>, locked: string[]}} 面板狀態。
   */
  function currentState() {
    const locked = [...state.locked];
    if (state.departmentLocked && !state.departmentFixed) locked.push('department_id');
    return { type_id: state.type?.id ?? null, department_id: state.departmentId, handler_id: null, intent: state.intent, fields: currentFields(), locked };
  }

  /**
   * 找出某個鍵（欄位、department_id 或 handler_id）的格式錯誤。
   * @param {string} key 鍵。
   * @returns {{key: string, message: string}|null} 格式錯誤；沒有時為 null。
   */
  function invalidOf(key) {
    for (const item of state.invalid) if (item.key === key) return item;
    return null;
  }

  /**
   * 設定狀態文字與樣式；狀態同時以符號與文字表示，不只依靠顏色。
   * @param {HTMLElement} node 狀態節點。
   * @param {{kind: string, text: string}} status 狀態代號與文字。
   * @returns {void}
   */
  function setStatus(node, status) {
    node.textContent = status.text;
    node.className = `draft-status is-${status.kind}`;
  }

  /**
   * 設定來源標籤（AI／手動／系統）；沒有來源或沒有值時隱藏。
   * @param {HTMLElement} node 標籤節點。
   * @param {string} source 來源代號。
   * @param {boolean} show 是否有值可標示。
   * @returns {void}
   */
  function setSource(node, source, show) {
    const visible = show && Object.hasOwn(DRAFT_TEXT.source, source);
    node.textContent = visible ? DRAFT_TEXT.source[source] : '';
    node.className = visible ? `draft-source is-${source}` : 'draft-source';
    node.hidden = !visible;
  }

  /**
   * 以選項清單重建下拉選單（第一項為提示文字、值為空字串），內容相同時不重建。
   * @param {HTMLSelectElement} select 下拉選單。
   * @param {string} placeholder 第一項文字。
   * @param {Array<{id: string, name: string}>} options 選項。
   * @param {string} cacheKey state 中記錄上次內容的屬性名稱。
   * @returns {void}
   */
  function fillSelect(select, placeholder, options, cacheKey) {
    const key = optionsKey(options);
    if (state[cacheKey] === key) return;
    state[cacheKey] = key;
    const first = element('option', '', placeholder);
    first.value = '';
    const items = [first];
    for (const option of options) {
      const item = element('option', '', option.name);
      item.value = option.id;
      items.push(item);
    }
    select.replaceChildren(...items);
  }

  /**
   * 顯示處理部門：只在已有結果、且需求類型沒有固定部門時顯示可改的下拉選單，沒有部門時提示使用者選擇；
   * 類型有固定部門或還在判斷時整個欄位隱藏（送達部門寫在左側的待補說明）。
   * @returns {void}
   */
  function renderDepartment() {
    const select = nodes.departmentSelect;
    nodes.departmentField.hidden = !state.hasResult || state.departmentFixed;
    if (nodes.departmentField.hidden) return;
    const problem = invalidOf('department_id');
    fillSelect(select, DRAFT_TEXT.chooseDepartment, state.departmentOptions, 'departmentKey');
    if (state.departmentId && !findOption(state.departmentOptions, state.departmentId) && state.department) {
      const extra = element('option', '', state.department.name);
      extra.value = state.department.id;
      select.append(extra);
      state.departmentKey = '';
    }
    select.value = state.departmentId ?? '';
    if (problem) select.setAttribute('aria-invalid', 'true'); else select.removeAttribute('aria-invalid');
    setSource(nodes.departmentSource, state.departmentSource, Boolean(state.departmentId));
    if (problem) setStatus(nodes.departmentStatus, { kind: 'invalid', text: `${DRAFT_TEXT.status.invalid}：${problem.message}` });
    else if (!state.departmentId) setStatus(nodes.departmentStatus, { kind: 'missing', text: `${DRAFT_TEXT.status.missing}：${DRAFT_TEXT.departmentMissing}` });
    else setStatus(nodes.departmentStatus, { kind: 'done', text: DRAFT_TEXT.status.done });
  }

  /**
   * 判斷單一欄位目前要顯示的狀態。
   * @param {object} field 欄位定義。
   * @returns {{kind: 'done'|'missing'|'invalid'|'optional'|'checking', text: string}} 狀態代號與文字。
   */
  function fieldStatus(field) {
    if (state.pendingKeys.has(field.key)) return { kind: 'checking', text: DRAFT_TEXT.status.checking };
    const problem = invalidOf(field.key);
    if (problem) return { kind: 'invalid', text: `${DRAFT_TEXT.status.invalid}：${problem.message}` };
    if (state.missing.includes(field.key)) return { kind: 'missing', text: DRAFT_TEXT.status.missing };
    const filled = field.type === 'self' || Boolean(displayValue(field).trim());
    if (filled) return { kind: 'done', text: DRAFT_TEXT.status.done };
    return field.required ? { kind: 'missing', text: DRAFT_TEXT.status.missing } : { kind: 'optional', text: DRAFT_TEXT.status.optional };
  }

  /**
   * 確保下拉選單含有目前的值；AI 填入不在名單中的值時補上一個選項，讓後端的格式錯誤可以對應顯示。
   * @param {HTMLSelectElement} select 下拉選單。
   * @param {string} value 目前的值。
   * @returns {void}
   */
  function ensureOption(select, value) {
    if (!value) return;
    for (const option of select.children) if (option.value === value) return;
    const extra = element('option', '', value);
    extra.value = value;
    select.append(extra);
  }

  /**
   * 取得欄位在畫面上的值：self 型別優先採用後端回傳的值，沒有時顯示目前登入者；其他型別為目前的欄位值。
   * @param {{key: string, type: string}} field 欄位定義。
   * @returns {string} 畫面上的值。
   */
  function displayValue(field) {
    const value = state.values[field.key] ?? '';
    return field.type === 'self' ? value || user.username : value;
  }

  /**
   * 取得帳號、部門型別欄位的候選清單：後端 field_options 有提供時採用；部門欄位沒有提供時改用回應的 department_options。
   * @param {{key: string, type: string}} field 欄位定義。
   * @returns {Array<{id: string, name: string, available: boolean, reason: string}>} 候選清單。
   */
  function optionsOf(field) {
    if (Object.hasOwn(state.fieldOptions, field.key)) return state.fieldOptions[field.key];
    if (field.type !== 'department') return [];
    const list = [];
    for (const option of state.departmentOptions) list.push({ ...option, available: true, reason: '' });
    return list;
  }

  /**
   * 以候選清單重建帳號或部門欄位的下拉選單：可選的項目顯示名稱；不可選的項目停用並在名稱後附上後端提供的原因。
   * @param {HTMLSelectElement} select 下拉選單。
   * @param {Array<{id: string, name: string, available: boolean, reason: string}>} options 候選清單。
   * @returns {void}
   */
  function fillOptionSelect(select, options) {
    const placeholder = element('option', '', DRAFT_TEXT.chooseOption);
    placeholder.value = '';
    const items = [placeholder];
    for (const option of options) {
      const item = element('option', '', option.available ? option.name : `${option.name}（${option.reason || DRAFT_TEXT.optionUnavailable}）`);
      item.value = option.id;
      item.disabled = !option.available;
      items.push(item);
    }
    select.replaceChildren(...items);
  }

  /**
   * 依目前狀態更新每個欄位的值（只更新未被使用者鎖定的欄位）、狀態、來源標籤與無障礙屬性，不重建控制項；
   * 帳號、部門欄位的候選改變時只重建該欄位選單的選項（並重新套用目前的值）。
   * @returns {void}
   */
  function updateFields() {
    for (const field of state.fields) {
      const entry = state.controls.get(field.key);
      if (!entry) continue;
      const value = displayValue(field);
      let optionsChanged = false;
      if (OPTION_FIELD_TYPES.has(field.type)) {
        const options = optionsOf(field);
        const key = optionsKey(options);
        optionsChanged = state.optionKeys.get(field.key) !== key;
        if (optionsChanged) {
          state.optionKeys.set(field.key, key);
          fillOptionSelect(entry.control, options);
        }
        if (entry.note) entry.note.hidden = options.length > 0;
      }
      if (entry.control.tagName === 'SELECT') ensureOption(entry.control, value);
      if (!state.locked.has(field.key) || optionsChanged) entry.control.value = value;
      const status = fieldStatus(field);
      setStatus(entry.status, status);
      if (status.kind === 'invalid') entry.control.setAttribute('aria-invalid', 'true'); else entry.control.removeAttribute('aria-invalid');
      const source = field.type === 'self' ? 'system' : state.sources[field.key];
      setSource(entry.source, source, Boolean(value.trim()));
      entry.wrapper.className = `${entry.wrapperClass} is-${status.kind}`;
    }
  }

  /**
   * 使用者修改欄位：記下新值、標記為手動並鎖定（AI 不再覆寫），約 400 毫秒後送出只做驗證的請求。
   * @param {object} field 欄位定義。
   * @param {HTMLElement} control 控制項。
   * @returns {void}
   */
  function handleFieldEdit(field, control) {
    const value = normalizeControlValue(field, control.value);
    if (state.locked.has(field.key) && state.values[field.key] === value) return;
    state.values[field.key] = value;
    state.locked.add(field.key);
    state.sources[field.key] = 'user';
    state.pendingKeys.add(field.key);
    state.version += 1;
    nodes.error.textContent = '';
    updateFields();
    updateApply();
    scheduleValidate(debounceMs);
  }

  /**
   * 依欄位型別建立控制項（只依型別與定義的限制，不認得任何特定欄位）：
   * self 唯讀輸入框；enum 下拉（選項來自定義）；account／department 下拉（候選來自後端 field_options，沒有候選時顯示說明）；
   * text 在 max_length 超過 100 或沒有上限時為多行輸入，否則為單行輸入（兩者都套用 maxLength）；number 為數字輸入（min、max、integer 時 step 為 1）；
   * date 與 datetime 為單一欄位的日期時間選擇器（見 createDateTimeControl：控制項是帶 value 的欄位按鈕，id 放在它上面，點選後展開月曆與時間；
   * 使用者選定時以 handleFieldEdit 更新；rules.not_before_today 時停用今天以前，有工作日曆時只列上班時段）；不認得的型別為單行文字輸入。
   * @param {object} field 欄位定義。
   * @param {string} id 控制項 id。
   * @param {object|null} [calendar=null] 對應的工作日曆（layoutFields 找出的；只用於日期類欄位）。
   * @returns {{control: HTMLElement, note: HTMLElement|null, view: HTMLElement}} 控制項、（候選型別沒有候選時的）說明與要放進欄位的節點（選擇器為外層，其他型別即控制項）。
   */
  function buildControl(field, id, calendar = null) {
    if (DATE_FIELD_TYPES.has(field.type)) {
      const picker = createDateTimeControl({
        id, labels: [field.label], mode: field.type, calendar, notBeforeToday: field.rules?.not_before_today === true, now,
        onChange: /** 使用者選定日期時間時交給 handleFieldEdit。@returns {void} */ () => handleFieldEdit(field, picker.parts[0]),
      });
      return { control: picker.parts[0], note: null, view: picker.root };
    }
    let control;
    let note = null;
    if (field.type === 'enum') {
      control = element('select', 'draft-control');
      const placeholder = element('option', '', DRAFT_TEXT.chooseOption);
      placeholder.value = '';
      control.append(placeholder);
      for (const choice of field.options) {
        const option = element('option', '', choice);
        option.value = choice;
        control.append(option);
      }
    } else if (OPTION_FIELD_TYPES.has(field.type)) {
      control = element('select', 'draft-control');
      const options = optionsOf(field);
      state.optionKeys.set(field.key, optionsKey(options));
      fillOptionSelect(control, options);
      note = element('p', 'draft-field-note', DRAFT_TEXT.noOptions);
      note.hidden = options.length > 0;
    } else if (field.type === 'text' && !(field.max_length && field.max_length <= TEXTAREA_THRESHOLD)) {
      control = element('textarea', 'draft-control draft-textarea');
      control.rows = field.max_length && field.max_length <= 300 ? 2 : 4;
      if (field.max_length) control.maxLength = field.max_length;
    } else {
      control = element('input', 'draft-control');
      if (field.type === 'date') control.type = 'date';
      else if (field.type === 'number') {
        control.type = 'number';
        control.inputMode = field.integer ? 'numeric' : 'decimal';
        control.setAttribute('step', field.integer ? '1' : 'any');
        if (field.min !== null) control.setAttribute('min', String(field.min));
        if (field.max !== null) control.setAttribute('max', String(field.max));
      } else if (field.max_length) control.maxLength = field.max_length;
      if (field.type === 'self') control.readOnly = true;
      control.autocomplete = 'off';
    }
    control.setAttribute('id', id);
    control.setAttribute('name', field.key);
    if (field.required) control.setAttribute('aria-required', 'true');
    if (field.type !== 'self') {
      /**
       * 控制項的 input 或 change 事件：交給 handleFieldEdit。
       * @returns {void}
       */
      const onEdit = function onEdit() { handleFieldEdit(field, control); };
      control.addEventListener('input', onEdit);
      control.addEventListener('change', onEdit);
    }
    return { control, note, view: control };
  }

  /**
   * 建立欄位名稱列：名稱 label（指向控制項）、必填或選填標記與來源標籤節點。
   * @param {string} text 名稱。
   * @param {string} id label 指向的控制項 id。
   * @param {boolean|null} required 是否必填；null 為不顯示標記（self 欄位）。
   * @param {boolean} [withSource=true] 是否在名稱列放來源標籤。
   * @returns {{head: HTMLElement, source: HTMLElement|null}} 名稱列與來源標籤（不放時為 null）。
   */
  function buildHead(text, id, required, withSource = true) {
    const head = element('div', 'draft-field-head');
    const label = element('label', '', text);
    label.setAttribute('for', id);
    if (required !== null) label.append(element('span', 'field-tag', required ? DRAFT_TEXT.required : DRAFT_TEXT.optional));
    head.append(label);
    if (!withSource) return { head, source: null };
    const source = element('span', 'draft-source');
    source.hidden = true;
    head.append(source);
    return { head, source };
  }

  /**
   * 建立欄位的狀態文字節點（aria-live），並讓控制項以 aria-describedby 指向它。
   * @param {string} key 欄位代號。
   * @param {HTMLElement} control 控制項。
   * @returns {HTMLElement} 狀態節點。
   */
  function buildStatus(key, control) {
    const status = element('p', 'draft-status');
    status.setAttribute('id', `draft-status-${key}`);
    status.setAttribute('aria-live', 'polite');
    control.setAttribute('aria-describedby', `draft-status-${key}`);
    return status;
  }

  /**
   * 建立期間欄位：起訖兩個日期類欄位合併成一個選擇器（名稱見 periodLabel，任一欄位必填時標示必填），下方分別列出起、訖的名稱、來源標籤與狀態；
   * 兩個欄位各自登記在 state.controls（控制項為選擇器的開始、結束按鈕），驗證、鎖定與送出仍以各自的欄位代號處理。
   * @param {{start: object, end: object, calendar: object|null}} item layoutFields 的期間項目。
   * @returns {HTMLElement} 欄位節點。
   */
  function buildPeriod({ start, end, calendar }) {
    const id = `draft-field-${start.key}`;
    const wrapper = element('div', 'draft-field draft-field-wide draft-period');
    wrapper.setAttribute('data-key', `${start.key} ${end.key}`);
    const { head } = buildHead(periodLabel(start.label, end.label), id, start.required || end.required, false);
    const fields = [start, end];
    const picker = createDateTimeControl({
      id, labels: [start.label, end.label], mode: start.type, calendar, notBeforeToday: start.rules?.not_before_today === true, now,
      onChange: /** 使用者改變開始或結束時交給 handleFieldEdit。@param {number} index 0 為開始、1 為結束。@returns {void} */ (index) => handleFieldEdit(fields[index], picker.parts[index]),
    });
    const row = element('div', 'draft-period-status');
    for (const [index, field] of fields.entries()) {
      const control = picker.parts[index];
      const cell = element('div', 'draft-period-part');
      const source = element('span', 'draft-source');
      source.hidden = true;
      const status = buildStatus(field.key, control);
      cell.append(element('span', 'draft-period-name', field.label), source, status);
      row.append(cell);
      state.controls.set(field.key, { wrapper: cell, wrapperClass: 'draft-period-part', control, status, source, note: null });
    }
    wrapper.append(head, picker.root, row);
    return wrapper;
  }

  /**
   * 依目前的欄位定義重建整個欄位清單（需求類型或其版本改變、重新開始時），每個欄位含名稱、必填標示、來源標籤、控制項與狀態文字；
   * 欄位的排列由 layoutFields 決定（互相對應的起訖日期類欄位合併成一個期間欄位，日期時間欄位與期間佔滿整列）。
   * @returns {void}
   */
  function rebuildFields() {
    state.controls.clear();
    state.optionKeys.clear();
    const items = [];
    for (const item of layoutFields(state.fields, state.type?.calendars ?? [])) {
      if (item.kind === 'period') {
        items.push(buildPeriod(item));
        continue;
      }
      const { field, calendar } = item;
      const id = `draft-field-${field.key}`;
      const wide = field.type === 'datetime';
      const wrapper = element('div', wide ? 'draft-field draft-field-wide' : 'draft-field');
      wrapper.setAttribute('data-key', field.key);
      const { head, source } = buildHead(field.label, id, field.type === 'self' ? null : field.required);
      const { control, note, view } = buildControl(field, id, calendar);
      const status = buildStatus(field.key, control);
      wrapper.append(head, view);
      if (note) wrapper.append(note);
      wrapper.append(status);
      state.controls.set(field.key, { wrapper, wrapperClass: wide ? 'draft-field draft-field-wide' : 'draft-field', control, status, source, note });
      items.push(wrapper);
    }
    nodes.fieldList.replaceChildren(...items);
    nodes.fieldList.hidden = !items.length;
    for (const field of state.fields) {
      const entry = state.controls.get(field.key);
      entry.control.value = displayValue(field);
    }
    updateFields();
  }

  /**
   * 顯示後端依定義檔 computations 計算的結果（每筆一行「名稱：文字」）；數值一律來自後端，不由 AI 或前端計算。沒有結果時隱藏。
   * @returns {void}
   */
  function renderComputed() {
    const items = [];
    for (const item of state.computed) items.push(element('p', 'draft-computed-item', `${item.label}：${item.text || '—'}`));
    nodes.computed.replaceChildren(...items);
    nodes.computed.hidden = !items.length;
  }

  /**
   * 顯示後端依定義檔 checks 產生的摘要文字（例如額度使用前後的變化），每筆一行；沒有摘要時隱藏。
   * @returns {void}
   */
  function renderSummaries() {
    const items = [];
    for (const line of state.summaries) items.push(element('p', 'draft-summary-line', line));
    nodes.summaries.replaceChildren(...items);
    nodes.summaries.hidden = !items.length;
  }

  /**
   * 顯示後端產生的待補清單（prompt）。
   * @returns {void}
   */
  function renderPrompt() {
    nodes.prompt.textContent = state.prompt;
    nodes.prompt.hidden = !state.prompt;
  }

  /**
   * 重新繪製整個面板；欄位結構改變時重建欄位，否則只更新值與狀態。
   * @param {boolean} [rebuild=false] 是否重建欄位清單。
   * @returns {void}
   */
  function renderPanel(rebuild = false) {
    renderDepartment();
    if (rebuild) rebuildFields(); else updateFields();
    renderComputed();
    renderSummaries();
    renderPrompt();
    updateSend();
    updateApply();
  }

  /**
   * 採用回應中的需求類型結構：類型或版本改變時換成新的欄位定義，鎖定清單只保留新結構仍有的欄位（沿用使用者手動填的值）。
   * @param {object} result normalizeDraftResponse 的結果。
   * @returns {boolean} 結構是否改變。
   */
  function adoptStructure(result) {
    const key = structureKey(result.type);
    if (key === state.typeKey) return false;
    state.type = result.type;
    state.fields = result.fields;
    state.typeKey = key;
    const values = {};
    const sources = {};
    const locked = new Set();
    for (const field of result.fields) {
      if (!state.locked.has(field.key)) continue;
      values[field.key] = state.values[field.key] ?? '';
      sources[field.key] = 'user';
      locked.add(field.key);
    }
    state.locked = locked;
    state.values = values;
    state.sources = sources;
    state.pendingKeys.clear();
    return true;
  }

  /**
   * 採用回應中的處理部門；請求送出後使用者又手動改過的部門不會被覆寫（回應的指定處理人不採用，畫面不提供這個欄位）。
   * 部門是否由需求類型固定（departmentFixed）一律採用最新回應。
   * 來源：後端有提供時採用；類型固定的部門為系統；與先前相同時沿用原來源；其他為 AI。
   * @param {object} result normalizeDraftResponse 的結果。
   * @param {number} sentVersion 請求送出時的面板版本。
   * @returns {boolean} 部門是否改變。
   */
  function adoptRouting(result, sentVersion) {
    let changed = false;
    if (state.departmentFixed !== result.departmentFixed) changed = true;
    state.departmentFixed = result.departmentFixed;
    if (sentVersion >= state.departmentEditVersion || result.departmentFixed) {
      const nextId = result.department?.id ?? null;
      const same = nextId === state.departmentId;
      if (!same) changed = true;
      state.departmentSource = result.sources.department_id ?? (result.departmentFixed ? 'system' : same && state.departmentSource ? state.departmentSource : nextId ? 'ai' : '');
      state.departmentId = nextId;
      state.department = result.department;
    }
    state.departmentOptions = result.departmentOptions;
    return changed;
  }

  /**
   * 套用後端的整理結果。
   * - 聊天與第一次呼叫（AI）：一律顯示回覆並採用 AI 對需求類型、部門與未鎖定欄位的更新；回應對應目前面板時同時採用狀態，
   *   否則（等待期間使用者又修改了面板）立即再驗證一次。AI 無法使用時，回覆已含 ai_error.message 就不另加系統提示；
   *   ai_error 附 retry_after（AI 忙碌、限流）時送出鈕開始倒數。
   * - 驗證：只有對應目前面板（期間沒有新的修改）且比已套用的結果新時才採用，否則捨棄。
   * 重新開始（generation 不同）後才回來的結果整個捨棄。
   * @param {object} result normalizeDraftResponse 的結果。
   * @param {{seq: number, generation: number, version: number}} ticket 送出時的請求序號、重設世代與面板版本。
   * @param {'chat'|'validate'|'initial'} mode 請求種類。
   * @returns {void}
   */
  function applyResult(result, ticket, mode) {
    if (ticket.generation !== state.generation) return;
    const ai = mode !== 'validate';
    const fresh = ticket.version === state.version;
    if (ai) {
      if (result.reply) {
        appendBubble('assistant', result.reply);
        state.history.push({ role: 'assistant', text: result.reply });
      }
      if (!result.aiAvailable) {
        // 後端在 AI 無法使用時，已把 ai_error.message 放進回覆；回覆已含這段說明時不再重複顯示系統提示。
        const explained = Boolean(result.aiError?.message) && result.reply.includes(result.aiError.message);
        if (!state.aiNoticeShown && !explained) appendBubble('system', describeAiUnavailable(result.aiError));
        state.aiNoticeShown = true;
        // AI 忙碌或限流（ai_error 附 retry_after）時，送出鈕倒數到可再詢問 AI 為止；面板仍可手動填寫。
        if (result.aiError?.retryAfter) startWait(result.aiError.retryAfter, true);
      } else state.aiNoticeShown = false;
      if (mode === 'initial' && result.prompt) appendBubble('checklist', result.prompt);
    } else if (!fresh || ticket.seq < state.appliedSeq) return;
    state.appliedSeq = Math.max(state.appliedSeq, ticket.seq);
    state.hasResult = true;
    const rebuild = adoptStructure(result);
    let changed = rebuild;
    for (const field of state.fields) {
      if (state.locked.has(field.key)) continue;
      const next = result.values[field.key] ?? '';
      if ((state.values[field.key] ?? '') !== next) changed = true;
      state.values[field.key] = next;
      if (result.sources[field.key]) state.sources[field.key] = result.sources[field.key];
      else delete state.sources[field.key];
    }
    if (adoptRouting(result, ticket.version)) changed = true;
    state.fieldOptions = result.fieldOptions;
    if (result.intent) state.intent = result.intent;
    if (ai && changed) state.version += 1;
    if (fresh) {
      state.missing = result.missing;
      state.invalid = result.invalid;
      state.computed = result.computed;
      state.summaries = result.summaries;
      state.complete = result.complete;
      state.rendered = result.rendered;
      state.prompt = result.prompt;
      state.statusVersion = state.version;
      state.pendingKeys.clear();
      nodes.error.textContent = '';
    } else scheduleValidate(0);
    renderPanel(rebuild);
  }

  /**
   * 處理草稿請求失敗：憑證失效回登入頁；429 非額度錯誤開始倒數；聊天與第一次呼叫的錯誤顯示在對話區，驗證錯誤顯示在面板下方。
   * 任何失敗都保留手動編輯，Apply 維持停用直到下一次驗證成功；倒數中的驗證會在倒數結束後自動重送。
   * @param {unknown} error 拋出的錯誤。
   * @param {'chat'|'validate'|'initial'} mode 請求種類。
   * @param {{generation: number}} ticket 送出時的重設世代；已重新開始時不顯示錯誤。
   * @returns {void}
   */
  function handleError(error, mode, ticket) {
    if (error?.status === 401 || error?.code === 'LOGIN_REQUIRED') { onLoginRequired(); return; }
    if (ticket.generation !== state.generation) return;
    let message = DRAFT_TEXT.unexpected;
    let countdown = false;
    if (error instanceof TicketServiceError) {
      message = error.message;
      countdown = error.status === 429 && !QUOTA_CODES.includes(error.code) && error.retryAfter > 0;
      if (countdown) startWait(error.retryAfter);
    } else console.error(error);
    if (mode === 'validate') {
      nodes.error.textContent = `${DRAFT_TEXT.validateFailed}${message}`;
      if (countdown) scheduleValidate(0);
      return;
    }
    appendBubble('system', `${message}\n${state.hasResult ? DRAFT_TEXT.manualHint : DRAFT_TEXT.retryHint}`);
    if (!isFresh() && state.hasResult) scheduleValidate(debounceMs);
  }

  /**
   * 送出一次草稿請求並套用結果；同時記錄進行中的請求供 settled() 等待。
   * @param {'chat'|'validate'|'initial'} mode 請求種類：第一次呼叫只帶主題；聊天帶訊息、對話紀錄與面板狀態；驗證只帶面板狀態。
   * @param {string} [message=''] 聊天訊息。
   * @param {Array<{role: string, text: string}>} [history=[]] 本次訊息之前的對話紀錄。
   * @returns {Promise<boolean>} 是否成功。
   */
  function run(mode, message = '', history = []) {
    state.seq += 1;
    const ticket = { seq: state.seq, generation: state.generation, version: state.version };
    const input = mode === 'initial' ? { subject: state.subject }
      : mode === 'chat' ? { subject: state.subject, message, history, state: currentState() }
        : { subject: state.subject, state: currentState() };
    state.pendingCount += 1;
    if (mode !== 'validate') state.pendingAi += 1;
    updateSend();
    updateApply();
    /**
     * 實際送出請求、套用結果並在結束時恢復按鈕狀態。
     * @returns {Promise<boolean>} 是否成功。
     */
    async function perform() {
      try {
        const result = await requestDraft(input);
        applyResult(result, ticket, mode);
        if (mode === 'initial' && ticket.generation === state.generation) state.initialDone = true;
        return true;
      } catch (error) {
        handleError(error, mode, ticket);
        return false;
      } finally {
        if (ticket.generation === state.generation) {
          state.pendingCount -= 1;
          if (mode !== 'validate') state.pendingAi -= 1;
          updateSend();
          updateApply();
        }
      }
    }
    return track(perform());
  }

  /**
   * 把進行中的非同步工作加入清單，結束後自動移除，供 settled() 等待。
   * @param {Promise<unknown>} pending 進行中的工作。
   * @returns {Promise<unknown>} 原本的 Promise。
   */
  function track(pending) {
    state.inflight.add(pending);
    /**
     * 工作結束後從進行中清單移除。
     * @returns {void}
     */
    const forget = function forget() { state.inflight.delete(pending); };
    pending.then(forget, forget);
    return pending;
  }

  /**
   * 計時器到期：限流倒數中時延到倒數結束，否則送出只做驗證的請求（已有結果且面板有尚未驗證的修改時）。
   * @returns {void}
   */
  function fireValidate() {
    state.debounceTimer = null;
    const remaining = remainingWait();
    if (remaining > 0) { scheduleValidate(remaining * 1000); return; }
    if (state.hasResult && !isFresh()) run('validate');
  }

  /**
   * 重新安排驗證請求；連續修改時只送最後一次。
   * @param {number} delay 等待毫秒數。
   * @returns {void}
   */
  function scheduleValidate(delay) {
    if (state.debounceTimer !== null) win.clearTimeout(state.debounceTimer);
    state.debounceTimer = win.setTimeout(fireValidate, delay);
  }

  /**
   * 取消等待中的驗證計時器。
   * @returns {void}
   */
  function cancelValidate() {
    if (state.debounceTimer !== null) win.clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }

  /**
   * 使用者改選處理部門（需求類型沒有固定部門時）：記錄為手動並鎖定（之後的 AI 結果不再改寫，選回「請選擇」則解除鎖定），稍後驗證。
   * @returns {void}
   */
  function handleDepartmentChange() {
    const id = nodes.departmentSelect.value || null;
    if (id === state.departmentId) return;
    state.version += 1;
    state.departmentEditVersion = state.version;
    state.departmentLocked = Boolean(id);
    state.departmentId = id;
    state.department = findOption(state.departmentOptions, id);
    state.departmentSource = id ? 'user' : '';
    nodes.error.textContent = '';
    renderDepartment();
    updateApply();
    scheduleValidate(debounceMs);
  }

  /**
   * 對話區送出訊息：檢查不可空白與 300 字上限，先顯示自己的訊息，再帶最近的對話紀錄與面板狀態請 AI 整理；
   * 失敗時把這則訊息標示為未送達、從對話紀錄移除並放回輸入框。
   * @param {Event} [event] 表單提交或按鍵事件。
   * @returns {Promise<boolean>} 是否成功送出並取得結果。
   */
  async function handleChatSubmit(event) {
    event?.preventDefault?.();
    if (nodes.send.disabled) return false;
    const text = nodes.message.value.trim();
    if (!text) { nodes.error.textContent = DRAFT_TEXT.emptyMessage; nodes.message.focus(); return false; }
    const count = countCodePoints(text);
    if (count > DRAFT_LIMITS.message) { nodes.error.textContent = `訊息最多 ${DRAFT_LIMITS.message} 字，目前 ${count} 字`; nodes.message.focus(); return false; }
    nodes.error.textContent = '';
    const previous = [...state.history];
    const turn = { role: 'user', text };
    state.history.push(turn);
    const bubble = appendBubble('user', text);
    nodes.message.value = '';
    updateMessageCount();
    cancelValidate();
    const generation = state.generation;
    const ok = await run('chat', text, previous);
    if (!ok && generation === state.generation) {
      const index = state.history.indexOf(turn);
      if (index >= 0) state.history.splice(index, 1);
      bubble?.classList.add('is-undelivered');
      bubble?.append(element('span', 'draft-bubble-flag', DRAFT_TEXT.undelivered));
      if (!nodes.message.value) { nodes.message.value = text; updateMessageCount(); }
    }
    return ok;
  }

  /**
   * 訊息的鍵盤操作：Enter 送出、Shift+Enter 換行；輸入法組字中不送出。
   * @param {KeyboardEvent} event 鍵盤事件。
   * @returns {Promise<boolean>|undefined} 送出時回傳 handleChatSubmit 的結果。
   */
  function handleMessageKeydown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return undefined;
    event.preventDefault();
    return handleChatSubmit();
  }

  /**
   * 訊息輸入時更新字數並清掉提示。
   * @returns {void}
   */
  function handleMessageInput() { updateMessageCount(); nodes.error.textContent = ''; }

  /**
   * 是否已經輸入過任何內容（送出的訊息、手動修改的欄位或部門、未送出的訊息），用於 Esc 關閉前確認。
   * @returns {boolean} 是否有輸入。
   */
  function hasInput() {
    if (state.locked.size > 0 || nodes.message.value.trim() || state.departmentEditVersion >= 0) return true;
    for (const turn of state.history) if (turn.role === 'user') return true;
    return false;
  }

  /**
   * 清空對話、面板與所有暫存狀態（主題變更重新開始、清除重填、送出成功或表單規則更新時使用）；進行中的請求結果會被捨棄。
   * @returns {void}
   */
  function reset() {
    cancelValidate();
    if (state.waitTimer) win.clearInterval(state.waitTimer);
    const generation = (state.generation ?? 0) + 1;
    initialState();
    state.generation = generation;
    nodes.log.replaceChildren();
    nodes.fieldList.replaceChildren();
    nodes.fieldList.hidden = true;
    nodes.departmentSelect.replaceChildren();
    nodes.applyChoice.hidden = true;
    nodes.error.textContent = '';
    nodes.message.value = '';
    updateMessageCount();
    renderPanel(false);
  }

  /**
   * 開啟對話框：第一次開啟時立即以主題向助理取得問候與判斷；主題與上次不同時詢問是否重新開始；
   * 以相同主題重新開啟時接續先前的對話與面板（先前第一次呼叫失敗且尚未對話時重試；有尚未驗證的修改時立即驗證）。焦點移到訊息輸入框。
   * @returns {Promise<boolean>|null} 有送出請求時回傳請求結果，否則為 null。
   */
  function open() {
    const subject = String(getSubject() ?? '').trim();
    if (state.started && subject !== state.subject) {
      if (ask(DRAFT_TEXT.restartConfirm)) reset();
      else state.subject = subject;
    }
    nodes.applyChoice.hidden = true;
    if (!nodes.dialog.open) nodes.dialog.showModal();
    nodes.message.focus();
    if (!state.started) {
      state.started = true;
      state.subject = subject;
      return run('initial');
    }
    if (!state.initialDone && !state.hasResult && state.pendingAi === 0 && !state.history.length) return run('initial');
    if (state.hasResult && !isFresh()) scheduleValidate(0);
    return null;
  }

  /**
   * 關閉對話框（狀態保留）。
   * @returns {void}
   */
  function close() { if (nodes.dialog.open) nodes.dialog.close(); }

  /**
   * Esc（dialog 的 cancel 事件）：一律攔下預設關閉，有輸入內容時先詢問，同意才關閉。
   * @param {Event} event cancel 事件。
   * @returns {void}
   */
  function handleCancelEvent(event) {
    event.preventDefault();
    if (hasInput() && !ask(DRAFT_TEXT.closeConfirm)) return;
    close();
  }

  /**
   * 對話框關閉後：取消等待中的驗證（重新開啟時再送）、收起套用選擇，焦點回到「自動生成」按鈕。
   * @returns {void}
   */
  function handleClosed() {
    cancelValidate();
    nodes.applyChoice.hidden = true;
    nodes.trigger?.focus();
  }

  /**
   * 完成套用：檢查套用後的需求內容不超過 2000 字，通過後把內容與送單設定（需求類型 form、部門、部門是否固定、整理好的內容；處理人一律 null）交給頁面並關閉對話框。
   * @param {string} content 套用後的完整需求內容。
   * @returns {boolean} 是否已套用。
   */
  function finishApply(content) {
    const count = countCodePoints(content);
    if (count > TICKET_LIMITS.content) { nodes.error.textContent = describeOverLimit(count); return false; }
    nodes.applyChoice.hidden = true;
    onApply({ content, draft: {
      form: state.type ? { id: state.type.id, version: state.type.version, fields: currentFields() } : null,
      formName: state.type?.name ?? '',
      department: { id: state.department.id, name: state.department.name },
      departmentFixed: state.departmentFixed,
      handler: null,
      rendered: state.rendered,
    } });
    close();
    return true;
  }

  /**
   * Apply：需求內容空白時直接放入整理好的內容；已有文字時顯示「取代／附加在後」選擇。
   * @returns {boolean} 是否已直接套用。
   */
  function handleApply() {
    if (nodes.apply.disabled) return false;
    nodes.error.textContent = '';
    const content = String(getContent() ?? '');
    if (!content.trim()) return finishApply(state.rendered);
    nodes.applyChoice.hidden = false;
    nodes.replace.focus();
    return false;
  }

  /**
   * 取代：以整理好的內容取代原本的需求內容。
   * @returns {boolean} 是否已套用。
   */
  function handleReplace() { return finishApply(state.rendered); }

  /**
   * 附加在後：在原本的需求內容後空一行接上整理好的內容。
   * @returns {boolean} 是否已套用。
   */
  function handleAppend() { return finishApply(`${String(getContent() ?? '').replace(/\s+$/u, '')}\n\n${state.rendered}`); }

  /**
   * 收起套用選擇，焦點回到 Apply。
   * @returns {void}
   */
  function handleChoiceCancel() { nodes.applyChoice.hidden = true; nodes.apply.focus(); }

  /**
   * 等待目前所有進行中的草稿請求完成（測試與頁面同步使用）。
   * @returns {Promise<void>}
   */
  async function settled() {
    while (state.inflight.size) await Promise.allSettled([...state.inflight]);
  }

  nodes.chatForm.addEventListener('submit', handleChatSubmit);
  nodes.message.addEventListener('keydown', handleMessageKeydown);
  nodes.message.addEventListener('input', handleMessageInput);
  nodes.departmentSelect.addEventListener('change', handleDepartmentChange);
  nodes.dialog.addEventListener('cancel', handleCancelEvent);
  nodes.dialog.addEventListener('close', handleClosed);
  nodes.close.addEventListener('click', close);
  nodes.cancel.addEventListener('click', close);
  nodes.apply.addEventListener('click', handleApply);
  nodes.replace.addEventListener('click', handleReplace);
  nodes.append.addEventListener('click', handleAppend);
  nodes.choiceCancel.addEventListener('click', handleChoiceCancel);
  reset();

  return { open, close, reset, settled, state, handleChatSubmit, handleMessageKeydown };
}
