import { element } from './dom.js';

const INTENT_LABELS = { IT_SUPPORT: 'IT 資訊支援', HR_POLICY: '人事規章', HARDWARE_FACILITY: '硬體與總務', UNKNOWN: '待人工確認' };

export class DecisionPanel {
  /**
   * 建立右側決策面板，等待實際 API 回應後才顯示分數與來源。
   * @param {HTMLElement} root 決策面板的掛載節點。
   */
  constructor(root) {
    this.root = root;
    this.showState('等待第一個問題', '送出問題後，這裡將呈現 Gemini 的辨識、檢索與分流結果。');
  }

  /**
   * 重建固定的面板標題與內容容器，避免混用上一次問題的決策資料。
   * @returns {HTMLElement} 本次狀態或結果的內容容器。
   */
  reset() {
    this.root.innerHTML = `<div class="panel-heading"><div><span class="eyebrow">BEHIND THE ANSWER</span><h2>AI 決策資料</h2></div><span class="pill">Gemini</span></div><div class="decision-content"></div>`;
    return this.root.querySelector('.decision-content');
  }

  /**
   * 顯示等待、載入或失敗狀態；不使用虛構分數或模擬來源。
   * @param {string} title 狀態標題。
   * @param {string} description 狀態說明。
   * @returns {void}
   */
  showState(title, description) {
    const content = this.reset();
    const state = element('div', 'empty-state');
    state.append(element('span', 'empty-icon', '✦'), element('h3', '', title), element('p', '', description));
    content.append(state);
  }

  /**
   * 建立一個有編號與標題的決策步驟區塊。
   * @param {string} number 步驟編號。
   * @param {string} title 步驟標題。
   * @returns {HTMLElement} 可追加內容的區塊。
   */
  step(number, title) {
    const section = element('section', 'decision-step');
    const heading = element('div', 'step-heading');
    heading.append(element('span', 'step-number', number), element('h3', '', title));
    section.append(heading);
    return section;
  }

  /**
   * 根據有效回應呈現意圖、實際檢索相似度、信心分數、分流、工單與完整 JSON。
   * 相似度與信心分數分開顯示；信心分數不代表經校準的正確率。
   * @param {object} data 已由 service 驗證的 API 回應。
   * @returns {void} 所有動態文字使用 textContent，避免 HTML 注入。
   */
  render(data) {
    const content = this.reset();
    const intent = this.step('01', '意圖辨識');
    intent.append(element('p', 'intent-name', INTENT_LABELS[data.intent]), element('code', 'muted', data.intent));
    const sources = this.step('02', '知識庫檢索 · Top 3');
    if (!data.retrieved_sources.length) sources.append(element('p', 'muted', '沒有可用的檢索來源。'));
    for (const source of data.retrieved_sources) {
      const card = element('div', 'source-card');
      const line = element('div', 'source-line');
      line.append(element('span', 'source-name', source.doc_name), element('strong', '', source.relevance.toFixed(4)));
      const track = element('div', 'source-track');
      const bar = element('div', 'source-fill');
      bar.style.width = `${source.relevance * 100}%`;
      track.append(bar);
      card.append(line, track);
      sources.append(card);
    }
    sources.append(element('p', 'small muted', '分數為向量餘弦相似度（0～1）。'));
    const decision = this.step('03', '信心評估與分流');
    const auto = data.action_route === 'AUTO_REPLY';
    const summary = element('div', 'decision-summary');
    summary.append(element('strong', 'score', `${data.confidence_score}`), element('span', 'muted', '/ 100'),
      element('span', `route ${auto ? 'success' : 'warning'}`, auto ? '自動回覆' : '需人工處理'));
    decision.append(summary, element('code', 'muted', data.action_route),
      element('p', 'small muted', '75 分為分流門檻；模型信心分數不等於回答正確率。'));
    content.append(intent, sources, decision);
    if (data.ticket_payload) {
      const ticket = element('section', 'ticket-card');
      ticket.append(element('h3', '', '工單資料'), element('p', 'small', '已產生處置建議，尚未保存或派送。'));
      const list = element('dl', 'ticket-fields');
      const labels = { ticket_id: '工單編號', level: '緊急程度', department: '建議部門', action_required: '建議處置' };
      for (const [key, label] of Object.entries(labels)) list.append(element('dt', '', label), element('dd', '', data.ticket_payload[key]));
      const preview = element('details', 'json-details');
      preview.append(element('summary', '', '工單 JSON'), element('pre', '', JSON.stringify(data.ticket_payload, null, 2)));
      ticket.append(list, preview);
      content.append(ticket);
    }
    const raw = element('details', 'json-details');
    raw.append(element('summary', '', '查看完整 API 回應'), element('pre', '', JSON.stringify(data, null, 2)));
    content.append(raw);
  }
}
