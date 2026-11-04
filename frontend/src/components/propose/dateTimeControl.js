import { element } from '../dom.js';

// 沒有工作日曆時，時間按鈕的間隔（分鐘）；有工作日曆時同樣以這個間隔切分上班時段。清單只是快捷，使用者仍可輸入任何分鐘
const TIME_STEP_MINUTES = 30;
const FULL_WIDTH_DIGITS = /[０-９]/g;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
// 沒有工作日曆時判斷「今天」使用的時區（台北）
const DEFAULT_OFFSET = '+08:00';
// 沒有工作日曆時的時間分組：[組名, 起（含）, 訖（不含）]，以當天分鐘數表示
const DAY_GROUPS = Object.freeze([['上午', 0, 12 * 60], ['下午', 12 * 60, 18 * 60], ['晚上', 18 * 60, 24 * 60]]);

export const PICKER_TEXT = Object.freeze({
  start: '開始',
  end: '結束',
  chooseDate: '選擇日期',
  chooseDateTime: '選擇日期與時間',
  chooseStart: '選擇開始',
  chooseEnd: '選擇結束',
  noTime: '未選時間',
  noDate: '未選日期',
  dateCaption: '日期',
  dateTimeCaption: '日期與時間',
  period: '期間',
  prevMonth: '上個月',
  nextMonth: '下個月',
  presets: '快捷',
  wholeDay: '整天',
  startTime: '開始時間',
  endTime: '結束時間',
  time: '時間',
  otherTime: '其他時間（可直接輸入，例如 0945）',
  done: '完成',
  clear: '清除',
  hintStart: '點選開始日期',
  hintEnd: '點選結束日期；同一天可直接選時間，或再點一次同一天',
  hintSingle: '點選日期',
  pickDateFirst: '請先在月曆點選日期',
  unreadable: '看不懂這個時間，請輸入像 0945 或 9:45 的格式',
  endCleared: '結束時間要晚於開始時間，已清除結束時間',
  unavailable: '不可選',
  today: '今天',
});

/**
 * 把使用者輸入的時間整理成 24 小時制的「HH:mm」：接受「9」「09」「9:30」「0930」「930」與全形數字、全形冒號
 * @param {string} text 時間欄的原始文字
 * @returns {string} 合法時「HH:mm」；空白時空字串；無法辨識時原樣（去除首尾空白）回傳，由呼叫端提示或交給後端驗證
 */
export function normalizeTimeText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const ascii = raw.replace(FULL_WIDTH_DIGITS, /** 全形數字轉半形。@param {string} digit 全形數字。@returns {string} 半形數字。 */ (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)).replace('：', ':');
  const match = ascii.match(/^(\d{1,2})(?::?(\d{2}))?$/u);
  if (!match) return raw;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  if (hours > 23 || minutes > 59) return raw;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * 「HH:mm」轉成當天分鐘數
 * @param {string} time 時間
 * @returns {number} 分鐘數
 */
function minutesOf(time) { return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)); }

/**
 * 當天分鐘數轉成「HH:mm」
 * @param {number} minutes 分鐘數（0～1439）
 * @returns {string} 時間
 */
function clockOf(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }

/**
 * 依曆日算出星期（0 為週日），不受瀏覽器時區影響
 * @param {string} date YYYY-MM-DD
 * @returns {number} 星期
 */
