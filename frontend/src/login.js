import { authService } from './services/authService.js';

export const LOGIN_TEXT = {
  required: '請輸入帳號與密碼',
  submit: '登入',
  submitting: '登入中…',
  show: '顯示',
  hide: '隱藏',
};

/**
 * 初始化登入頁：已登入時直接前往提出需求單頁；提交時先做必填檢查，再呼叫後端登入。
 * @param {Document} [doc=document] 頁面文件，測試可注入替身。
 * @param {Window} [win=window] 視窗物件，提供導頁與 pageshow 事件。
 * @param {object} [auth=authService] 登入服務。
 * @returns {{handleLogin: Function, togglePassword: Function, checkSession: Function}} 事件處理函式，供測試直接呼叫。
 */
export function initLoginPage(doc = document, win = window, auth = authService) {
  const form = doc.querySelector('#login-form');
  const username = doc.querySelector('#username');
  const password = doc.querySelector('#password');
  const toggle = doc.querySelector('#password-toggle');
  const errorMessage = doc.querySelector('#login-error');
  const button = doc.querySelector('#login-button');

  /**
   * 已登入時直接進入提出需求單頁；相對位址支援 GitHub Pages 的專案子路徑。
   * @returns {void} 含從瀏覽器快取恢復登入頁時的狀態檢查。
   */
  function checkSession() {
    if (auth.getCurrentUser()) win.location.replace('./propose.html');
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
   * 成功後進入提出需求單頁；失敗顯示後端或連線提示，不標示欄位。
   * @param {SubmitEvent} event 原生登入表單提交事件。
   * @returns {Promise<void>} 等待後端登入，期間鎖定按鈕防止重複送出；不呼叫 Gemini。
   */
  async function handleLogin(event) {
    event.preventDefault();
    if (button.disabled) return;
    errorMessage.textContent = '';
    if (!username.value.trim() || !password.value.trim()) {
      errorMessage.textContent = LOGIN_TEXT.required;
      (username.value.trim() ? password : username).focus();
      return;
    }
    button.disabled = true;
    button.textContent = LOGIN_TEXT.submitting;
    try {
      await auth.login(username.value, password.value);
      password.value = '';
      win.location.replace('./propose.html');
    } catch (error) {
      password.value = '';
      errorMessage.textContent = error instanceof Error && error.message ? error.message : '登入失敗，請稍後再試';
      password.focus();
    } finally {
      button.disabled = false;
      button.textContent = LOGIN_TEXT.submit;
    }
  }

  form.addEventListener('submit', handleLogin);
  toggle.addEventListener('click', togglePassword);
  win.addEventListener('pageshow', checkSession);
  checkSession();
  return { handleLogin, togglePassword, checkSession };
}

// 真實瀏覽器載入時自動初始化；測試以替身文件明確呼叫 initLoginPage。
if (typeof document !== 'undefined' && typeof document.readyState === 'string') initLoginPage();
