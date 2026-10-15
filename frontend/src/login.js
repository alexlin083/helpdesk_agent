import { authService } from './services/authService.js';

const form = document.querySelector('#login-form');
const errorMessage = document.querySelector('#login-error');
form.addEventListener('submit', handleLogin);
window.addEventListener('pageshow', checkSession);
checkSession();

/**
 * 已登入時直接進入聊天頁；相對位址支援 GitHub Pages 的專案子路徑。
 * @returns {void} 含從瀏覽器快取恢復登入頁時的狀態檢查。
 */
function checkSession() {
  if (authService.getCurrentUser()) window.location.replace('./chat.html');
}

/**
 * 提交展示帳密，成功後進入聊天頁；失敗則保留帳號、清除密碼並顯示中文錯誤。
 * @param {SubmitEvent} event 原生登入表單提交事件。
 * @returns {Promise<void>} 等待後端登入，期間鎖定按鈕防止重複送出；不呼叫 Gemini。
 */
async function handleLogin(event) {
  event.preventDefault();
  const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '登入中…';
  errorMessage.textContent = '';
  const username = form.elements.namedItem('username');
  const password = form.elements.namedItem('password');
  try {
    await authService.login(username.value, password.value);
    password.value = '';
    window.location.replace('./chat.html');
  } catch (error) {
    errorMessage.textContent = error.message;
    password.value = '';
    password.focus();
  } finally {
    button.disabled = false;
    button.textContent = '登入服務台 ↗';
  }
}
