import { applyHolidays, checkHolidays, loadHolidays, revertHolidays } from '../../services/holidayService.js';

const ORIGIN_LABELS = Object.freeze({ synced: '已同步', definition: '定義檔內建', none: '沒有資料' });

/**
 * 把 ISO 時間轉成台北時間文字
 * @param {unknown} value ISO 時間
 * @returns {string} 時間文字；不是有效時間時為空字串
 */
function taipeiTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '';
}

/**
 * 一筆假日的顯示文字：「2027-06-09（端午節）」，沒有說明時只有日期
 * @param {{date: string, description?: string|null}} item 假日
 * @returns {string} 文字
 */
function holidayText(item) {
  return item.description ? `${item.date}（${item.description}）` : item.date;
}

/**
 * 管理頁的「假日資料」：列出每個年度目前使用的假日與來源，檢查外部來源的差異後由管理員按「套用」，也可以把同步過的年度還原成定義檔。
 * 處理流程：
 * 1. 載入時讀摘要，畫年度表格，年度欄預設為可同步的最晚年度（明年）；
 * 2. 按「檢查更新」只列出差異（新增、移除、沒變的天數），不寫入；有週末補班日時顯示原因並停用套用；
 * 3. 按「套用」把檢查結果的摘要值送回後端，來源在兩次之間變了（HOLIDAYS_CHANGED）就清掉預覽，請管理員重新檢查；
 * 4. 改了年度欄就清掉舊的預覽，避免套用到不是畫面上看到的年度。
 * 頁面沒有這一區時不初始化；登入失效（401）時登出。
 * @param {Document} doc 頁面文件
 * @param {object} options 選項
 * @param {object} options.auth 登入服務
 * @param {Function} options.leave 登入失效時登出回登入頁
 * @param {Function} [options.load=loadHolidays] 讀摘要的服務
 * @param {Function} [options.check=checkHolidays] 檢查的服務
 * @param {Function} [options.apply=applyHolidays] 套用的服務
 * @param {Function} [options.revert=revertHolidays] 還原的服務
 * @returns {{refresh: Function, runCheck: Function, runApply: Function, runRevert: Function}|null} 操作函式；頁面沒有這一區時 null
 */
