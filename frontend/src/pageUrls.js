/**
 * 依前端模組的位置建立各頁面的完整網址；以 src 的上一層為站點根目錄。
 * 不以目前頁面的深度推測路徑，也不硬編碼網域或 GitHub Pages 的 repo 名稱。
 * @param {string|URL} [moduleUrl=import.meta.url] 此模組網址；測試可注入不同託管子路徑。
 * @returns {Readonly<{login: string, propose: string, tickets: string, admin: string}>} 登入、提單、追蹤與管理頁網址。
 */
export function createPageUrls(moduleUrl = import.meta.url) {
  return Object.freeze({
    login: new URL('../index.html', moduleUrl).href,
    propose: new URL('../propose.html', moduleUrl).href,
    tickets: new URL('../tickets/tickets.html', moduleUrl).href,
    admin: new URL('../admin/admin.html', moduleUrl).href,
  });
}
export const PAGE_URLS = createPageUrls();
