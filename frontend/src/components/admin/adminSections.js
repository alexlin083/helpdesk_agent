/**
 * 管理頁左側清單：一次只顯示一個區塊，預設是清單第一項（即時監測）
 * 網址的 #區塊 id 記住目前區塊，重新整理、貼網址或上一頁時打開那一區；不認得的 id 改開第一項
 * 只切換卡片的 hidden，各區塊的輪詢與表單照常運作
 * @param {Document} doc 頁面文件
 * @param {Window} win 視窗物件，提供網址、歷史紀錄、捲動與 hashchange 事件
 * @returns {{show: Function, current: Function}|null} 切換區塊與查目前區塊的函式；頁面沒有左側清單時為 null
 */
export function initAdminSections(doc, win) {
  const nav = doc.querySelector('.admin-nav');
  if (!nav) return null;
  const sections = new Map();
  for (const link of nav.querySelectorAll('a')) {
    const id = (link.getAttribute('href') ?? '').replace(/^#/, '');
    const section = id ? doc.querySelector(`#${id}`) : null;
    if (section) sections.set(id, { link, section });
  }
  if (!sections.size) return null;
  const first = sections.keys().next().value;
  let current = first;

  /**
   * 顯示指定區塊、隱藏其他區塊，清單上的目前項目加 aria-current
   * @param {string} id 區塊 id；不在清單裡時改開第一項
   * @returns {string} 實際顯示的區塊 id
   */
  function show(id) {
    current = sections.has(id) ? id : first;
    for (const [key, { link, section }] of sections) {
      section.hidden = key !== current;
      if (key === current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    return current;
  }
  /** 取網址 # 後面的區塊 id @returns {string} 區塊 id，沒有時為空字串 */
  function fromHash() { return String(win.location?.hash ?? '').replace(/^#/, ''); }

  for (const [id, { link }] of sections) {
    link.addEventListener('click', /** 切到這一區：不跳到錨點，改網址後回到頁首 @param {Event} event 點擊事件 @returns {void} */ (event) => {
      event.preventDefault();
      show(id);
      try { win.history?.replaceState?.(null, '', `#${id}`); } catch { /* 不能改網址時仍照常切換 */ }
      win.scrollTo?.(0, 0);
    });
  }
  win.addEventListener?.('hashchange', /** 上一頁或手動改網址時跟著切換 @returns {void} */ () => { show(fromHash()); });
  show(fromHash());
  return { show, current: () => current };
}
