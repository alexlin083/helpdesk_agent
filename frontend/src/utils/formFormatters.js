// 需求類型（設定檔驅動）在畫面上的格式化工具；純函式，不依賴頁面或網路，也不認得任何特定類型或欄位代號。
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const EMPTY_VALUE = '無';

/**
 * 依日曆日期算出星期（不受瀏覽器時區影響）；日期不存在時回傳 null。
 * @param {string} year 西元年（四位數）。
 * @param {string} month 月（兩位數）。
 * @param {string} day 日（兩位數）。
 * @returns {string|null} 星期的中文字（日、一…六）。
 */
function weekdayOf(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return WEEKDAYS[date.getUTCDay()];
}

/**
 * 把日期（YYYY-MM-DD）轉成「YYYY-MM-DD（週X）」；格式不符或日期不存在時原樣回傳。
 * @param {unknown} value 日期字串。
 * @returns {string} 格式化後的文字；非字串回傳空字串。
 */
export function formatFormDate(value) {
  if (typeof value !== 'string') return '';
  const match = DATE_PATTERN.exec(value);
  if (!match) return value;
  const weekday = weekdayOf(match[1], match[2], match[3]);
  return weekday ? `${value}（週${weekday}）` : value;
}

/**
 * 把日期時間值（YYYY-MM-DDTHH:mm，台北時間）轉成「YYYY-MM-DD（週X）HH:mm」。
 * 星期依日曆日期計算，不受瀏覽器時區影響；格式不符或日期不存在時原樣回傳。
 * @param {unknown} value 日期時間字串。
 * @returns {string} 格式化後的文字；非字串回傳空字串。
 */
export function formatFormDateTime(value) {
  if (typeof value !== 'string') return '';
  const match = DATETIME_PATTERN.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  const weekday = weekdayOf(year, month, day);
  return weekday ? `${year}-${month}-${day}（週${weekday}）${hour}:${minute}` : value;
}

/**
 * 把分鐘數轉成「X 小時 Y 分鐘」；整點時只顯示「X 小時」，負數前面加負號。對應定義檔的 hours_minutes 顯示方式。
 * @param {unknown} minutes 分鐘數（整數）。
 * @returns {string} 時數文字；不是有限數字時回傳「—」。
 */
