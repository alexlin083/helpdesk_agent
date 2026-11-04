import { PAGE_URLS } from '../pageUrls.js';
import { authService } from '../services/authService.js';
import { QUOTA_CODES } from '../services/ticketService.js';

export const LOGIN_TEXT = {
  required: '請輸入帳號與密碼',
  submit: '登入',
  submitting: '登入中…',
  show: '顯示',
  hide: '隱藏',
};
const MAX_COUNTDOWN_SECONDS = 300;

/**
 * 初始化登入頁：已登入時依後端角色前往管理頁或提出需求單頁；提交時先做必填檢查，再呼叫後端登入。
 * @param {Document} [doc=document] 頁面文件，測試可注入替身。
 * 後端回 429 且不是額度錯誤（例如 LOGIN_RATE_LIMITED）時，依 retry_after 讓登入鈕倒數（最多 300 秒）。
 * @param {Window} [win=window] 視窗物件，提供導頁、計時器與 pageshow／pagehide 事件。
 * @param {object} [auth=authService] 登入服務。
 * @returns {{handleLogin: Function, togglePassword: Function, checkSession: Function, remainingWait: Function}} 事件處理函式與剩餘等待秒數，供測試直接呼叫。
 */
export function initLoginPage(doc = document, win = window, auth = authService) {
  const form = doc.querySelector('#login-form');
  const username = doc.querySelector('#username');
  const password = doc.querySelector('#password');
  const toggle = doc.querySelector('#password-toggle');
  const errorMessage = doc.querySelector('#login-error');
  const button = doc.querySelector('#login-button');
  const state = { submitting: false, waitUntil: 0, waitTimer: null };

  /**
   * 計算後端要求的剩餘等待秒數，從目前時間推算，避免背景分頁計時器節流累積誤差。
   * @returns {number} 向上取整的剩餘秒數，最小為零。
   */
  function remainingWait() { return Math.max(0, Math.ceil((state.waitUntil - Date.now()) / 1000)); }

  /**
   * 合併登入中與等待倒數決定登入鈕的文字與可用狀態。
   * @returns {void}
   */
  function updateButton() {
    const remaining = remainingWait();
    button.disabled = state.submitting || remaining > 0;
    button.textContent = state.submitting ? LOGIN_TEXT.submitting : remaining > 0 ? `請等 ${remaining} 秒` : LOGIN_TEXT.submit;
  }

  /**
   * 停止倒數計時器；剩餘秒數仍保留在 waitUntil，頁面恢復時可接續。
   * @returns {void}
   */
  function stopTimer() {
    if (state.waitTimer === null) return;
    win.clearInterval(state.waitTimer);
    state.waitTimer = null;
  }

  /**
   * 倒數每 250 ms 更新按鈕文字，到期後移除計時器並恢復登入鈕。
   * @returns {void}
   */
  function tickWait() {
    if (remainingWait() === 0) stopTimer();
    updateButton();
  }

  /**
   * 依後端的等待秒數開始倒數；沒有秒數或超過 300 秒時不倒數，只顯示提示。
   * @param {number} seconds 後端要求的等待秒數。
   * @returns {void}
   */
  function startWait(seconds) {
    if (!(seconds > 0) || seconds > MAX_COUNTDOWN_SECONDS) return;
    stopTimer();
    state.waitUntil = Date.now() + seconds * 1000;
    state.waitTimer = win.setInterval(tickWait, 250);
    updateButton();
  }

  /**
   * 離開頁面（pagehide）時清除倒數計時器，避免背景計時器殘留。
   * @returns {void}
   */
  function handlePageHide() { stopTimer(); }

  /**
   * 從瀏覽器快取恢復登入頁時重查登入狀態；倒數尚未結束則重新啟動計時器並更新按鈕。
   * @returns {void}
   */
  function handlePageShow() {
    checkSession();
    if (remainingWait() > 0 && state.waitTimer === null) state.waitTimer = win.setInterval(tickWait, 250);
    updateButton();
  }

  /**
   * 已登入時依身分進入管理頁或提出需求單頁；由模組位置建立網址，支援頁面子資料夾與 GitHub Pages 的專案子路徑。
   * @returns {void} 含從瀏覽器快取恢復登入頁時的狀態檢查。
   */
  function checkSession() {
    const user = auth.getCurrentUser();
    if (user) win.location.replace(user.role === 'ADMIN' ? PAGE_URLS.admin : PAGE_URLS.propose);
  }

  /**
   * 切換密碼欄位的遮蔽與顯示，並同步按鈕文字與 aria-pressed。
   * @returns {void}
   */
  function togglePassword() {
    const visible = password.type === 'text';
    password.type = visible ? 'password' : 'text';
    toggle.textContent = visible ? LOGIN_TEXT.show : LOGIN_TEXT.hide;
    toggle.setAttribute('aria-pressed', String(!visible));
    password.focus();
  }

  /**
   * 提交帳密：兩欄只有空白也算空白，此時不清空密碼；請求結束後不論成功、失敗或連線失敗一律清空密碼。
   * 成功後一般帳號進入提出需求單頁，管理員進入管理頁；失敗顯示後端或連線提示，不標示欄位。
   * 429 非額度錯誤且 0 < retryAfter ≤ 300 時，登入鈕停用並顯示「請等 N 秒」倒數，倒數中再次送出會被忽略。
   * @param {SubmitEvent} event 原生登入表單提交事件。
   * @returns {Promise<void>} 等待後端登入，期間鎖定按鈕防止重複送出；不呼叫 Gemini。
   */
  async function handleLogin(event) {
    event.preventDefault();
    if (state.submitting || remainingWait() > 0) return;
    errorMessage.textContent = '';
    if (!username.value.trim() || !password.value.trim()) {
      errorMessage.textContent = LOGIN_TEXT.required;
      (username.value.trim() ? password : username).focus();
      return;
    }
    state.submitting = true;
    updateButton();
    try {
      const user = await auth.login(username.value, password.value);
      password.value = '';
      stopTimer();
      win.location.replace(user.role === 'ADMIN' ? PAGE_URLS.admin : PAGE_URLS.propose);
    } catch (error) {
      password.value = '';
      errorMessage.textContent = error instanceof Error && error.message ? error.message : '登入失敗，請稍後再試';
      if (error?.status === 429 && !QUOTA_CODES.includes(error.code)) startWait(error.retryAfter);
      password.focus();
    } finally {
      state.submitting = false;
      updateButton();
    }
  }

  form.addEventListener('submit', handleLogin);
  toggle.addEventListener('click', togglePassword);
  win.addEventListener('pageshow', handlePageShow);
  win.addEventListener('pagehide', handlePageHide);
  checkSession();
  return { handleLogin, togglePassword, checkSession, remainingWait };
}

// 真實瀏覽器載入時自動初始化；測試以替身文件明確呼叫 initLoginPage。
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initLoginPage();
