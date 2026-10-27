import { readFileSync } from 'node:fs';

/**
 * 最小化的瀏覽器元素替身：支援文字、屬性、class、事件、子節點、焦點與 dialog 的開關。
 * 只提供頁面程式實際用到的介面，不驗證版面或樣式。
 */
class FakeElement {
  /**
   * 建立元素替身。
   * @param {object} doc 所屬的文件替身，用於記錄焦點。
   * @param {string} tagName 標籤名稱。
   */
  constructor(doc, tagName) {
    this.doc = doc;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.ownText = '';
    this.className = '';
    this.id = '';
    this.value = '';
    this.label = '';
    this.type = tagName === 'input' ? 'text' : '';
    this.disabled = false;
    this.hidden = false;
    this.readOnly = false;
    this.open = false;
    this.style = {};
    const self = this;
    this.classList = {
      /** 加入 class。@param {...string} names class 名稱。@returns {void} */
      add(...names) { const set = new Set(self.className.split(/\s+/).filter(Boolean)); for (const name of names) set.add(name); self.className = [...set].join(' '); },
      /** 移除 class。@param {...string} names class 名稱。@returns {void} */
      remove(...names) { self.className = self.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(' '); },
      /** 是否含 class。@param {string} name class 名稱。@returns {boolean} 結果。 */
      contains(name) { return self.className.split(/\s+/).includes(name); },
      /** 切換 class。@param {string} name class 名稱。@param {boolean} [force] 強制狀態。@returns {boolean} 切換後是否存在。 */
      toggle(name, force) {
        const next = force ?? !this.contains(name);
        if (next) this.add(name); else this.remove(name);
        return next;
      },
    };
  }

  /** 取得含子節點的純文字。@returns {string} 文字。 */
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  /** 設定純文字並清空子節點。@param {unknown} value 文字。 */
  set textContent(value) { this.ownText = String(value); this.children = []; }

  /** 設定屬性。@param {string} name 名稱。@param {unknown} value 值。@returns {void} */
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); }
  /** 讀取屬性。@param {string} name 名稱。@returns {string|null} 值。 */
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  /** 是否有屬性。@param {string} name 名稱。@returns {boolean} 結果。 */
  hasAttribute(name) { return this.attributes.has(name); }
  /** 移除屬性。@param {string} name 名稱。@returns {void} */
  removeAttribute(name) { this.attributes.delete(name); }

  /** 加入子節點。@param {...(FakeElement|string)} nodes 節點或文字。@returns {void} */
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') { this.ownText += node; continue; }
      node.parent = this;
      this.children.push(node);
    }
  }
  /** 加入單一子節點。@param {FakeElement} node 節點。@returns {FakeElement} 節點。 */
  appendChild(node) { this.append(node); return node; }
  /** 以新節點取代所有子節點。@param {...FakeElement} nodes 節點。@returns {void} */
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  /** 從父節點移除。@returns {void} */
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }

  /** 註冊事件。@param {string} type 事件名。@param {Function} handler 處理器。@returns {void} */
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
  /** 移除事件。@param {string} type 事件名。@param {Function} handler 處理器。@returns {void} */
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== handler)); }
  /**
   * 觸發事件並等待所有處理器（含非同步）完成。
   * @param {string} type 事件名。
   * @param {object} [extra={}] 事件物件的額外欄位。
   * @returns {Promise<void>} 處理器全部完成。
   */
  async dispatch(type, extra = {}) {
    /** 空的預設行為攔截。@returns {void} */
    function preventDefault() {}
    const event = { type, target: this, currentTarget: this, preventDefault, ...extra };
    await Promise.all((this.listeners.get(type) ?? []).map((handler) => handler(event)));
  }
  /** 觸發點擊。@returns {Promise<void>} 處理完成。 */
  click() { return this.dispatch('click'); }
  /** 取得焦點。@returns {void} */
  focus() { this.doc.activeElement = this; }
  /** 開啟 dialog。@returns {void} */
  showModal() { this.open = true; }
  /** 關閉 dialog 並觸發 close 事件。@returns {Promise<void>} 事件處理完成。 */
  close() { if (!this.open) return Promise.resolve(); this.open = false; return this.dispatch('close'); }

  /**
   * 檢查元素是否符合簡單選擇器（#id、.class 或標籤名稱）。
   * @param {string} selector 選擇器。
   * @returns {boolean} 是否符合。
   */
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  /** 尋找第一個符合的子孫。@param {string} selector 選擇器。@returns {FakeElement|null} 元素。 */
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  /** 尋找所有符合的子孫。@param {string} selector 選擇器。@returns {FakeElement[]} 元素。 */
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}

