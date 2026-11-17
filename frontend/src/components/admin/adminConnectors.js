import { loadGoogleSettings, saveGoogleSettings } from '../../services/connectorService.js';

/**
 * 管理頁的「Google 連接設定」：顯示要貼到 Google Cloud 的回呼網址與目前狀態，儲存用戶端 ID 與密鑰
 * 密鑰只寫不讀：後端不回傳，畫面每次儲存都要重新輸入，送出後不論成功失敗都清空輸入欄；欄位關掉自動填入，並請密碼管理工具不要存；頁面沒有這一區時不初始化
 * @param {Document} doc 頁面文件
 * @param {Window} win 視窗物件（複製回呼網址用）
 * @param {object} options 選項
 * @param {object} options.auth 登入服務
 * @param {Function} options.leave 登入失效時登出回登入頁
 * @param {Function} [options.load=loadGoogleSettings] 讀設定的服務
 * @param {Function} [options.save=saveGoogleSettings] 存設定的服務
 * @returns {{refresh: Function, submit: Function}|null} 重新讀取與送出的函式；頁面沒有這一區時 null
 */
export function initAdminConnectors(doc, win, { auth, leave, load = loadGoogleSettings, save = saveGoogleSettings }) {
  const section = doc.querySelector('#admin-connectors');
  if (!section) return null;
  const form = doc.querySelector('#google-settings-form');
  const clientId = doc.querySelector('#google-client-id');
  const clientSecret = doc.querySelector('#google-client-secret');
  const saveButton = doc.querySelector('#google-settings-save');
  const redirect = doc.querySelector('#google-redirect-uri');
  const copy = doc.querySelector('#google-copy-redirect');
  const state = doc.querySelector('#google-settings-state');
  const status = doc.querySelector('#google-settings-status');

  /** 顯示一行狀態文字 @param {string} text 文字 @param {boolean} [error=false] 是否為錯誤 @returns {void} */
  function say(text, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }
  /**
   * 把設定摘要畫到畫面上：回呼網址、是否已設定、最後更新者；用戶端 ID 只在欄位是空的時候帶入，不蓋掉管理員正在輸入的值
   * @param {object} settings 設定摘要
   * @returns {void}
   */
  function show(settings) {
    redirect.textContent = settings.redirect_uri;
    if (!clientId.value) clientId.value = settings.client_id;
    if (settings.configured) {
      const when = Number.isFinite(Date.parse(settings.updated_at)) ? new Date(settings.updated_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '';
      state.textContent = `已設定${settings.updated_by ? `，由 ${settings.updated_by}` : ''}${when ? ` 於 ${when}` : ''} 更新；員工可以在「連接帳號」頁連接`;
    } else state.textContent = settings.client_id ? '有舊的設定但解不開（可能更換過伺服器金鑰），請重新輸入用戶端密鑰並儲存' : '尚未設定，員工暫時不能連接 Google 行事曆';
  }
  /**
   * 處理錯誤：登入失效登出，其他顯示後端的固定文字
   * @param {unknown} failure 錯誤
   * @returns {void}
   */
  function fail(failure) {
    if (failure?.status === 401) { leave(); return; }
    say(failure?.message || '操作失敗，請稍後再試', true);
  }
  /** 重新讀設定 @returns {Promise<void>} 完成 */
  async function refresh() {
    try { show(await load(auth)); } catch (failure) { fail(failure); }
  }
  /**
   * 送出設定：先在畫面檢查格式（1～300 字、不含空白），送出後不論成功失敗都清空密鑰欄
   * @param {{preventDefault?: Function}} [event] 表單送出事件
   * @returns {Promise<void>} 完成
   */
  async function submit(event) {
    event?.preventDefault?.();
    const id = clientId.value.trim();
    const secret = clientSecret.value.trim();
    if (!id || id.length > 300 || /\s/.test(id)) { say('用戶端 ID 必須是 1～300 字、不含空白', true); return; }
    if (!secret || secret.length > 300 || /\s/.test(secret)) { say('用戶端密鑰必須是 1～300 字、不含空白；每次儲存都要重新輸入', true); return; }
    saveButton.disabled = true;
    say('儲存中…');
    try {
      const saved = await save({ clientId: id, clientSecret: secret }, auth);
      show(saved);
      say('已儲存 Google 連接設定');
    } catch (failure) { fail(failure); } finally {
      clientSecret.value = '';
      saveButton.disabled = false;
    }
  }
  /** 複製回呼網址到剪貼簿 @returns {Promise<void>} 完成 */
  async function copyRedirect() {
    try { await win.navigator.clipboard.writeText(redirect.textContent); say('已複製回呼網址'); } catch { say('無法自動複製，請手動選取回呼網址', true); }
  }
  form.addEventListener('submit', submit);
  copy?.addEventListener('click', copyRedirect);
  refresh();
  return { refresh, submit };
}
