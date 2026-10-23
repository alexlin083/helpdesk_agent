import { authService } from '../services/authService.js';

/**
 * 初始化頂欄的帳號選單與登入守門：未登入導回登入頁；顯示帳號、使用者代號與所屬部門；綁定登出與 pageshow 檢查。
 * 提出需求單頁與狀態追蹤頁共用。
 * @param {Document} doc 頁面文件。
 * @param {Window} win 視窗物件。
 * @param {object} [auth=authService] 登入服務。
 * @returns {{user: object|null, leave: Function, checkSession: Function}} 目前身分（未登入為 null）與離開、檢查函式。
 */
export function initAccountMenu(doc, win, auth = authService) {
  /**
   * 清除本分頁登入狀態並回到登入頁；已輸入但未送出的內容不保留。
   * @returns {void}
   */
  function leave() {
    try { auth.logout(); } catch { /* 儲存體不可用時仍導回登入頁。 */ }
    doc.body.hidden = true;
    win.location.replace('./index.html');
  }
  const user = auth.getCurrentUser();
  if (!user) { leave(); return { user: null, leave, checkSession: leave }; }

  const name = doc.querySelector('#account-name');
  const id = doc.querySelector('#account-id');
  const avatar = doc.querySelector('#account-avatar');
  const department = doc.querySelector('#account-department');
  const logout = doc.querySelector('#logout-button');
  if (name) name.textContent = user.username;
  if (id) id.textContent = user.userID;
  if (avatar) avatar.textContent = user.username.slice(0, 1).toUpperCase();
  if (department) department.textContent = user.department.name;

  /**
   * 頁面從快取恢復時重查登入狀態；未登入導回登入頁，帳號變動則重新載入。
   * @returns {void}
   */
  function checkSession() {
    const current = auth.getCurrentUser();
    if (!current) leave();
    else if (current.userID !== user.userID) { doc.body.hidden = true; win.location.reload(); }
  }
  if (logout) logout.addEventListener('click', leave);
  win.addEventListener('pageshow', checkSession);
  return { user, leave, checkSession };
}