/**
 * 建立文件替身；readyState 刻意不設定，讓頁面模組不會在匯入時自動初始化。
 * @returns {object} 含 body、createElement、querySelector 與 activeElement 的文件替身。
 */
export function createFakeDocument() {
  const doc = {
    activeElement: null,
    /** 建立元素。@param {string} tag 標籤。@returns {FakeElement} 元素。 */
    createElement(tag) { return new FakeElement(doc, tag); },
    /** 尋找元素。@param {string} selector 選擇器。@returns {FakeElement|null} 元素。 */
    querySelector(selector) { return doc.body.querySelector(selector); },
    /** 尋找所有元素。@param {string} selector 選擇器。@returns {FakeElement[]} 元素。 */
    querySelectorAll(selector) { return doc.body.querySelectorAll(selector); },
  };
  doc.body = new FakeElement(doc, 'body');
  return doc;
}

/**
 * 建立視窗替身：記錄導頁、重新載入與事件，計時器轉交給全域函式以配合測試的模擬時間。
 * @returns {object} 視窗替身。
 */
export function createFakeWindow() {
  const win = {
    redirects: [],
    reloads: 0,
    events: new Map(),
    location: {
      /** 記錄導頁。@param {string} path 路徑。@returns {void} */
      replace(path) { win.redirects.push(path); },
      /** 記錄重新載入。@returns {void} */
      reload() { win.reloads += 1; },
    },
    /** 記錄事件處理器。@param {string} type 事件名。@param {Function} handler 處理器。@returns {void} */
    addEventListener(type, handler) { win.events.set(type, handler); },
    /** 轉交全域計時器。@param {...unknown} args 參數。@returns {unknown} 計時器。 */
    setInterval(...args) { return globalThis.setInterval(...args); },
    /** 轉交全域清除計時器。@param {...unknown} args 參數。@returns {void} */
    clearInterval(...args) { globalThis.clearInterval(...args); },
  };
  return win;
}

/**
 * 依規格建立元素並掛到父節點。
 * @param {object} doc 文件替身。
 * @param {FakeElement} parent 父節點。
 * @param {string} tag 標籤。
 * @param {string} [id=''] 元素 id。
 * @param {object} [props={}] 其他屬性。
 * @returns {FakeElement} 建立的元素。
 */
function add(doc, parent, tag, id = '', props = {}) {
  const node = doc.createElement(tag);
  if (id) node.setAttribute('id', id);
  Object.assign(node, props);
  parent.append(node);
  return node;
}

/**
 * 建立登入頁需要的節點樹（與 index.html 的 id 對應）。
 * @param {object} doc 文件替身。
 * @returns {object} 常用節點。
 */
export function buildLoginDom(doc) {
  const form = add(doc, doc.body, 'form', 'login-form');
  const username = add(doc, form, 'input', 'username');
  const password = add(doc, form, 'input', 'password', { type: 'password' });
  const toggle = add(doc, form, 'button', 'password-toggle', { ownText: '顯示' });
  const error = add(doc, form, 'p', 'login-error');
  const button = add(doc, form, 'button', 'login-button', { ownText: '登入' });
  return { form, username, password, toggle, error, button };
}

/**
 * 建立提出需求單頁需要的節點樹（與 propose.html 的 id 對應）。
 * @param {object} doc 文件替身。
 * @returns {object} 常用節點。
 */
