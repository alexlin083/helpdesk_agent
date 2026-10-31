const HTTP_NAMES = { api: '一般 API 入口', login: '登入總請求', ticket: '提單／簽核／轉單／取消', departments: '部門名單', query: '工作單查詢' };

/**
 * 以台北時區顯示取樣、重置與程序啟動時間，不依使用者電腦時區。
 * @param {string} value 後端提供的 ISO 時間。
 * @returns {string} 繁體中文日期時間。
 */
export function metricsTime(value) { return new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }); }

/**
 * 將程序運行秒數依序拆成月、天、小時、分、秒，滿單位自動進位並省略零值單位。
 * 月固定以 30 天換算，含月份時附上換算說明，不代表日曆月份；未滿一秒捨去小數。
 * 非有限數值、非數字或負數顯示「未知」，零秒則顯示「0 秒」。不修改輸入資料。
 * @param {number} seconds 後端提供的程序運行秒數。
 * @returns {string} 可閱讀的運行時長，或無效數值的替代文字。
 */
export function metricsUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '未知';
  let remaining = Math.floor(seconds);
  const parts = [];
  const hasMonths = remaining >= 2592000;
  for (const [unit, size] of [['個月', 2592000], ['天', 86400], ['小時', 3600], ['分', 60], ['秒', 1]]) {
    const value = Math.floor(remaining / size);
    remaining %= size;
    if (value > 0) parts.push(`${value} ${unit}`);
  }
  return parts.length ? `${parts.join(' ')}${hasMonths ? '（每月以 30 天計）' : ''}` : '0 秒';
}

/**
 * 繪製管理監測快照；動態資料只透過 textContent，避免將帳號或部門名稱解析為 HTML。
 * 表格數值表示目前有效視窗的合計，不當作每秒流量或啟動以來的累計。
 * 程序啟動時間使用台北時區，運行秒數轉成自動進位的可讀時長。
 * @param {Document} doc 頁面文件，可注入測試替身。
 * @param {object} data 經 adminService 驗證的快照。
 * @returns {void} 更新指標、設定、帳號與 HTTP／登入摘要。
 */
export function renderAdminMetrics(doc, data) {
  /** 建立安全文字節點。@param {string} tag 標籤。@param {unknown} text 文字。@param {string} [className=''] 樣式。@returns {HTMLElement} 節點。 */
  function node(tag, text, className = '') { const element = doc.createElement(tag); element.textContent = String(text); element.className = className; return element; }
  /** 寫入單一既有節點。@param {string} id 元素 id。@param {unknown} value 文字值。@returns {void} */
  function write(id, value) { doc.querySelector(`#${id}`).textContent = String(value); }
  /** 加入一列文字表格。@param {HTMLElement} parent tbody。@param {Array<unknown>} values 儲存格值。@returns {void} */
  function row(parent, values) { const tr = doc.createElement('tr'); for (const value of values) tr.append(node('td', value)); parent.append(tr); }
  const { ai, runtime, monitoring } = data;
  const cards = doc.querySelector('#metrics-cards');
  cards.replaceChildren();
  for (const [label, value, description] of [
    ['今日 AI 已用', `${ai.used} / ${ai.dailyLimit}`, '獲准即扣額，失敗也計入'],
    ['今日 AI 剩餘', `${ai.remaining} 次`, `每帳號上限 ${ai.userDailyLimit} 次`],
    ['AI 處理中', `${ai.active} / ${ai.concurrencyLimit}`, `每帳號同時最多 ${ai.userConcurrencyLimit} 筆`],
    ['服務狀態', runtime.stopping ? '關機中' : runtime.maintaining ? '維護中' : '運作中', `目前業務工作 ${runtime.pending} 筆`],
  ]) {
    const card = doc.createElement('article');
    card.className = 'metric-card';
    card.append(node('p', label, 'metric-label'), node('strong', value, 'metric-value'), node('p', description, 'muted'));
    cards.append(card);
  }
  const progress = doc.querySelector('#metrics-quota-progress');
  progress.max = Math.max(1, ai.dailyLimit);
  progress.value = Math.min(ai.used, ai.dailyLimit);
  write('metrics-updated', `最後成功取樣：${metricsTime(data.observedAt)}（台北時間）`);
  write('metrics-runtime', `${runtime.environment} · 單程序記憶體 · 啟動於 ${metricsTime(runtime.startedAt)} · 已運行 ${metricsUptime(runtime.uptimeSeconds)}`);
  write('metrics-policy', `每日 ${ai.day}（台北）· 下次額度重置 ${metricsTime(ai.resetAt)} · AI 冷卻 ${ai.cooldownSeconds} 秒 · 每 ${data.pollSeconds} 秒輪詢`);
  write('metrics-monitor-policy', `監測獨立保護：每 ${monitoring.windowSeconds} 秒，每管理員 ${monitoring.userLimit} 次、每來源 ${monitoring.ipLimit} 次；不消耗一般額度。`);
  const accounts = doc.querySelector('#metrics-users');
  accounts.replaceChildren();
  for (const user of data.users) row(accounts, [user.username, user.department.name, `${user.used} / ${user.dailyLimit}`, user.remaining, user.inProgress ? '處理中' : '閒置', `${user.cooldownSeconds} 秒`]);
  const http = doc.querySelector('#metrics-http');
  http.replaceChildren();
  for (const entry of data.http) row(http, [HTTP_NAMES[entry.scope] ?? entry.scope,
    `每${entry.by === 'ip' ? '來源' : '帳號'} ${entry.limit} 次／${entry.windowSeconds} 秒`, `${entry.activeKeys} / ${entry.maxKeys}`, entry.totalHits, entry.atLimitKeys, entry.overLimitRequests]);
  const login = doc.querySelector('#metrics-login');
  login.replaceChildren();
  for (const [key, label] of [['ip', '來源登入失敗'], ['account', '帳號＋來源登入失敗']]) {
    const entry = data.login[key];
    row(login, [label, `${entry.limit} 次／${entry.windowSeconds} 秒`, entry.activeKeys, entry.failures, entry.atLimitKeys]);
  }
  write('metrics-login-capacity', `登入失敗記錄容量上限 ${data.login.capacity} 筆；兩類視窗分開統計，同次失敗可能同時列入，請勿相加當作失敗總次數。`);
}
