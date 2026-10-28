/**
 * 初始化管理重置表單；集中管理確認文字、重送防護、結果與錯誤提示，並協調監測的暫停／恢復。
 * 元件不讀取帳號或直接存取 API，由頁面提供登入服務與獨立重置服務。
 * @param {Document} doc 頁面文件，可注入測試替身。
 * @param {object} options 依賴與生命週期。
 * @param {object} options.auth 已完成管理員驗證的登入服務，供重置 API 取得 token。
 * @param {Function} options.reset 接收確認文字與登入服務的非同步重置函式，不自動重試。
 * @param {object} options.monitoring 監測控制器，提供 suspend、resume 與 destroy。
 * @param {Function} options.leave 登入失效後清除工作階段並導回登入頁。
 * @returns {{submit: Function, updateButton: Function}} 表單控制器。
 */
export function initAdminReset(doc, { auth, reset, monitoring, leave }) {
  const form = doc.querySelector('#reset-form');
  const confirmation = doc.querySelector('#reset-confirmation');
  const button = doc.querySelector('#reset-button');
  const status = doc.querySelector('#reset-status');
  let busy = false;
  /** 只在完整輸入確認文字且沒有請求時啟用按鈕。@returns {void} */
  function updateButton() { button.disabled = busy || confirmation.value !== 'RESET_HELPDESK'; }
  /**
   * 提交一次重置，期間鎖定輸入與按鈕；顯示筆數與時間，401 清除登入後回首頁。
   * @param {SubmitEvent} event 表單提交事件。
   * @returns {Promise<void>} 完成本次操作，不自動重試。
   */
  async function submit(event) {
    event.preventDefault();
    if (busy || confirmation.value !== 'RESET_HELPDESK') return;
    busy = true;
    monitoring.suspend();
    confirmation.disabled = true;
    updateButton();
    status.textContent = '維護中，正在等待既有操作結束並重置資料…';
    try {
      const result = await reset(confirmation.value, auth);
      confirmation.value = '';
      status.textContent = `已清除 ${result.deletedTickets} 筆工作單，限量與限流已重置。\n完成時間：${new Date(result.resetAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`;
    } catch (error) {
      if (error.status === 401) { monitoring.destroy(); leave(); return; }
      status.textContent = error.message || '重置失敗，請稍後確認';
    } finally { busy = false; confirmation.disabled = false; updateButton(); await monitoring.resume(); }
  }
  confirmation.addEventListener('input', updateButton);
  form.addEventListener('submit', submit);
  updateButton();
  return { submit, updateButton };
}