export function buildProposeDom(doc) {
  const body = doc.body;
  body.hidden = true;
  const nodes = {};
  nodes.accountAvatar = add(doc, body, 'span', 'account-avatar');
  nodes.accountName = add(doc, body, 'span', 'account-name');
  nodes.accountId = add(doc, body, 'span', 'account-id');
  nodes.accountDepartment = add(doc, body, 'span', 'account-department');
  nodes.logout = add(doc, body, 'button', 'logout-button');
  nodes.notice = add(doc, body, 'p', 'list-notice', { hidden: true });
  nodes.form = add(doc, body, 'form', 'ticket-form');
  nodes.subject = add(doc, nodes.form, 'input', 'subject');
  nodes.subjectCount = add(doc, nodes.form, 'span', 'subject-count');
  nodes.subjectError = add(doc, nodes.form, 'p', 'subject-error');
  nodes.content = add(doc, nodes.form, 'textarea', 'content');
  nodes.contentCount = add(doc, nodes.form, 'span', 'content-count');
  nodes.contentError = add(doc, nodes.form, 'p', 'content-error');
  nodes.handlerPicker = add(doc, nodes.form, 'div', 'handler-picker');
  nodes.handlerSearch = add(doc, nodes.handlerPicker, 'input', 'handler-search', { disabled: true });
  nodes.handlerClear = add(doc, nodes.handlerPicker, 'button', 'handler-clear', { hidden: true });
  nodes.handlerListbox = add(doc, nodes.handlerPicker, 'ul', 'handler-listbox', { hidden: true });
  nodes.handler = add(doc, nodes.form, 'input', 'handler', { type: 'hidden' });
  nodes.handlerHint = add(doc, nodes.form, 'p', 'handler-hint', { hidden: true });
  nodes.submitError = add(doc, nodes.form, 'p', 'submit-error');
  nodes.reset = add(doc, nodes.form, 'button', 'reset-button');
  nodes.submit = add(doc, nodes.form, 'button', 'submit-button', { ownText: '送出需求單' });
  nodes.departmentsButton = add(doc, body, 'button', 'departments-button', { disabled: true });
  nodes.departmentsDialog = add(doc, body, 'dialog', 'departments-dialog');
  nodes.departmentsClose = add(doc, nodes.departmentsDialog, 'button', 'departments-close');
  nodes.departmentsList = add(doc, nodes.departmentsDialog, 'div', 'departments-list');
  nodes.resultDialog = add(doc, body, 'dialog', 'result-dialog');
  nodes.resultSubject = add(doc, nodes.resultDialog, 'dd', 'result-subject');
  nodes.resultTicket = add(doc, nodes.resultDialog, 'dd', 'result-ticket');
  nodes.resultTarget = add(doc, nodes.resultDialog, 'dd', 'result-target');
  nodes.resultMethod = add(doc, nodes.resultDialog, 'dd', 'result-method');
  nodes.resultBasisRow = add(doc, nodes.resultDialog, 'div', 'result-basis-row', { hidden: true });
  nodes.resultBasis = add(doc, nodes.resultBasisRow, 'dd', 'result-basis');
  nodes.resultNote = add(doc, nodes.resultDialog, 'p', 'result-note');
  nodes.resultClose = add(doc, nodes.resultDialog, 'button', 'result-close');
  nodes.resultAgain = add(doc, nodes.resultDialog, 'button', 'result-again');
  return nodes;
}

/**
 * 讀取真實頁面檔案中的所有 id，用來確認頁面腳本依賴的節點都存在。
 * @param {URL} file 頁面檔案位置。
 * @returns {Set<string>} 頁面中出現的 id。
 */
export function pageIds(file) {
  const html = readFileSync(file, 'utf8');
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
}

/**
 * 建立登入服務替身，不碰 sessionStorage 與網路。
 * @param {object|null} user 目前登入的身分。
 * @returns {object} auth 替身，含 calls 記錄。
 */
export function fakeAuth(user) {
  const auth = {
    user,
    calls: [],
    /** 取得目前身分。@returns {object|null} 身分。 */
    getCurrentUser() { return auth.user; },
    /** 取得憑證。@returns {string|null} 憑證。 */
    getAccessToken() { return auth.user ? 'test-token' : null; },
    /** 記錄登出。@returns {void} */
    logout() { auth.calls.push('logout'); auth.user = null; },
    /** 預設登入成功。@param {string} username 帳號。@returns {Promise<object>} 身分。 */
    async login(username) { auth.user = { username, userID: `user-${username}`, department: { id: 'dept-test', name: '測試部門' } }; return auth.user; },
  };
  return auth;
}
