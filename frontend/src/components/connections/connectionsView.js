// 「連接帳號」頁的畫面：左邊列外部服務與狀態，右邊寫清楚助理會讀什麼、不會讀什麼，以及權限等級與連接、中斷按鈕
// 版面照使用者 2026-11-15 選的方案 B「左清單右詳細」；所有動態文字一律用 textContent 放入，不解析成 HTML
// 提供者相關的文字（同意畫面的提示、到哪裡收回授權）都由後端從 connectors.json 帶來，這裡不寫死任何提供者或服務名稱

export const STATUS_TEXT = Object.freeze({ ACTIVE: '已連接', NEEDS_RECONNECT: '需要重新連接', NOT_CONNECTED: '未連接', planned: '規劃中' });

/**
 * 建立文字元素
 * @param {Document} doc 頁面文件
 * @param {string} tag 標籤
 * @param {string} [className=''] 樣式類別
 * @param {string} [text=''] 純文字
 * @returns {HTMLElement} 元素
 */
function make(doc, tag, className = '', text = '') {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * 一個連接器在畫面上的狀態代碼：規劃中的服務一律 planned，其他照後端回的連接狀態
 * @param {object} connector 連接器
 * @returns {'ACTIVE'|'NEEDS_RECONNECT'|'NOT_CONNECTED'|'planned'} 狀態
 */
export function statusOf(connector) {
  if (connector.status !== 'available') return 'planned';
  return ['ACTIVE', 'NEEDS_RECONNECT'].includes(connector.connection?.status) ? connector.connection.status : 'NOT_CONNECTED';
}

/**
 * 把 ISO 時間寫成台灣時間的日期
 * @param {string} iso ISO 時間
 * @returns {string} 例：2026/11/15；不是有效時間時回空字串
 */
export function formatDate(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
}

/**
 * 改成較低權限等級時的提醒：用等級名稱組字，收回授權的地方取自連接器設定
 * @param {object} connector 連接器（account_page 為收回授權的地方，可能是空字串）
 * @param {{name: string}} from 目前連接的等級
 * @param {{name: string}} to 要改成的等級
 * @returns {string} 提醒文字
 */
export function downgradeText(connector, from, to) {
  const where = connector.account_page || '服務提供者的帳戶設定';
  return `從${from.name}改回${to.name}後，${where}可能仍列出先前給過的權限；想完全收回，請先中斷連接，再用${to.name}重新連接`;
}

/**
 * 建立「連接帳號」畫面：render 重畫左清單與右詳細（重畫後把焦點放回原本的服務按鈕）；select 只換選取狀態與右詳細，不重建左清單
 * @param {Document} doc 頁面文件
 * @param {object} handlers 事件處理
 * @param {(id: string) => void} handlers.onSelect 選了左邊某個服務
 * @param {(id: string, level: string) => void} handlers.onConnect 按了連接、更新權限或重新連接
 * @param {(id: string) => void} handlers.onDisconnect 按了中斷連接
 * @returns {{render: Function, select: Function, setBusy: Function}} 畫面操作
 */
export function createConnectionsView(doc, { onSelect, onConnect, onDisconnect }) {
  const list = doc.querySelector('#connector-list');
  const detail = doc.querySelector('#connector-detail');
  let busy = false;
  let canConnect = false;
  let buttons = [];
  let connectors = [];

  /** 左清單裡某個服務的按鈕 @param {string} id 連接器 id @returns {HTMLElement|undefined} 按鈕 */
  function listButton(id) {
    return [...list.querySelectorAll('button')].find(/** 比對連接器 @param {HTMLElement} button 按鈕 @returns {boolean} 是時 true */ (button) => button.getAttribute('data-connector') === id);
  }

  /**
   * 畫左邊的服務清單；重畫前焦點若在某個服務按鈕上，重畫後放回同一個服務，鍵盤使用者不會掉回頁首
   * @param {string} selectedId 目前選的連接器
   * @returns {void}
   */
  function renderList(selectedId) {
    const focused = doc.activeElement?.getAttribute?.('data-connector') ?? null;
    list.replaceChildren(...connectors.map(/** 一個服務的按鈕 @param {object} connector 連接器 @returns {HTMLElement} 清單項目 */ (connector) => {
      const item = make(doc, 'li');
      const button = make(doc, 'button', 'connector-item');
      button.type = 'button';
      button.setAttribute('data-connector', connector.id);
      button.setAttribute('aria-pressed', String(connector.id === selectedId));
      const status = statusOf(connector);
      button.append(make(doc, 'span', 'connector-name', connector.name), make(doc, 'span', `badge badge-${status.toLowerCase()}`, STATUS_TEXT[status]));
      button.addEventListener('click', /** 選這個服務 @returns {void} */ () => onSelect(connector.id));
      item.append(button);
      return item;
    }));
    if (focused) listButton(focused)?.focus();
  }

  /**
   * 畫一組條列文字
   * @param {string} title 小標
   * @param {string[]} lines 條列內容
   * @returns {HTMLElement[]} 小標與清單
   */
  function bullets(title, lines) {
    const listNode = make(doc, 'ul', 'detail-list');
    listNode.append(...lines.map(/** 一行 @param {string} line 文字 @returns {HTMLElement} 項目 */ (line) => make(doc, 'li', '', line)));
    return [make(doc, 'h3', 'detail-heading', title), listNode];
  }

  /**
   * 畫右邊的詳細內容：說明、連接狀態、會讀與不會讀、權限等級與按鈕
   * @param {object|undefined} connector 選到的連接器
   * @returns {void}
   */
  function renderDetail(connector) {
    buttons = [];
    canConnect = false;
    if (!connector) { detail.replaceChildren(make(doc, 'p', 'muted', '目前沒有可以連接的服務')); return; }
    const status = statusOf(connector);
    const nodes = [make(doc, 'h2', 'detail-title', connector.name), make(doc, 'p', 'detail-description', connector.description)];
    if (status === 'planned') {
      nodes.push(make(doc, 'p', 'notice', '規劃中，目前還不能連接'));
      detail.replaceChildren(...nodes);
      return;
    }
    const connection = connector.connection ?? {};
    const state = make(doc, 'p', 'detail-state');
    if (status === 'NOT_CONNECTED') state.textContent = '尚未連接';
    else {
      const when = formatDate(connection.connected_at);
      state.textContent = `${STATUS_TEXT[status]}${connection.account_email ? ` ${connection.account_email}` : ''}${when ? ` ・ 連接於 ${when}` : ''}`;
    }
    nodes.push(state);
    if (status === 'NEEDS_RECONNECT') nodes.push(make(doc, 'p', 'notice', '這個連接已經不能用（授權被收回、過期，或管理員更換了連接設定），請重新連接'));

    const levels = connector.levels ?? [];
    const connectedIndex = levels.findIndex(/** 找目前連接的等級 @param {{id: string}} level 等級 @returns {boolean} 是時 true */ (level) => level.id === connection.level);
    const current = levels[connectedIndex] ?? levels[0];
    const reads = make(doc, 'div', 'detail-reads');
    const downgrade = make(doc, 'p', 'muted detail-downgrade');
    downgrade.hidden = true;
    /**
     * 依選到的權限等級更新「助理會讀」清單；已連接而且選了比目前低的等級時，顯示到哪裡收回先前權限的提醒
     * @param {object} level 權限等級
     * @returns {void}
     */
    function showLevel(level) {
      reads.replaceChildren(...bullets('助理會讀', level?.reads ?? []));
      const lower = status === 'ACTIVE' && connectedIndex > levels.indexOf(level);
      downgrade.hidden = !lower;
      downgrade.textContent = lower ? downgradeText(connector, levels[connectedIndex], level) : '';
    }
    const fieldset = make(doc, 'fieldset', 'level-options');
    fieldset.append(make(doc, 'legend', '', '權限等級'));
    let chosen = current;
    for (const level of levels) {
      const label = make(doc, 'label', 'level-option');
      const radio = make(doc, 'input');
      radio.type = 'radio';
      radio.name = `level-${connector.id}`;
      radio.value = level.id;
      radio.checked = level === current;
      radio.disabled = busy;
      radio.addEventListener('change', /** 換了權限等級 @returns {void} */ () => { chosen = level; showLevel(level); });
      label.append(radio, make(doc, 'span', '', `${level.name}：${level.summary}`));
      fieldset.append(label);
      buttons.push(radio);
    }
    showLevel(current);
    nodes.push(reads, ...bullets('助理不會讀', connector.never ?? []), fieldset, downgrade);

    if (!connector.configured) nodes.push(make(doc, 'p', 'notice', '管理員還沒完成這個服務的連接設定，暫時不能連接'));
    else if (connector.connect_hint) nodes.push(make(doc, 'p', 'muted', connector.connect_hint));
    canConnect = Boolean(connector.configured);
    const actions = make(doc, 'div', 'detail-actions');
    const connect = make(doc, 'button', 'primary-button', status === 'ACTIVE' ? '更新權限' : status === 'NEEDS_RECONNECT' ? '重新連接' : `連接 ${connector.name}`);
    connect.type = 'button';
    connect.id = 'connect-button';
    connect.disabled = !canConnect || busy;
    connect.addEventListener('click', /** 發起連接 @returns {void} */ () => { if (chosen) onConnect(connector.id, chosen.id); });
    actions.append(connect);
    buttons.push(connect);
    if (status !== 'NOT_CONNECTED') {
      const disconnect = make(doc, 'button', 'secondary-button', '中斷連接');
      disconnect.type = 'button';
      disconnect.id = 'disconnect-button';
      disconnect.disabled = busy;
      disconnect.addEventListener('click', /** 中斷連接 @returns {void} */ () => onDisconnect(connector.id));
      actions.append(disconnect);
      buttons.push(disconnect);
    }
    nodes.push(actions);
    detail.replaceChildren(...nodes);
  }

  /** 找選到的連接器 @param {string} id 連接器 id @returns {object|undefined} 連接器 */
  function find(id) { return connectors.find(/** 比對 id @param {{id: string}} item 連接器 @returns {boolean} 是時 true */ (item) => item.id === id); }

  return {
    /**
     * 用新的清單重畫整個畫面（讀清單、中斷連接之後）
     * @param {object[]} next 連接器清單
     * @param {string} selectedId 目前選的連接器 id
     * @returns {void}
     */
    render(next, selectedId) {
      connectors = next;
      renderList(selectedId);
      renderDetail(find(selectedId));
    },
    /**
     * 換選取的服務：只更新左清單的 aria-pressed 與右詳細，不重建左清單，鍵盤焦點留在按下的按鈕上
     * @param {string} selectedId 連接器 id
     * @returns {void}
     */
    select(selectedId) {
      for (const button of list.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.getAttribute('data-connector') === selectedId));
      renderDetail(find(selectedId));
    },
    /**
     * 設定忙碌狀態：送出請求期間停用右邊的按鈕與權限選項，避免連按
     * @param {boolean} value 是否忙碌
     * @returns {void}
     */
    setBusy(value) {
      busy = value;
      for (const button of buttons) button.disabled = button.id === 'connect-button' ? value || !canConnect : value;
    },
  };
}