export function formatMinutes(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—';
  const sign = minutes < 0 ? '-' : '';
  const total = Math.abs(Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${sign}${hours} 小時 ${rest} 分鐘` : `${sign}${hours} 小時`;
}

/**
 * 依欄位型別把保存的文字值轉成畫面文字：date 加上星期、datetime 加上星期並保留時間；其他型別原樣（去除首尾空白）。
 * 不知道型別時（例如需求類型目錄載入失敗）依值的格式判斷：符合 YYYY-MM-DDTHH:mm 視為日期時間、符合 YYYY-MM-DD 視為日期。
 * @param {unknown} value 保存的欄位值。
 * @param {string} [type=''] 欄位型別；空字串代表未知。
 * @returns {string} 畫面文字；非字串或空白時回傳空字串。
 */
export function formatFieldValue(value, type = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (type === 'datetime' || (!type && DATETIME_PATTERN.test(text))) return formatFormDateTime(text);
  if (type === 'date' || (!type && DATE_PATTERN.test(text))) return formatFormDate(text);
  return text;
}

/**
 * 依定義檔的顯示方式（display）把計算值轉成文字：hours_minutes 為時數；其他或沒有指定時以文字顯示。
 * @param {unknown} value 計算值。
 * @param {string} [display=''] 顯示方式。
 * @returns {string} 畫面文字；沒有值時為空字串。
 */
export function formatComputedValue(value, display = '') {
  if (value === null || value === undefined || value === '') return '';
  if (display === 'hours_minutes') return formatMinutes(value);
  return String(value);
}

/**
 * 依欄位定義組出需求內容的簡易預覽（後端還沒有回傳任何預覽時使用）：每個欄位一行「[名稱]: 值」，self 型別的欄位沒有值時填入目前登入者。
 * 實際放入需求內容的一律是後端依定義檔 render 整理的 rendered_content，這裡只供畫面預覽。
 * @param {object} input 預覽資料。
 * @param {Array<{key: string, label: string, type: string}>} input.fields 需求類型的欄位定義。
 * @param {Record<string, string>} input.values 目前的欄位值。
 * @param {string} input.username 目前登入者。
 * @returns {string} 預覽文字（以 \n 分行）。
 */
export function previewFields({ fields, values, username }) {
  const lines = [];
  for (const field of fields) {
    const raw = typeof values?.[field.key] === 'string' ? values[field.key].trim() : '';
    lines.push(`[${field.label}]: ${field.type === 'self' ? raw || username : raw}`);
  }
  return lines.join('\n');
}

/**
 * 把需求單保存的欄位值整理成「名稱：值」清單（狀態追蹤頁的表單表格）。名稱與順序的來源依序為：
 * 1. 需求類型目錄（GET /api/forms）中相同 id 的欄位定義（順序與型別也取自這裡）；
 * 2. 需求單記錄本身帶的 labels（欄位代號對應名稱）；
 * 3. 都沒有時以欄位代號為名稱。
 * 不在定義中的已保存欄位接在後面；空白值顯示「無」；日期與日期時間加上星期。舊版本的需求單只要欄位代號相同就能沿用目前的名稱。
 * @param {{fields: Record<string, string>, labels?: Record<string, string>}} form 正規化的表單資料（normalizeStoredTicket 的 form）。
 * @param {{fields: Array<{key: string, label: string, type: string}>}|null} [definition=null] 需求類型目錄中的定義；沒有時為 null。
 * @returns {Array<{key: string, label: string, value: string}>} 要顯示的欄位。
 */
export function describeFormFields(form, definition = null) {
  const labels = form.labels ?? {};
  const rows = [];
  const seen = new Set();
  /**
   * 加入一列並記錄已顯示的欄位。
   * @param {string} key 欄位代號。
   * @param {string} label 顯示名稱。
   * @param {string} type 欄位型別；空字串代表未知。
   * @returns {void}
   */
  function push(key, label, type) {
    seen.add(key);
    rows.push({ key, label, value: formatFieldValue(form.fields[key], type) || EMPTY_VALUE });
  }
  for (const field of definition?.fields ?? []) if (Object.hasOwn(form.fields, field.key)) push(field.key, labels[field.key] ?? field.label, field.type);
  for (const key of Object.keys(labels)) if (!seen.has(key) && Object.hasOwn(form.fields, key)) push(key, labels[key], '');
  for (const key of Object.keys(form.fields)) if (!seen.has(key)) push(key, key, '');
  return rows;
}

/**
 * 把需求單保存的計算結果整理成「名稱：值」清單。
 * - computed 為陣列（[{ key, label, text }]，新版記錄）時直接採用；
 * - computed 為物件（{ 鍵: 值 }，舊版記錄）時只顯示需求類型目錄有提供名稱的鍵，依定義的 display 格式化；沒有名稱的鍵（例如年度）不顯示。
 * @param {{computed: Array<object>|Record<string, unknown>|null}} form 正規化的表單資料。
 * @param {{computed?: Array<{key: string, label: string, display: string}>}|null} [definition=null] 需求類型目錄中的定義。
 * @returns {Array<{key: string, label: string, value: string}>} 要顯示的計算結果。
 */
export function describeFormComputed(form, definition = null) {
  const rows = [];
  if (Array.isArray(form.computed)) {
    for (const item of form.computed) if (item.text) rows.push({ key: item.key, label: item.label, value: item.text });
    return rows;
  }
  if (!form.computed) return rows;
  for (const entry of definition?.computed ?? []) {
    const text = formatComputedValue(form.computed[entry.key], entry.display);
    if (text) rows.push({ key: entry.key, label: entry.label, value: text });
  }
  return rows;
}

/**
 * 取得需求單所屬的需求類型 id（與後端相同）：帶表單的單取 form.id，依需求類型送出但不保存欄位的單（例如一般需求）取 request_type.id；
 * 舊流程建立的單沒有需求類型，回傳 null。
 * @param {{form?: {id: string}|null, request_type?: {id: string}|null}} ticket 正規化的需求單。
 * @returns {string|null} 需求類型 id。
 */
export function ticketTypeId(ticket) {
  return ticket.form?.id ?? ticket.request_type?.id ?? null;
}

/**
 * 依需求單的送達方式與定義檔的 workflow 判斷卡片可提供的動作（實際授權一律由後端決定，這裡只避免顯示必定被拒絕的按鈕）：
 * - transferable：記錄本身的 form.workflow.transfer → 需求類型目錄的 workflow.transfer → 預設（route 不是 FORM 時可以轉單）；
 * - selfApprovable：提單人本人能否簽核，依 not_requester 的相同順序判斷；只有明確設為 false 時才可以，
 *   沒有需求類型、目錄沒有載入或查不到定義時一律不行（與後端「提單人不能簽核自己的單」的預設一致）。
 * @param {{route: string, form: object|null}} ticket 正規化的需求單。
 * @param {{workflow?: {transfer: boolean|null, not_requester: boolean|null}}|null} [definition=null] 需求類型目錄中的定義（以 ticketTypeId 查詢）。
 * @returns {{transferable: boolean, selfApprovable: boolean}} 卡片動作設定。
 */
export function describeFormPolicy(ticket, definition = null) {
  /**
   * 依記錄、目錄的順序取得布林設定。
   * @param {string} name workflow 的設定名稱。
   * @returns {boolean|null} 記錄或目錄的值；都沒有時為 null。
   */
  function pick(name) {
    const stored = ticket.form?.workflow?.[name];
    if (typeof stored === 'boolean') return stored;
    const defined = definition?.workflow?.[name];
    return typeof defined === 'boolean' ? defined : null;
  }
  const transfer = pick('transfer');
  return { transferable: transfer ?? ticket.route !== 'FORM', selfApprovable: pick('not_requester') === false };
}
