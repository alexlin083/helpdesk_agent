/**
 * 取得台北時間的日期字串，供「今天」「近 N 天」快速條件使用。
 * @param {number} [daysAgo=0] 往前推的天數。
 * @param {number} [now=Date.now()] 基準時間（epoch 毫秒）。
 * @returns {string} YYYY-MM-DD。
 */
export function taipeiDateString(daysAgo = 0, now = Date.now()) {
  return new Date(now + 8 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
}

/**
 * 依常用區間算出日期範圍。
 * @param {'today'|'7'|'30'|'all'} range 區間代號。
 * @param {number} [now=Date.now()] 基準時間。
 * @returns {{from: string, to: string}} 起迄日期；不限日期時兩者為空字串。
 */
export function quickRange(range, now = Date.now()) {
  if (range === 'all') return { from: '', to: '' };
  const days = range === 'today' ? 0 : Number(range) - 1;
  return { from: taipeiDateString(days, now), to: taipeiDateString(0, now) };
}

/**
 * 組出已完成清單的摘要文字。
 * @param {number} total 符合條件的總筆數。
 * @param {number} shown 實際顯示的筆數。
 * @param {number} limit 筆數上限。
 * @returns {string} 例如「符合條件 120 筆，顯示最新 100 筆」。
 */
export function describeSummary(total, shown, limit) {
  if (total === 0) return '符合條件 0 筆';
  return total > shown ? `符合條件 ${total} 筆，顯示最新 ${shown} 筆（上限 ${limit} 筆）` : `符合條件 ${total} 筆`;
}
const EVENT_LABELS = { SUBMITTED: '送出需求單', APPROVED: '簽核', REJECTED: '退回', TRANSFERRED: '轉單', CANCELLED: '取消' };

/**
 * 組出歷程一筆的說明文字；轉單事件包含來源、目標部門與處理人。
 * @param {object} item 正規化的歷程項目。
 * @returns {string} 例如「轉單・racky.huang：資訊管理一部 → 資訊管理二部（cindy.wang），AI 判斷錯誤」。
 */
export function describeHistory(item) {
  let text = `${EVENT_LABELS[item.event] ?? item.event}${item.by_username ? `・${item.by_username}` : ''}`;
  if (item.event === 'TRANSFERRED' && item.to_department_name) {
    text += `：${item.from_department_name || '—'} → ${item.to_department_name}${item.to_handler_name ? `（${item.to_handler_name}）` : ''}`;
    if (item.comment) text += `，${item.comment}`;
    return text;
  }
  return item.comment ? `${text}：${item.comment}` : text;
}

/**
 * 將 ISO 時間轉成台北時間的簡短字串；無法解析時回傳原字串。
 * @param {string} value ISO 8601 時間。
 * @returns {string} 例如 2026/10/23 14:05。
 */
export function formatTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * 組出需求單的送達文字：有處理人時為「姓名（部門）」，否則為部門名稱。
 * @param {object} ticket 正規化的需求單。
 * @returns {string} 送達文字。
 */
export function describeTarget(ticket) {
  return ticket.handler ? `${ticket.handler.name}（${ticket.department_name}）` : ticket.department_name;
}