export function initAdminHolidays(doc, { auth, leave, load = loadHolidays, check = checkHolidays, apply = applyHolidays, revert = revertHolidays }) {
  const section = doc.querySelector('#admin-holidays');
  if (!section) return null;
  const state = doc.querySelector('#holidays-state');
  const rows = doc.querySelector('#holidays-years');
  const form = doc.querySelector('#holidays-check-form');
  const yearInput = doc.querySelector('#holidays-year');
  const checkButton = doc.querySelector('#holidays-check');
  const preview = doc.querySelector('#holidays-preview');
  const previewSummary = doc.querySelector('#holidays-preview-summary');
  const previewList = doc.querySelector('#holidays-preview-list');
  const applyButton = doc.querySelector('#holidays-apply');
  const status = doc.querySelector('#holidays-status');
  const sourceLink = doc.querySelector('#holidays-source-link');
  let checked = null;
  let busy = false;

  /** 顯示一行狀態文字 @param {string} text 文字 @param {boolean} [error=false] 是否為錯誤 @returns {void} */
  function say(text, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }
  /** 處理錯誤：登入失效登出，其他顯示後端的固定文字 @param {unknown} failure 錯誤 @returns {void} */
  function fail(failure) {
    if (failure?.status === 401) { leave(); return; }
    say(failure?.message || '操作失敗，請稍後再試', true);
  }
  /** 切換按鈕可用狀態：處理中全部停用，套用另外要有可套用的檢查結果 @param {boolean} value 是否處理中 @returns {void} */
  function setBusy(value) {
    busy = value;
    checkButton.disabled = value;
    applyButton.disabled = value || !checked?.can_apply;
    for (const button of rows.querySelectorAll('button')) button.disabled = value;
  }
  /** 清掉預覽與檢查結果 @returns {void} */
  function clearPreview() {
    checked = null;
    preview.hidden = true;
    previewList.replaceChildren();
    applyButton.disabled = true;
  }
  /**
   * 建立一個指定標籤與文字的元素
   * @param {string} tag 標籤
   * @param {string} text 文字
   * @returns {HTMLElement} 元素
   */
  function element(tag, text) {
    const node = doc.createElement(tag);
    node.textContent = text;
    return node;
  }
  /**
   * 畫摘要：來源說明、年度表格（同步過的年度有「還原」按鈕），年度欄沒有值時帶入最晚年度
   * @param {object} summary 摘要
   * @returns {void}
   */
  function show(summary) {
    if (sourceLink) {
      sourceLink.setAttribute('href', summary.source.homepage);
      sourceLink.textContent = summary.source.id;
    }
    yearInput.setAttribute('max', String(summary.latest_year));
    if (!yearInput.value) yearInput.value = String(summary.latest_year);
    const synced = summary.years.filter(/** 同步過的年度 @param {{origin: string}} item 年度 @returns {boolean} 是時 true */ (item) => item.origin === 'synced');
    state.textContent = synced.length ? `${synced.map(/** 年度 @param {{year: number}} item 年度 @returns {number} 年度 */ (item) => item.year).join('、')} 年使用同步的假日，其他年度使用定義檔內建的假日` : '目前全部使用定義檔內建的假日，還沒有同步過';
    rows.replaceChildren(...summary.years.map(/** 一列 @param {object} item 年度摘要 @returns {HTMLElement} 列 */ (item) => {
      const row = doc.createElement('tr');
      const applied = item.origin === 'synced' ? `${item.applied_by ?? ''} ${taipeiTime(item.applied_at)}`.trim() : '—';
      row.append(element('td', String(item.year)), element('td', ORIGIN_LABELS[item.origin] ?? item.origin), element('td', `${item.dates.length} 天`), element('td', applied));
      const action = doc.createElement('td');
      if (item.origin === 'synced') {
        const button = element('button', '還原成定義檔');
        button.setAttribute('type', 'button');
        button.className = 'secondary-button';
        button.disabled = busy;
        button.addEventListener('click', /** 還原這一年 @returns {Promise<void>} 完成 */ () => runRevert(item.year));
        action.append(button);
      } else action.textContent = '—';
      row.append(action);
      return row;
    }));
  }
  /**
   * 畫檢查結果：差異摘要、新增與移除的日期、補班日的原因
   * @param {object} result 檢查結果
   * @returns {void}
   */
  function showPreview(result) {
    checked = result;
    const changed = result.added.length + result.removed.length;
    previewSummary.textContent = changed
      ? `${result.year} 年：新增 ${result.added.length} 天、移除 ${result.removed.length} 天、沒變 ${result.unchanged} 天`
      : `${result.year} 年：和目前使用的假日相同（${result.unchanged} 天）；套用後改由同步資料提供`;
    const items = [
      ...result.added.map(/** 新增 @param {object} item 假日 @returns {HTMLElement} 項目 */ (item) => element('li', `＋ ${holidayText(item)}`)),
      ...result.removed.map(/** 移除 @param {object} item 假日 @returns {HTMLElement} 項目 */ (item) => element('li', `－ ${holidayText(item)}`)),
    ];
    if (result.blocked_reason) items.push(element('li', `! ${result.blocked_reason}（補班日：${result.makeup_days.map(holidayText).join('、')}）`));
    previewList.replaceChildren(...items);
    applyButton.textContent = `套用 ${result.year} 年的假日`;
    preview.hidden = false;
    applyButton.disabled = !result.can_apply;
  }

  /** 重新讀摘要 @returns {Promise<void>} 完成 */
  async function refresh() {
    try { show(await load(auth)); } catch (failure) { fail(failure); }
  }
  /**
   * 檢查年度欄指定的年度；年度不是四位數整數時不送出
   * @param {{preventDefault?: Function}} [event] 表單送出事件
   * @returns {Promise<void>} 完成
   */
  async function runCheck(event) {
    event?.preventDefault?.();
    if (busy) return;
    const year = Number(yearInput.value);
    if (!Number.isInteger(year) || year < 1000 || year > 9999) { say('請輸入四位數的西元年度', true); return; }
    clearPreview();
    setBusy(true);
    say(`正在檢查 ${year} 年的假日資料…`);
    try {
      const result = await check(year, auth);
      showPreview(result);
      say(result.can_apply ? '確認差異後按「套用」；套用前不會改變任何計算' : '這一年不能套用，原因列在上方', !result.can_apply);
    } catch (failure) { fail(failure); } finally { setBusy(false); }
  }
  /** 套用目前的檢查結果；來源變了時清掉預覽請管理員重新檢查 @returns {Promise<void>} 完成 */
  async function runApply() {
    if (busy || !checked?.can_apply) return;
    const { year, digest } = checked;
    setBusy(true);
    say(`正在套用 ${year} 年的假日…`);
    try {
      show(await apply({ year, digest }, auth));
      clearPreview();
      say(`已套用 ${year} 年的假日；之後的時數計算與助理建議都會使用新的資料，已送出的單不受影響`);
    } catch (failure) {
      if (failure?.code === 'HOLIDAYS_CHANGED') clearPreview();
      fail(failure);
    } finally { setBusy(false); }
  }
  /**
   * 還原某年度成定義檔的假日
   * @param {number} year 年度
   * @returns {Promise<void>} 完成
   */
  async function runRevert(year) {
    if (busy) return;
    setBusy(true);
    say(`正在還原 ${year} 年…`);
    try {
      show(await revert(year, auth));
      if (checked?.year === year) clearPreview();
      say(`已把 ${year} 年還原成定義檔內建的假日`);
    } catch (failure) { fail(failure); } finally { setBusy(false); }
  }

  form.addEventListener('submit', runCheck);
  applyButton.addEventListener('click', runApply);
  yearInput.addEventListener('input', /** 改了年度就清掉舊的預覽 @returns {void} */ () => { if (checked) clearPreview(); });
  clearPreview();
  refresh();
  return { refresh, runCheck, runApply, runRevert };
}
