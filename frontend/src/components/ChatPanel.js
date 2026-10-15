import { element } from './dom.js';

export class ChatPanel {
  /**
   * 建立聊天紀錄、範例問題與輸入表單，只負責畫面，不直接依賴 API。
   * @param {HTMLElement} root 聊天區塊的掛載節點。
   * @param {(message: string) => Promise<void>} onSend 提交問題後由應用程式執行的處理函式。
   */
  constructor(root, onSend) {
    root.innerHTML = `
      <div class="panel-heading"><div><span class="eyebrow">YOUR WORK COMPANION</span><h2>服務台對話</h2></div><span class="pill">單次問答</span></div>
      <div class="messages" role="log" aria-label="聊天紀錄" aria-live="polite" aria-relevant="additions"></div>
      <div class="composer-area">
        <div class="examples" aria-label="範例問題"><button type="button">VPN 連不上如何排查？</button><button type="button">請問如何申請特休？</button><button type="button">辦公室螢幕冒煙了！</button></div>
        <p class="chat-status" role="status"></p>
        <form class="composer"><label class="sr-only" for="message">你的問題</label><input id="message" name="message" placeholder="輸入工作上的疑問…" autocomplete="off" required aria-describedby="input-hint"><button class="send-button" type="submit">送出 <span aria-hidden="true">↗</span></button></form>
        <p class="cooldown-status" role="status" aria-live="polite"></p>
        <div class="input-meta"><span id="input-hint">Enter 送出 · 每次問題獨立處理</span><span class="counter">0 / 500</span></div>
      </div>`;
    this.root = root;
    this.messages = root.querySelector('.messages');
    this.input = root.querySelector('input');
    this.status = root.querySelector('.chat-status');
    this.counter = root.querySelector('.counter');
    this.cooldownStatus = root.querySelector('.cooldown-status');
    this.cooldownUntil = 0;
    this.cooldownTimer = null;
    this.onSend = onSend;
    this.busy = false;
    root.querySelector('form').addEventListener('submit', this.handleSubmit.bind(this));
    this.input.addEventListener('input', this.updateCount.bind(this));
    for (const button of root.querySelectorAll('.examples button')) {
      button.addEventListener('click', this.selectExample.bind(this));
    }
    this.addMessage('assistant', '你好，我是你的智慧服務台助手。\n可以詢問 IT 排查、人事規章或設備報修問題，我會參考企業知識庫提供協助。');
  }

  /**
   * 將點選的範例填入輸入框，保留使用者確認與修改的機會，不直接發送請求。
   * @param {MouseEvent} event 範例按鈕的點擊事件。
   * @returns {void}
   */
  selectExample(event) {
    this.input.value = event.currentTarget.textContent;
    this.updateCount();
    this.input.focus();
  }

  /**
   * 以 Unicode code points 計算去空白後的字數，與後端驗證方式一致。
   * @returns {void} 更新字數提示；超過上限時顯示警示樣式。
   */
  updateCount() {
    const count = Array.from(this.input.value.trim()).length;
    this.counter.textContent = `${count} / 500`;
    this.counter.classList.toggle('over-limit', count > 500);
  }

  /**
   * 攔截表單、驗證字數並交由應用程式送出；處理中或十秒冷卻未結束時忽略提交。
   * @param {SubmitEvent} event 原生表單提交事件。
   * @returns {Promise<void>} 等待本次提問處理完成。
   */
  async handleSubmit(event) {
    event.preventDefault();
    if (this.busy || this.remainingCooldown() > 0) return;
    const message = this.input.value.trim();
    if (!message || Array.from(message).length > 500) {
      this.status.textContent = '請輸入 1～500 字元的問題。';
      this.input.focus();
      return;
    }
    await this.onSend(message);
  }

  /**
   * 加入一則純文字訊息並捲動至底部；錯誤訊息不會冒充 AI 回答。
   * @param {'user'|'assistant'|'error'} role 訊息角色。
   * @param {string} text 完整訊息文字。
   * @returns {HTMLElement} 訊息文字節點，供打字動畫更新。
   */
  addMessage(role, text) {
    const row = element('article', `message ${role}`);
    const label = role === 'user' ? '你' : role === 'error' ? '系統提示' : '智慧服務台';
    const bubble = element('div', 'bubble', text);
    row.append(element('span', 'message-label', label), bubble);
    this.messages.append(row);
    this.messages.scrollTop = this.messages.scrollHeight;
    return bubble;
  }

