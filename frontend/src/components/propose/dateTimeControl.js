import { element } from '../dom.js';

// 時間建議清單的間隔（分鐘）；清單只是建議，使用者仍可輸入任何分鐘
const TIME_STEP_MINUTES = 30;
const FULL_WIDTH_DIGITS = /[０-９]/g;

/**
 * 把使用者輸入的時間整理成 24 小時制的「HH:mm」：接受「9」「09」「9:30」「0930」「930」與全形數字、全形冒號
 * @param {string} text 時間欄的原始文字
 * @returns {string} 合法時「HH:mm」；空白時空字串；無法辨識時原樣（去除首尾空白）回傳，交給後端驗證並顯示錯誤
 */
export function normalizeTimeText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const ascii = raw.replace(FULL_WIDTH_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)).replace('：', ':');
  const match = ascii.match(/^(\d{1,2})(?::?(\d{2}))?$/u);
  if (!match) return raw;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  if (hours > 23 || minutes > 59) return raw;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * 產生一天內每隔 TIME_STEP_MINUTES 分鐘的時間建議（00:00、00:30……23:30）
 * @returns {string[]} 「HH:mm」清單
 */
function timeSuggestions() {
  const times = [];
  for (let minute = 0; minute < 24 * 60; minute += TIME_STEP_MINUTES) {
    times.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
  }
  return times;
}

/**
 * 建立「日期＋時間」欄位，取代瀏覽器原生的 datetime-local（原生選擇器的時、分是兩欄捲動清單，且依系統顯示上午／下午）：
 * - 日期用原生的 date 輸入，保留月曆選擇；
 * - 時間用 24 小時制的文字輸入，可以直接打字（例如 0930、9:30），也可以從每 30 分鐘一筆的建議清單挑選；離開欄位時整理成「HH:mm」
 * 外層群組提供 value（讀寫「YYYY-MM-DDTHH:mm」）：日期或時間只填一邊時讀到空字串，交給驗證顯示「必填」；
 * 寫入時拆成日期與時間兩邊，空字串會清空兩邊
 * @param {object} options 設定
 * @param {string} options.id 日期輸入的 id（欄位名稱的 label 指向它）；時間輸入與建議清單以它加上字尾命名
 * @param {string} options.label 欄位名稱，用於群組與時間輸入的無障礙名稱
 * @returns {{root: HTMLElement, date: HTMLInputElement, time: HTMLInputElement}} 外層群組（帶 value）、日期輸入、時間輸入；
 *   呼叫端在 date 與 time 的 change 事件讀取 root.value
 */
export function createDateTimeControl({ id, label }) {
  const root = element('div', 'datetime-control');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  const date = element('input', 'draft-control datetime-date');
  date.type = 'date';
  date.setAttribute('id', id);
  const time = element('input', 'draft-control datetime-time');
  time.type = 'text';
  time.inputMode = 'numeric';
  time.maxLength = 5;
  time.placeholder = '時:分（24 小時制）';
  time.autocomplete = 'off';
  time.setAttribute('id', `${id}-time`);
  time.setAttribute('aria-label', `${label}的時間（24 小時制）`);
  const list = element('datalist');
  list.setAttribute('id', `${id}-times`);
  for (const value of timeSuggestions()) {
    const option = element('option');
    option.value = value;
    list.append(option);
  }
  time.setAttribute('list', `${id}-times`);
  /**
   * 時間欄離開或選取建議後，把輸入整理成「HH:mm」；在呼叫端的 change 處理器之前註冊，讓它讀到整理後的值
   * @returns {void}
   */
  function tidyTime() { time.value = normalizeTimeText(time.value); }
  time.addEventListener('change', tidyTime);
  Object.defineProperty(root, 'value', {
    configurable: true,
    /**
     * 讀取組合後的值
     * @returns {string} 兩邊都有值時「YYYY-MM-DDTHH:mm」（時間無法辨識時保留原文，讓後端回報格式錯誤），否則空字串
     */
    get() {
      const clock = normalizeTimeText(time.value);
      return date.value && clock ? `${date.value}T${clock}` : '';
    },
    /**
     * 寫入值並拆到日期與時間兩邊；秒數與時區等多餘部分不顯示
     * @param {string} value 「YYYY-MM-DDTHH:mm」或空字串
     * @returns {void}
     */
    set(value) {
      const text = String(value ?? '');
      date.value = text.slice(0, 10);
      time.value = text.slice(11, 16);
    },
  });
  root.append(date, time, list);
  return { root, date, time };
}