function weekdayOf(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * 組出 YYYY-MM-DD
 * @param {number} year 年
 * @param {number} month 月（0～11）
 * @param {number} day 日
 * @returns {string} 日期
 */
function isoDate(year, month, day) { return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }

/**
 * 依時區位移算出「今天」的日期（例如台北 +08:00），不受瀏覽器時區影響
 * @param {number} now 目前的毫秒時間戳
 * @param {string} offset ±HH:mm
 * @returns {string} YYYY-MM-DD
 */
export function todayIn(now, offset) {
  const sign = offset.startsWith('-') ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return new Date(now + minutes * 60000).toISOString().slice(0, 10);
}

/**
 * 把日期顯示成「YYYY/MM/DD（週）」
 * @param {string} date YYYY-MM-DD
 * @returns {string} 顯示文字
 */
export function formatPickerDate(date) { return `${date.replaceAll('-', '/')}（${WEEKDAYS[weekdayOf(date)]}）`; }

/**
 * 組出期間欄位的名稱：起訖兩個欄位名稱有共同開頭時為「開頭＋期間」（例如「使用起始日期」與「使用截止日期」→「使用期間」），
 * 否則為「起～訖」；只依名稱文字判斷，不認得任何特定需求類型
 * @param {string} startLabel 起始欄位名稱
 * @param {string} endLabel 結束欄位名稱
 * @returns {string} 期間名稱
 */
export function periodLabel(startLabel, endLabel) {
  const a = Array.from(startLabel);
  const b = Array.from(endLabel);
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length > 0 && length < a.length && length < b.length ? `${a.slice(0, length).join('')}${PICKER_TEXT.period}` : `${startLabel}～${endLabel}`;
}

/**
 * 把需求類型的欄位排成面板的版面項目：date／datetime 欄位的 rules.after 指向前面同型別、尚未配對的欄位時，兩者合併成一個期間項目
 * （放在起始欄位的位置）；其餘欄位各自一項。每個日期類項目附上對應的工作日曆（type.calendars 中起訖欄位相符者；單一欄位取任一引用它的日曆），沒有時為 null。
 * 只依欄位型別與規則判斷，不認得任何特定欄位代號
 * @param {Array<object>} fields 正規化的欄位定義（含 rules）
 * @param {Array<object>} [calendars=[]] 正規化的工作日曆（normalizeCalendar 的結果）
 * @returns {Array<{kind: 'field', field: object, calendar: object|null}|{kind: 'period', start: object, end: object, calendar: object|null}>} 版面項目
 */
export function layoutFields(fields, calendars = []) {
  const dateLike = new Set(['date', 'datetime']);
  const index = new Map(fields.map(/** 欄位代號對應位置。@param {{key: string}} field 欄位。@param {number} position 位置。@returns {[string, number]} [代號, 位置]。 */ (field, position) => [field.key, position]));
  const pairs = new Map();
  const paired = new Set();
  for (const [position, field] of fields.entries()) {
    const after = field.rules?.after;
    if (!dateLike.has(field.type) || !after || !index.has(after) || index.get(after) >= position) continue;
    const start = fields[index.get(after)];
    if (start.type !== field.type || paired.has(start.key) || paired.has(field.key)) continue;
    pairs.set(start.key, field);
    paired.add(start.key).add(field.key);
  }
  const items = [];
  for (const field of fields) {
    if (pairs.has(field.key)) {
      const end = pairs.get(field.key);
      const keys = [field.key, end.key];
      const calendar = calendars.find(/** 起訖都相符。@param {{start: string, end: string}} item 日曆。@returns {boolean} 相符時 true。 */ (item) => item.start === field.key && item.end === end.key)
        ?? calendars.find(/** 引用任一欄位。@param {{start: string, end: string}} item 日曆。@returns {boolean} 相符時 true。 */ (item) => keys.includes(item.start) || keys.includes(item.end)) ?? null;
      items.push({ kind: 'period', start: field, end, calendar });
    } else if (!paired.has(field.key)) {
      const calendar = dateLike.has(field.type)
        ? calendars.find(/** 引用這個欄位。@param {{start: string, end: string}} item 日曆。@returns {boolean} 相符時 true。 */ (item) => item.start === field.key || item.end === field.key) ?? null : null;
      items.push({ kind: 'field', field, calendar });
    }
  }
  return items;
}

/**
 * 時段的組名：落在中午以前為上午、中午到 18:00 開始為下午、18:00 以後開始為晚上，其他（例如跨越中午的整段）為「起–訖」
 * @param {string} start 起（HH:mm）
 * @param {string} end 訖（HH:mm）
 * @returns {string} 組名
 */
function windowName(start, end) {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (to <= 13 * 60) return DAY_GROUPS[0][0];
  if (from >= 12 * 60 && from < 18 * 60) return DAY_GROUPS[1][0];
  if (from >= 18 * 60) return DAY_GROUPS[2][0];
  return `${start}–${end}`;
}

/**
 * 產生時間按鈕的分組：有工作日曆時依上班時段切分（開始時間不含時段終點、結束時間不含時段起點），沒有時把一天分成上午、下午、晚上
 * @param {object|null} calendar 正規化的工作日曆
 * @param {'start'|'end'} part 開始或結束時間
 * @returns {Array<{name: string, times: string[]}>} 分組與其中的時間（HH:mm）
 */
export function timeGroups(calendar, part) {
  if (!calendar) {
    return DAY_GROUPS.map(/** 產生一組時間。@param {[string, number, number]} group 組名與起訖分鐘。@returns {{name: string, times: string[]}} 分組。 */ ([name, from, to]) => {
      const times = [];
      for (let minute = from; minute < to; minute += TIME_STEP_MINUTES) times.push(clockOf(minute));
      return { name, times };
    });
  }
  return calendar.workWindows.map(/** 產生一個上班時段的時間。@param {[string, string]} window 時段起訖。@returns {{name: string, times: string[]}} 分組。 */ ([start, end]) => {
    const times = [];
    const from = minutesOf(start) + (part === 'end' ? TIME_STEP_MINUTES : 0);
    const to = minutesOf(end) - (part === 'start' ? TIME_STEP_MINUTES : 0);
    for (let minute = from; minute <= to; minute += TIME_STEP_MINUTES) times.push(clockOf(minute));
    if (part === 'end' && times.at(-1) !== end) times.push(end);
    return { name: windowName(start, end), times };
  });
}

/**
 * 建立日期（時間）選擇器，取代瀏覽器原生的日期與時間輸入：欄位本身是一或兩個按鈕（期間為「開始 → 結束」），點選後在下方展開面板：
 * - 月曆：顯示星期；有工作日曆時淡化並停用非工作日、假日與未開放年度，not_before_today 時停用今天以前；期間依序點選開始日與結束日；
 * - 時間（datetime）：依上班時段（沒有工作日曆時為全天）每 30 分鐘一個按鈕，開始與結束分開選；同一天時早於開始的結束時間停用；
 *   也可在「其他時間」直接輸入任何分鐘（例如 0945）；
 * - 快捷（datetime 期間且有工作日曆）：整天與各個上班時段，一鍵填好開始與結束時間（結束日沒有選時沿用開始日）；
 * - 完成、清除與 Esc 關閉面板。
 * 每個部分（開始、結束）以按鈕元素對外，按鈕上定義 value（datetime 為「YYYY-MM-DDTHH:mm」、date 為「YYYY-MM-DD」，沒選完時為空字串；
 * 無法解析的值保留原文顯示，讓後端回報格式錯誤）；寫入 value 只更新畫面、不觸發 onChange。使用者操作改變某部分時以該部分的索引呼叫 onChange。
 * 前端的停用與限制只是輔助，實際規則（期間先後、上限、額度）仍由後端驗證
 * @param {object} options 設定
 * @param {string} options.id 第一個部分按鈕的 id（欄位名稱的 label 指向它）；其他節點以它加上字尾命名
 * @param {string[]} options.labels 各部分的欄位名稱（一個為單一欄位、兩個為期間），用於無障礙名稱
 * @param {'date'|'datetime'} options.mode 日期或日期時間
 * @param {object|null} [options.calendar=null] 正規化的工作日曆
 * @param {boolean} [options.notBeforeToday=false] 是否停用今天以前的日期
 * @param {() => number} [options.now=Date.now] 目前時間（測試可替換）
 * @param {(index: number) => void} [options.onChange] 使用者改變第 index 個部分時呼叫
 * @returns {{root: HTMLElement, parts: HTMLButtonElement[], panel: HTMLElement, open: (part?: number) => void, close: () => void, isOpen: () => boolean}}
 *   外層、各部分按鈕（帶 value）、面板與開關函式
 */
export function createDateTimeControl({ id, labels, mode, calendar = null, notBeforeToday = false, now = Date.now, onChange = () => {} }) {
  const range = labels.length > 1;
  const withTime = mode === 'datetime';
  const sel = { startDate: '', startTime: '', endDate: '', endTime: '', raw: ['', ''] };
  const view = { year: 0, month: 0, phase: 'start', open: false, opener: 0, message: '', focus: '' };
  const root = element('div', 'picker');
  const trigger = element('div', 'picker-trigger');
  const parts = [];
  const panel = element('div', 'picker-panel');
  panel.setAttribute('id', `${id}-panel`);
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', range ? periodLabel(labels[0], labels[1]) : labels[0]);
  panel.hidden = true;
  const focusables = new Map();

  /**
   * 今天的日期（依工作日曆的時區，沒有時為台北）
   * @returns {string} YYYY-MM-DD
   */
  function today() { return todayIn(now(), calendar?.timezoneOffset ?? DEFAULT_OFFSET); }

  /**
   * 結束部分實際使用的日期：datetime 期間沒有另選結束日時沿用開始日
   * @returns {string} YYYY-MM-DD 或空字串
   */
  function endDateOf() { return sel.endDate || (withTime ? sel.startDate : ''); }

  /**
   * 組出某部分目前的值
   * @param {number} index 0 為開始（或單一欄位）、1 為結束
   * @returns {string} 值；沒選完時為空字串，無法解析的原文原樣回傳
   */
  function valueOf(index) {
    if (sel.raw[index]) return sel.raw[index];
    const date = index === 0 ? sel.startDate : endDateOf();
    if (!withTime) return date;
    const time = index === 0 ? sel.startTime : sel.endTime;
    return date && time ? `${date}T${time}` : '';
  }

  /**
   * 寫入某部分的值並拆成日期與時間；格式不符時保留原文。與目前的值相同時不做任何事，保留只選了日期或時間的未完成選擇
   * @param {number} index 部分索引
   * @param {unknown} value 「YYYY-MM-DDTHH:mm」（可帶秒數）「YYYY-MM-DD」或空字串；date 欄位收到帶時間的值時只取日期
   * @returns {void}
   */
  function writeValue(index, value) {
    const text = String(value ?? '').trim();
    if (text === valueOf(index)) return;
    const date = text.slice(0, 10);
    const time = text.slice(11, 16);
    const valid = !text || (DATE_PATTERN.test(date) && (withTime ? text.length >= 16 && text[10] === 'T' && TIME_PATTERN.test(time) : text.length === 10 || text[10] === 'T'));
    sel.raw[index] = valid ? '' : text;
    const nextDate = valid ? date : '';
    const nextTime = valid && withTime ? time : '';
    if (index === 0) {
      sel.startDate = nextDate;
      sel.startTime = nextTime;
    } else {
      sel.endDate = nextDate;
      sel.endTime = nextTime;
    }
    if (nextDate && !view.open) moveView(nextDate);
    render();
  }

  /**
   * 月曆切到指定日期所在的月份
   * @param {string} date YYYY-MM-DD
   * @returns {void}
   */
  function moveView(date) {
    view.year = Number(date.slice(0, 4));
    view.month = Number(date.slice(5, 7)) - 1;
  }

  /**
   * 日期是否可選：not_before_today 時不可早於今天；有工作日曆時必須是工作日、不是假日，且在開放年度內（有列出開放年度時）
   * @param {string} date YYYY-MM-DD
   * @returns {boolean} 可選時 true
   */
  function selectable(date) {
    if (notBeforeToday && date < today()) return false;
    if (!calendar) return true;
    if (!calendar.workdays.includes(weekdayOf(date)) || calendar.holidays.includes(date)) return false;
    return !calendar.openYears.length || calendar.openYears.includes(Number(date.slice(0, 4)));
  }

  /**
   * 使用者操作後通知改變的部分，並重新繪製
   * @param {Array<[string, string]>} before 操作前各部分的值
   * @param {number[]} touched 這次操作到的部分（值沒變也通知，讓呼叫端記下使用者已手動修改）
   * @returns {void}
   */
  function commit(before, touched) {
    render();
    for (const index of parts.keys()) if (touched.includes(index) || valueOf(index) !== before[index]) onChange(index);
  }

  /**
   * 執行一次使用者操作：記下操作前的值、執行變更、檢查同一天的先後，再通知改變的部分
   * @param {number[]} touched 這次操作到的部分
   * @param {() => void} change 變更內容
   * @returns {void}
   */
  function act(touched, change) {
    const before = parts.map(/** 取操作前的值。@param {HTMLElement} part 部分按鈕。@param {number} index 索引。@returns {string} 值。 */ (part, index) => valueOf(index));
    view.message = '';
    change();
    sel.raw = ['', ''];
    if (range && withTime && sel.startTime && sel.endTime && endDateOf() === sel.startDate && minutesOf(sel.endTime) <= minutesOf(sel.startTime)) {
      sel.endTime = '';
      view.message = PICKER_TEXT.endCleared;
      if (!touched.includes(1)) touched.push(1);
    }
    commit(before, touched);
  }

  /**
   * 點選月曆上的日期：單一欄位直接選定；期間在選開始時設定開始日（結束日早於它時清除）並改選結束，選結束時早於開始日的日期改當作新的開始日
   * @param {string} date YYYY-MM-DD
   * @returns {void}
   */
  function pickDate(date) {
    view.focus = `day:${date}`;
    if (!range) {
      act([0], /** 選定日期。@returns {void} */ () => { sel.startDate = date; });
      return;
    }
    if (view.phase === 'start' || !sel.startDate || date < sel.startDate) {
      act([0, 1], /** 設定開始日並改選結束日。@returns {void} */ () => {
        sel.startDate = date;
        if (sel.endDate && sel.endDate < date) sel.endDate = '';
        view.phase = 'end';
      });
      return;
    }
    act([1], /** 設定結束日。@returns {void} */ () => { sel.endDate = date; view.phase = 'start'; });
  }

  /**
   * 選定某部分的時間
   * @param {number} index 部分索引
   * @param {string} time HH:mm
   * @returns {void}
   */
  function pickTime(index, time) {
    view.focus = `time:${index}:${time}`;
    act([index], /** 設定時間。@returns {void} */ () => { if (index === 0) sel.startTime = time; else sel.endTime = time; });
  }

  /**
   * 套用快捷時段：沒有開始日時提示先選日期；結束日沒有另選時沿用開始日
   * @param {string} from 開始時間
   * @param {string} to 結束時間
   * @returns {void}
   */
  function pickPreset(from, to) {
    view.focus = `preset:${from}-${to}`;
    if (!sel.startDate) { view.message = PICKER_TEXT.pickDateFirst; render(); return; }
    act([0, 1], /** 設定起訖時間。@returns {void} */ () => { sel.startTime = from; sel.endTime = to; });
  }

  /**
   * 開啟面板；指定部分時從該部分開始選（期間的結束部分會讓下一次點選日期設定結束日）
   * @param {number} [part=0] 部分索引
   * @returns {void}
   */
  function open(part = 0) {
    view.open = true;
    view.opener = part;
    view.phase = part === 1 ? 'end' : 'start';
    const date = (part === 1 ? endDateOf() : '') || sel.startDate || today();
    moveView(date);
    render();
  }

  /**
   * 關閉面板並把焦點還給開啟它的部分按鈕
   * @returns {void}
   */
  function close() {
    if (!view.open) return;
    view.open = false;
    view.message = '';
    render();
    parts[view.opener]?.focus();
  }

  /**
   * 建立面板中的按鈕並登記焦點鍵（重新繪製後把焦點還給同一個按鈕）
   * @param {string} className 樣式
   * @param {string} text 文字
   * @param {string} key 焦點鍵
   * @param {() => void} handler 點選時執行
   * @returns {HTMLButtonElement} 按鈕
   */
  function button(className, text, key, handler) {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', handler);
    focusables.set(key, node);
    return node;
  }

  /**
   * 繪製月曆：月份切換、星期列與日期按鈕（選定的開始、結束日與中間的日期以不同樣式標示，並以 aria-pressed 表示端點）
   * @returns {HTMLElement} 月曆節點
   */
  function renderCalendar() {
    const box = element('div', 'picker-calendar');
    const head = element('div', 'picker-month');
    const prev = button('picker-nav', '‹', 'nav:prev', /** 上個月。@returns {void} */ () => { view.focus = 'nav:prev'; shiftMonth(-1); });
    prev.setAttribute('aria-label', PICKER_TEXT.prevMonth);
    const next = button('picker-nav', '›', 'nav:next', /** 下個月。@returns {void} */ () => { view.focus = 'nav:next'; shiftMonth(1); });
    next.setAttribute('aria-label', PICKER_TEXT.nextMonth);
    const title = element('span', 'picker-month-title', `${view.year} 年 ${view.month + 1} 月`);
    title.setAttribute('aria-live', 'polite');
    head.append(prev, title, next);
    const grid = element('div', 'picker-days');
    for (const name of WEEKDAYS) grid.append(element('span', 'picker-weekday', name));
    const first = new Date(Date.UTC(view.year, view.month, 1)).getUTCDay();
    for (let blank = 0; blank < first; blank += 1) grid.append(element('span', 'picker-blank'));
    const days = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate();
    const start = sel.startDate;
    const end = range ? endDateOf() : '';
    const current = today();
    for (let day = 1; day <= days; day += 1) {
      const date = isoDate(view.year, view.month, day);
      const allowed = selectable(date);
      const edge = date === start || (range && date === end);
      const inside = range && start && end && date > start && date < end;
      const node = button(`picker-day${edge ? ' is-edge' : inside ? ' is-inside' : ''}${date === current ? ' is-today' : ''}`, String(day), `day:${date}`,
        /** 點選這一天。@returns {void} */ () => pickDate(date));
      node.disabled = !allowed;
      node.setAttribute('aria-pressed', String(edge));
      node.setAttribute('aria-label', `${view.year} 年 ${view.month + 1} 月 ${day} 日 星期${WEEKDAYS[weekdayOf(date)]}${date === current ? `，${PICKER_TEXT.today}` : ''}${allowed ? '' : `，${PICKER_TEXT.unavailable}`}`);
      grid.append(node);
    }
    const hint = element('p', 'picker-hint', range ? (view.phase === 'end' && start ? PICKER_TEXT.hintEnd : PICKER_TEXT.hintStart) : PICKER_TEXT.hintSingle);
    box.append(head, grid, hint);
    return box;
  }

  /**
   * 月曆前後切換月份
   * @param {number} step -1 為上個月、1 為下個月
   * @returns {void}
   */
  function shiftMonth(step) {
    const month = view.month + step;
    view.year += Math.floor(month / 12);
    view.month = ((month % 12) + 12) % 12;
    render();
  }

  /**
   * 繪製某部分的時間按鈕：依分組列出，選定的按鈕以 aria-pressed 標示；期間同一天時，早於或等於開始時間的結束時間停用
   * @param {number} index 部分索引
   * @returns {HTMLElement} 時間區節點
   */
  function renderTimes(index) {
    const box = element('div', 'picker-times');
    const title = range ? (index === 0 ? PICKER_TEXT.startTime : PICKER_TEXT.endTime) : PICKER_TEXT.time;
    box.append(element('p', 'picker-section', title));
    const current = index === 0 ? sel.startTime : sel.endTime;
    const sameDay = range && endDateOf() === sel.startDate;
    for (const group of timeGroups(calendar, range && index === 1 ? 'end' : 'start')) {
      const row = element('div', 'picker-chips');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', `${title}・${group.name}`);
      const list = element('div', 'picker-chip-list');
      for (const time of group.times) {
        const chip = button(`picker-chip${time === current ? ' is-on' : ''}`, time, `time:${index}:${time}`, /** 選定這個時間。@returns {void} */ () => pickTime(index, time));
        chip.setAttribute('aria-pressed', String(time === current));
        chip.disabled = index === 1 && sameDay && Boolean(sel.startTime) && minutesOf(time) <= minutesOf(sel.startTime);
        list.append(chip);
      }
      row.append(element('span', 'picker-group', group.name), list);
      box.append(row);
    }
    return box;
  }

  /**
   * 繪製「其他時間」輸入框：change 時整理成 HH:mm，看不懂時顯示提示且不改變選擇
   * @returns {HTMLElement} 輸入區節點
   */
  function renderCustom() {
    const box = element('div', 'picker-custom');
    const caption = element('label', 'picker-section', PICKER_TEXT.otherTime);
    caption.setAttribute('for', `${id}-custom-0`);
    box.append(caption);
    const row = element('div', 'picker-custom-row');
    for (const index of parts.keys()) {
      const input = element('input', 'picker-input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.maxLength = 5;
      input.autocomplete = 'off';
      input.placeholder = range ? (index === 0 ? PICKER_TEXT.start : PICKER_TEXT.end) : 'HH:mm';
      input.setAttribute('id', `${id}-custom-${index}`);
      input.setAttribute('aria-label', `${labels[index]}（24 小時制，可輸入任何分鐘）`);
      input.value = (index === 0 ? sel.startTime : sel.endTime) || '';
      input.addEventListener('change', /** 整理輸入的時間並選定；空白不處理，看不懂時提示。@returns {void} */ () => {
        const time = normalizeTimeText(input.value);
        if (!time) return;
        view.focus = `custom:${index}`;
        if (!TIME_PATTERN.test(time)) { view.message = PICKER_TEXT.unreadable; render(); return; }
        act([index], /** 設定輸入的時間。@returns {void} */ () => { if (index === 0) sel.startTime = time; else sel.endTime = time; });
      });
      focusables.set(`custom:${index}`, input);
      row.append(input);
    }
    box.append(row);
    return box;
  }

  /**
   * 繪製快捷時段（只有 datetime 期間且有工作日曆時）：整天，以及有多個上班時段時的各個時段
   * @returns {HTMLElement|null} 快捷區節點；沒有快捷時為 null
   */
  function renderPresets() {
    if (!(range && withTime && calendar)) return null;
    const windows = calendar.workWindows;
    const presets = [[PICKER_TEXT.wholeDay, windows[0][0], windows.at(-1)[1]]];
    if (windows.length > 1) for (const [from, to] of windows) presets.push([windowName(from, to), from, to]);
    const row = element('div', 'picker-chips picker-presets');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', PICKER_TEXT.presets);
    const list = element('div', 'picker-chip-list');
    for (const [name, from, to] of presets) {
      const on = sel.startTime === from && sel.endTime === to;
      const chip = button(`picker-chip${on ? ' is-on' : ''}`, `${name} ${from}–${to}`, `preset:${from}-${to}`, /** 套用這個快捷時段。@returns {void} */ () => pickPreset(from, to));
      chip.setAttribute('aria-pressed', String(on));
      list.append(chip);
    }
    row.append(element('span', 'picker-group', PICKER_TEXT.presets), list);
    return row;
  }

  /**
   * 更新部分按鈕的文字：已選的日期（與時間）、只選了日期時註明未選時間、沒有值時為提示文字；無法解析的原文原樣顯示
   * @returns {void}
   */
  function renderParts() {
    for (const [index, part] of parts.entries()) {
      const date = index === 0 ? sel.startDate : endDateOf();
      const time = index === 0 ? sel.startTime : sel.endTime;
      const placeholder = range ? (index === 0 ? PICKER_TEXT.chooseStart : PICKER_TEXT.chooseEnd) : withTime ? PICKER_TEXT.chooseDateTime : PICKER_TEXT.chooseDate;
      let text = placeholder;
      if (sel.raw[index]) text = sel.raw[index];
      else if (date && withTime) text = `${formatPickerDate(date)} ${time || PICKER_TEXT.noTime}`;
      else if (date) text = formatPickerDate(date);
      else if (withTime && time) text = `${PICKER_TEXT.noDate} ${time}`;
      part.querySelector('.picker-part-value').textContent = text;
      part.classList.toggle('is-empty', text === placeholder);
      part.setAttribute('aria-expanded', String(view.open));
    }
  }

  /**
   * 依目前狀態重新繪製部分按鈕與面板；面板開啟時重建內容，並把焦點還給操作前的按鈕
   * @returns {void}
   */
  function render() {
    renderParts();
    panel.hidden = !view.open;
    root.classList.toggle('is-open', view.open);
    if (!view.open) { panel.replaceChildren(); return; }
    focusables.clear();
    const body = element('div', withTime ? 'picker-body has-time' : 'picker-body');
    body.append(renderCalendar());
    if (withTime) {
      const times = element('div', 'picker-time-column');
      for (const index of parts.keys()) times.append(renderTimes(index));
      times.append(renderCustom());
      body.append(times);
    }
    const message = element('p', 'picker-message', view.message);
    message.setAttribute('role', 'status');
    const footer = element('div', 'picker-footer');
    footer.append(message, button('secondary-button picker-clear', PICKER_TEXT.clear, 'clear', /** 清除全部選擇。@returns {void} */ () => {
      view.focus = 'clear';
      act([...parts.keys()], /** 清空日期與時間。@returns {void} */ () => { Object.assign(sel, { startDate: '', startTime: '', endDate: '', endTime: '' }); view.phase = 'start'; });
    }), button('primary-button picker-done', PICKER_TEXT.done, 'done', close));
    const presets = renderPresets();
    panel.replaceChildren(...(presets ? [presets] : []), body, footer);
    const target = focusables.get(view.focus);
    view.focus = '';
    if (target) target.focus();
  }

  for (const [index, label] of labels.entries()) {
    const part = element('button', 'picker-part is-empty');
    part.type = 'button';
    part.setAttribute('id', index === 0 ? id : `${id}-end`);
    part.setAttribute('aria-controls', `${id}-panel`);
    part.setAttribute('aria-expanded', 'false');
    part.setAttribute('aria-label', label);
    part.append(element('span', 'picker-part-caption', range ? (index === 0 ? PICKER_TEXT.start : PICKER_TEXT.end) : withTime ? PICKER_TEXT.dateTimeCaption : PICKER_TEXT.dateCaption),
      element('span', 'picker-part-value', ''));
    Object.defineProperty(part, 'value', {
      configurable: true,
      /**
       * 讀取這個部分的值
       * @returns {string} 值；沒選完時為空字串
       */
      get() { return valueOf(index); },
      /**
       * 寫入這個部分的值（程式寫入，不觸發 onChange）
       * @param {string} value 值
       * @returns {void}
       */
      set(value) { writeValue(index, value); },
    });
    part.addEventListener('click', /** 開啟面板；同一個部分再點一次時關閉。@returns {void} */ () => {
      if (view.open && view.opener === index) close(); else open(index);
    });
    parts.push(part);
    if (index > 0) trigger.append(element('span', 'picker-arrow', '→'));
    trigger.append(part);
  }
  /**
   * 面板開啟時按 Esc 只關閉面板：攔下預設行為與事件傳遞，避免同時觸發外層對話框的關閉
   * @param {KeyboardEvent} event 鍵盤事件
   * @returns {void}
   */
  function closeOnEscape(event) {
    if (event.key !== 'Escape' || !view.open) return;
    event.preventDefault();
    event.stopPropagation?.();
    close();
  }
  panel.addEventListener('keydown', closeOnEscape);
  for (const part of parts) part.addEventListener('keydown', closeOnEscape);
  moveView(today());
  root.append(trigger, panel);
  render();
  return { root, parts, panel, open, close, isOpen: /** 面板是否開啟。@returns {boolean} 開啟時 true。 */ () => view.open };
}
