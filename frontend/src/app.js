import { ChatPanel } from './components/ChatPanel.js';
import { DecisionPanel } from './components/DecisionPanel.js';
import { sendChatMessage, getUsage } from './services/agentService.js';
import { authService } from './services/authService.js';

const user = authService.getCurrentUser();
let decisions;
let chat;
if (user) {
  document.querySelector('#current-user').textContent = `${user.username} · ${user.userID}`;
  document.querySelector('#logout-button').addEventListener('click', handleLogout);
  decisions = new DecisionPanel(document.querySelector('#decision-panel'));
  chat = new ChatPanel(document.querySelector('#chat-panel'), handleMessage);
  document.body.hidden = false;
  refreshUsage();
} else {
  window.location.replace('./index.html');
}
window.addEventListener('pageshow', checkSession);

/**
 * 讀取用量並同步後端冷卻，登入到期時清除憑證並導回登入。
 * @returns {Promise<void>} 非授權錯誤僅顯示提示，不隱藏既有對話。
 */
async function refreshUsage() {
  const status = document.querySelector('#usage-status');
  try {
    const usage = await getUsage();
    const reset = new Date(usage.resetAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    status.textContent = `今日帳號剩餘 ${usage.userRemaining} / ${usage.userDailyLimit} 次 · 全站剩餘 ${usage.globalRemaining} / ${usage.globalDailyLimit} 次 · 台北時間 ${reset} 重置`;
    if (usage.cooldownSeconds > 0) chat.startCooldown(usage.cooldownSeconds);
  } catch (error) {
    if (error.status === 401) { handleLogout(); return; }
    status.textContent = error.message;
  }
}

/**
 * 頁面從快取恢復時重查登入，避免登出或換帳號後顯示上一個帳號的聊天內容。
 * @returns {void} 未登入導回首頁，帳號變動則重新載入聊天元件。
 */
function checkSession() {
  const current = authService.getCurrentUser();
  if (!current) {
    document.body.hidden = true;
    window.location.replace('./index.html');
  } else if (current.userID !== user?.userID) {
    document.body.hidden = true;
    window.location.reload();
  }
}

/**
 * 清除目前分頁的登入狀態並返回登入頁；導頁後不保留聊天紀錄。
 * @returns {void} 儲存體操作失敗時在聊天區顯示提示。
 */
function handleLogout() {
  try {
    authService.logout();
    document.body.hidden = true;
    window.location.replace('./index.html');
  } catch (error) { chat.addMessage('error', error.message); }
}

/**
 * 協調一次完整問答：新增提問、鎖定表單、呼叫 service，並分別更新聊天與決策元件。
 * 失敗時清除舊決策並顯示錯誤，保留輸入供手動重試；請求結束後仍須等十秒冷卻到期才能再送出。
 * 聊天紀錄僅保留於目前頁面，送往後端的內容為單次問題與當前帳號 userID。
 * @param {string} message 已由聊天元件去空白並驗證的問題。
 * @returns {Promise<void>} 本次回覆顯示或錯誤處理完成。
 */
async function handleMessage(message) {
  const current = authService.getCurrentUser();
  if (!current || current.userID !== user.userID) {
    checkSession();
    return;
  }
  chat.setBusy(true);
  chat.addMessage('user', message);
  decisions.showState('正在分析你的問題', '檢索知識庫並等待 Gemini 決策，完成後將顯示實際回應資料。');
  try {
    chat.startCooldown();
    const response = await sendChatMessage(message, current.userID);
    decisions.render(response);
    await chat.showReply(response.reply_text);
    chat.clearInput();
  } catch (error) {
    if (error.status === 401 || error.code === 'LOGIN_REQUIRED') { handleLogout(); return; }
    if (error.retryAfter > 0 && !['DAILY_QUOTA_EXCEEDED', 'GLOBAL_QUOTA_EXCEEDED'].includes(error.code)) chat.startCooldown(error.retryAfter);
    chat.addMessage('error', error.message);
    decisions.showState('這次查詢未完成', error.message);
  } finally {
    chat.setBusy(false);
    refreshUsage();
  }
}