  /**
   * 以短批次逐字顯示 AI 回覆；偏好減少動態效果時直接顯示全文。
   * @param {string} text 已取得的完整回答，不代表串流 API。
   * @returns {Promise<void>} 全文顯示完成後結束。
   */
  async showReply(text) {
    const bubble = this.addMessage('assistant', '');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      bubble.textContent = text;
      return;
    }
    const characters = Array.from(text);
    const step = Math.max(3, Math.ceil(characters.length / 80));
    for (let index = step; index < characters.length + step; index += step) {
      bubble.textContent = characters.slice(0, index).join('');
      this.messages.scrollTop = this.messages.scrollHeight;
      await this.waitFrame();
    }
  }

  /**
   * 等待一個短動畫間隔，避免長文字同步渲染阻塞畫面。
   * @returns {Promise<void>} 約 16 毫秒後繼續。
   */
  waitFrame() {
    return new Promise(this.scheduleFrame);
  }

  /**
   * 為動畫 Promise 安排計時器，回呼不讀取元件狀態。
   * @param {() => void} resolve Promise 的完成函式。
   * @returns {void}
   */
  scheduleFrame(resolve) {
    window.setTimeout(resolve, 16);
  }

  /**
   * 切換 API 處理狀態與等待提示；回應結束後可輸入，但送出仍受十秒冷卻限制。
   * 失敗時也不提前解除冷卻，保留原問題供倒數結束後重試。
   * @param {boolean} busy 是否正在等待或顯示回覆。
   * @returns {void}
   */
  setBusy(busy) {
    this.busy = busy;
    for (const control of this.root.querySelectorAll('input, button')) control.disabled = busy;
    this.messages.setAttribute('aria-busy', String(busy));
    this.status.textContent = busy ? '正在檢索知識庫並等待 Gemini 回覆，首次查詢可能較久…' : '';
    this.updateSendState();
    if (!busy) this.input.focus();
  }

  /**
   * 從目前時間計算剩餘秒數，避免背景分頁的計時器節流造成累積誤差。
   * @returns {number} 向上取整的剩餘秒數，最小為零。
   */
  remainingCooldown() {
    return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
  }

  /**
   * 在即將呼叫對話 API 時開始十秒冷卻；成功或失敗都維持相同等待期限。
   * @param {number} [seconds=10] 後端要求的秒數，預設十秒；不縮短既有冷卻。
   * @returns {void} 立即顯示倒數，並定期依實際截止時間更新。
   */
  startCooldown(seconds = 10) {
    if (this.cooldownTimer !== null) globalThis.clearInterval(this.cooldownTimer);
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + seconds * 1000);
    this.updateSendState();
    this.cooldownTimer = globalThis.setInterval(this.tickCooldown.bind(this), 250);
  }

  /**
   * 更新倒數，到期後移除計時器；即使到期，API 尚未完成時仍保持送出鎖定。
   * @returns {void}
   */
  tickCooldown() {
    if (this.remainingCooldown() === 0) {
      globalThis.clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.updateSendState();
  }

  /**
   * 合併 API 忙碌與冷卻狀態決定按鈕及輸入框下方說明，避免回應提前解除按鈕。
   * @returns {void} 不改動問題內容或 API 處理提示。
   */
  updateSendState() {
    const remaining = this.remainingCooldown();
    const button = this.root.querySelector('.send-button');
    button.disabled = this.busy || remaining > 0;
    button.textContent = this.busy ? '處理中…' : remaining > 0 ? `等待 ${remaining} 秒` : '送出 ↗';
    this.cooldownStatus.textContent = remaining > 0
      ? `為避免連續送出，請等待 ${remaining} 秒後再試（依後端等待時間調整）。`
      : this.cooldownUntil > 0
        ? this.busy ? '10 秒等待已結束，仍在等待 AI 回覆完成。' : '等待已結束，可以再次送出問題。'
        : '';
  }

  /**
   * 成功取得回覆後清除輸入與字數，保留聊天紀錄。
   * @returns {void}
   */
  clearInput() {
    this.input.value = '';
    this.updateCount();
  }
}
