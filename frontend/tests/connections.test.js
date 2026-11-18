import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeDocument, createFakeWindow, fakeAuth, pageIds } from './helpers/fakeDom.js';
import { initConnectionsPage, takeOAuthReturn, RESULT_TEXT, CANCELLED_TEXT } from '../src/pages/connections.js';
import { initAdminConnectors } from '../src/components/admin/adminConnectors.js';
import { abandonGoogle, completeGoogle, isAllowedAuthorizeUrl, startConnect } from '../src/services/connectorService.js';
import { PAGE_URLS } from '../src/pageUrls.js';

const USER = { username: 'racky.huang', userID: 'user-racky', department: { id: 'dept-it-1', name: '資訊管理一部' } };

/**
 * 組出後端回傳的連接器清單（Google 行事曆加兩個規劃中）
 * @param {object} [calendar={}] 覆寫 Google 行事曆的欄位
 * @returns {object[]} 連接器清單
 */
function connectorsFixture(calendar = {}) {
  return [
    {
      id: 'google_calendar', name: 'Google 行事曆', status: 'available', description: '查你的 Google 行事曆', never: ['不會新增、修改或刪除行程'], configured: true,
      levels: [{ id: 'basic', name: '基本', summary: '只看忙碌時段', reads: ['忙碌時段'] }, { id: 'advanced', name: '進階', summary: '再加行程標題', reads: ['忙碌時段', '行程標題'] }],
      connection: { status: 'NOT_CONNECTED' }, ...calendar,
    },
    { id: 'gmail', name: 'Gmail', status: 'planned', description: '規劃中', never: [], levels: [], configured: false, connection: { status: 'NOT_CONNECTED' } },
  ];
}

/**
 * 建立連接帳號頁需要的節點（與 connections.html 的 id 對應）
 * @param {object} doc 文件替身
 * @returns {void}
 */
function buildConnectionsDom(doc) {
  for (const [tag, id] of [['strong', 'account-name'], ['span', 'account-id'], ['span', 'account-avatar'], ['span', 'account-department'], ['button', 'logout-button'], ['p', 'connections-status'], ['ul', 'connector-list'], ['section', 'connector-detail']]) {
    const node = doc.createElement(tag);
    node.setAttribute('id', id);
    doc.body.append(node);
  }
}

/**
 * 建立視窗替身，加上網址、history 與導頁紀錄
 * @param {string} [search=''] 網址查詢字串
 * @returns {object} 視窗替身
 */
function windowWith(search = '') {
  const win = createFakeWindow();
  win.order = [];
  win.assigned = [];
  Object.assign(win.location, { search, pathname: '/pages/connections/connections.html', /** 記錄導頁 @param {string} url 網址 @returns {void} */ assign(url) { win.assigned.push(url); } });
  win.history = { /** 記錄清網址 @param {...unknown} args 參數 @returns {void} */ replaceState(...args) { win.order.push(['replaceState', args[2]]); win.location.search = ''; } };
  return win;
}

/**
 * 建立假的連接 API，記錄呼叫順序
 * @param {object} win 視窗替身（共用呼叫順序）
 * @param {object} [overrides={}] 覆寫的函式
 * @returns {object} API 替身
 */
function fakeApi(win, overrides = {}) {
  const state = { connectors: connectorsFixture() };
  return {
    state,
    /** 清單 @returns {Promise<object[]>} 清單 */
    async listConnectors() { win.order.push(['list']); return state.connectors; },
    /** 發起 @param {string} id 連接器 @param {string} level 等級 @returns {Promise<string>} 網址 */
    async startConnect(id, level) { win.order.push(['start', id, level]); return `https://accounts.google.com/o/oauth2/v2/auth?level=${level}`; },
    /** 完成 @param {object} returned 參數 @returns {Promise<object>} 結果 */
    async completeGoogle(returned) { win.order.push(['complete', returned.state, returned.code, returned.error, win.location.search]); return { result: 'connected', connector: 'google_calendar' }; },
    /** 放棄 @param {string} stateValue state @returns {Promise<boolean>} 結果 */
    async abandonGoogle(stateValue) { win.order.push(['abandon', stateValue]); return true; },
    /** 中斷 @param {string} id 連接器 @returns {Promise<object>} 結果 */
    async disconnectConnector(id) { win.order.push(['disconnect', id]); return { disconnected: true, revoked: true }; },
    ...overrides,
  };
}

test('Google 導回：一載入就從網址列移掉 code 與 state；沒有導回參數時不動網址', () => {
  const win = windowWith('?state=st-1&code=secret-code&scope=x');
  assert.deepEqual(takeOAuthReturn(win), { state: 'st-1', code: 'secret-code', error: null });
  assert.deepEqual(win.order, [['replaceState', '/pages/connections/connections.html']]);
  assert.equal(win.location.search, '');
  const plain = windowWith('');
  assert.equal(takeOAuthReturn(plain), null);
  assert.deepEqual(plain.order, []);
});

test('已登入的本人從 Google 回來：先清網址再自動送出完成連接，不等使用者按；顯示結果並選到該服務', async () => {
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('?state=st-1&code=secret-code');
  const api = fakeApi(win);
  await initConnectionsPage(doc, win, { auth: fakeAuth(USER), api });
  assert.deepEqual(win.order.slice(0, 2), [['replaceState', '/pages/connections/connections.html'], ['complete', 'st-1', 'secret-code', null, '']], '送出時網址上已經沒有授權碼');
  assert.ok(!win.order.some(/** 找放棄 @param {Array} entry 呼叫 @returns {boolean} 是時 true */ (entry) => entry[0] === 'abandon'));
  assert.equal(doc.querySelector('#connections-status').textContent, RESULT_TEXT.connected);
  assert.equal(doc.body.hidden, false);
  assert.equal(doc.querySelector('#connector-list').querySelectorAll('button')[0].getAttribute('aria-pressed'), 'true');
});

test('沒登入就從 Google 回來：丟掉授權碼、呼叫放棄連接作廢 state，不送出完成連接，導回登入頁', async () => {
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('?state=st-2&code=secret-code');
  const api = fakeApi(win);
  const page = await initConnectionsPage(doc, win, { auth: fakeAuth(null), api });
  assert.equal(page, null);
  assert.deepEqual(win.order, [['replaceState', '/pages/connections/connections.html'], ['abandon', 'st-2']]);
  assert.deepEqual(win.redirects, [PAGE_URLS.login]);

  const adminWin = windowWith('?state=st-3&code=secret-code');
  await initConnectionsPage(createFakeDocument(), adminWin, { auth: fakeAuth({ ...USER, role: 'ADMIN' }), api: fakeApi(adminWin) });
  assert.deepEqual(adminWin.order.map(/** 取動作 @param {Array} entry 呼叫 @returns {string} 動作 */ (entry) => entry[0]), ['replaceState', 'abandon'], '管理員帳號也作廢，不完成連接');
  assert.deepEqual(adminWin.redirects, [PAGE_URLS.admin]);
});

test('完成連接的結果：拒絕、不是本人、沒勾齊都顯示固定文字；登入失效時登出', async () => {
  for (const result of ['denied', 'mismatch', 'partial', 'expired', 'failed']) {
    const doc = createFakeDocument();
    buildConnectionsDom(doc);
    const win = windowWith('?state=st&error=access_denied');
    await initConnectionsPage(doc, win, { auth: fakeAuth(USER), api: fakeApi(win, { /** 回指定結果 @returns {Promise<object>} 結果 */ async completeGoogle() { return { result, connector: null }; } }) });
    assert.equal(doc.querySelector('#connections-status').textContent, RESULT_TEXT[result], result);
    assert.ok(doc.querySelector('#connections-status').classList.contains('is-error'));
  }
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('');
  const auth = fakeAuth(USER);
  await initConnectionsPage(doc, win, { auth, api: fakeApi(win, { /** 登入失效 @returns {Promise<never>} 失敗 */ async listConnectors() { throw Object.assign(new Error('x'), { status: 401 }); } }) });
  assert.deepEqual(auth.calls, ['logout']);
  assert.deepEqual(win.redirects, [PAGE_URLS.login]);
});

test('畫面：左邊列服務與狀態，右邊寫助理會讀與不會讀；換權限等級會更新清單；按連接把分頁導到 Google', async () => {
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('');
  const api = fakeApi(win);
  await initConnectionsPage(doc, win, { auth: fakeAuth(USER), api });
  const items = doc.querySelector('#connector-list').querySelectorAll('button');
  assert.deepEqual(items.map(/** 取文字 @param {object} item 按鈕 @returns {string} 文字 */ (item) => item.textContent), ['Google 行事曆未連接', 'Gmail規劃中']);
  const detail = doc.querySelector('#connector-detail');
  assert.ok(detail.textContent.includes('助理會讀忙碌時段'));
  assert.ok(detail.textContent.includes('助理不會讀不會新增、修改或刪除行程'));
  assert.equal(detail.querySelector('#connect-button').textContent, '連接 Google 行事曆');
  assert.equal(detail.querySelector('#disconnect-button'), null, '沒連接時沒有中斷按鈕');
  const radios = detail.querySelectorAll('input');
  radios[1].checked = true;
  await radios[1].dispatch('change');
  assert.ok(detail.textContent.includes('行程標題'), '換成進階後列出行程標題');
  await detail.querySelector('#connect-button').click();
  assert.deepEqual(win.order.at(-1), ['start', 'google_calendar', 'advanced']);
  assert.deepEqual(win.assigned, ['https://accounts.google.com/o/oauth2/v2/auth?level=advanced']);

  await items[1].click();
  assert.ok(doc.querySelector('#connector-detail').textContent.includes('規劃中，目前還不能連接'));
  assert.equal(doc.querySelector('#connector-detail').querySelector('#connect-button'), null, '規劃中沒有按鈕');
});

test('從授權畫面按上一頁回來：解除處理中、清掉「正在前往授權畫面…」並重讀狀態；一般載入或已經登出時不動', async () => {
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('');
  const api = fakeApi(win);
  const auth = fakeAuth(USER);
  await initConnectionsPage(doc, win, { auth, api });
  /** 取目前畫面上的連接按鈕（重畫後是新的節點） @returns {object} 按鈕 */
  const connect = () => doc.querySelector('#connect-button');
  const status = doc.querySelector('#connections-status');
  /** 等非同步的重讀與重畫做完 @returns {Promise<void>} 完成 */
  const settle = () => new Promise(/** 下一輪 @param {Function} resolve 完成 @returns {void} */ (resolve) => { setTimeout(resolve, 0); });
  await connect().click();
  assert.equal(connect().disabled, true, '導去 Google 前按鈕停用');
  assert.equal(status.textContent, '正在前往授權畫面…');
  const show = win.events.get('pageshow');
  win.order.length = 0;
  show({ persisted: false });
  await settle();
  assert.equal(connect().disabled, true, '一般載入不處理');
  assert.deepEqual(win.order, []);
  show({ persisted: true });
  await settle();
  assert.equal(connect().disabled, false, '回來後可以再按');
  assert.equal(status.textContent, '');
  assert.deepEqual(win.order, [['list']], '重讀一次連接狀態');
  await connect().click();
  auth.user = null;
  win.order.length = 0;
  show({ persisted: true });
  await settle();
  assert.equal(connect().disabled, true, '已經登出時不解除，交給帳號選單導回登入頁');
  assert.deepEqual(win.order, []);
});

test('畫面：已連接顯示帳號與日期、可以更新權限與中斷連接；管理員還沒設定時連接按鈕停用', async () => {
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('');
  const api = fakeApi(win);
  api.state.connectors = connectorsFixture({ connection: { status: 'ACTIVE', account_email: 'racky@example.com', level: 'advanced', connected_at: '2026-11-15T03:00:00.000Z' } });
  await initConnectionsPage(doc, win, { auth: fakeAuth(USER), api });
  const detail = doc.querySelector('#connector-detail');
  assert.ok(detail.textContent.includes('已連接 racky@example.com ・ 連接於 2026/11/15'));
  assert.equal(detail.querySelector('#connect-button').textContent, '更新權限');
  const radios = detail.querySelectorAll('input');
  assert.equal(radios[1].checked, true, '預選目前連接的等級');
  radios[0].checked = true;
  await radios[0].dispatch('change');
  assert.equal(detail.querySelector('.detail-downgrade').hidden, false, '從進階改回基本時提醒到 Google 收回');
  win.confirmAnswer = false;
  await detail.querySelector('#disconnect-button').click();
  assert.ok(!win.order.some(/** 找中斷 @param {Array} entry 呼叫 @returns {boolean} 是時 true */ (entry) => entry[0] === 'disconnect'), '按取消就不中斷');
  win.confirmAnswer = true;
  api.state.connectors = connectorsFixture();
  await detail.querySelector('#disconnect-button').click();
  assert.deepEqual(win.order.slice(-2), [['disconnect', 'google_calendar'], ['list']]);
  assert.equal(doc.querySelector('#connections-status').textContent, '已中斷連接');

  const unconfigured = createFakeDocument();
  buildConnectionsDom(unconfigured);
  const other = windowWith('');
  const otherApi = fakeApi(other);
  otherApi.state.connectors = connectorsFixture({ configured: false });
  await initConnectionsPage(unconfigured, other, { auth: fakeAuth(USER), api: otherApi });
  assert.equal(unconfigured.querySelector('#connect-button').disabled, true);
  assert.ok(unconfigured.querySelector('#connector-detail').textContent.includes('管理員還沒完成這個服務的連接設定'));
});

/**
 * 建立管理頁 Google 連接設定區需要的節點
 * @param {object} doc 文件替身
 * @returns {object} 節點
 */
function buildAdminConnectorsDom(doc) {
  const nodes = {};
  for (const [tag, id] of [['section', 'admin-connectors'], ['form', 'google-settings-form'], ['input', 'google-client-id'], ['input', 'google-client-secret'], ['button', 'google-settings-save'], ['code', 'google-redirect-uri'], ['button', 'google-copy-redirect'], ['p', 'google-settings-state'], ['p', 'google-settings-status']]) {
    nodes[id] = doc.createElement(tag);
    nodes[id].setAttribute('id', id);
    doc.body.append(nodes[id]);
  }
  return nodes;
}

test('管理頁 Google 連接設定：顯示回呼網址與狀態；密鑰每次都要輸入、存完清空；格式不對不送出', async () => {
  const doc = createFakeDocument();
  const nodes = buildAdminConnectorsDom(doc);
  const saved = [];
  const summary = { connector_id: 'google_calendar', configured: false, client_id: '', redirect_uri: 'https://example.test/helpdesk/pages/connections/connections.html', updated_by: null, updated_at: null };
  const section = initAdminConnectors(doc, createFakeWindow(), {
    auth: fakeAuth(USER), leave() {},
    /** 讀設定 @returns {Promise<object>} 摘要 */ async load() { return summary; },
    /** 存設定 @param {object} settings 設定 @returns {Promise<object>} 摘要 */ async save(settings) { saved.push(settings); return { ...summary, configured: true, client_id: settings.clientId, updated_by: 'alex.admin', updated_at: '2026-11-15T03:00:00.000Z' }; },
  });
  await section.refresh();
  assert.equal(nodes['google-redirect-uri'].textContent, summary.redirect_uri);
  assert.ok(nodes['google-settings-state'].textContent.includes('尚未設定'));
  nodes['google-client-id'].value = 'test-client.apps.googleusercontent.com';
  await section.submit();
  assert.deepEqual(saved, [], '沒填密鑰不送出');
  assert.ok(nodes['google-settings-status'].classList.contains('is-error'));
  nodes['google-client-secret'].value = 'test-client-secret';
  await section.submit();
  assert.deepEqual(saved, [{ clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-client-secret' }]);
  assert.equal(nodes['google-client-secret'].value, '', '密鑰存完就清空');
  assert.ok(nodes['google-settings-state'].textContent.startsWith('已設定，由 alex.admin'));
  assert.equal(initAdminConnectors(createFakeDocument(), createFakeWindow(), { auth: fakeAuth(USER), leave() {} }), null, '頁面沒有這一區時不初始化');
});

test('連接服務：完成連接的未知結果當成失敗；授權網址必須是 Google 的；放棄連接失敗也不拋出', async () => {
  const original = globalThis.fetch;
  try {
    /** 假的 fetch @param {object} body 回應 JSON @param {number} [status=200] 狀態 @returns {Function} fetch */
    const respond = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
    globalThis.fetch = respond({ result: 'weird', connector: 'google_calendar' });
    assert.deepEqual(await completeGoogle({ state: 's', code: 'c' }, fakeAuth(USER)), { result: 'failed', connector: 'google_calendar' });
    globalThis.fetch = respond({ authorize_url: 'https://evil.example/auth' });
    await assert.rejects(startConnect('google_calendar', 'basic', fakeAuth(USER)), /授權網址格式異常/);
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await abandonGoogle('s'), false);
    await assert.rejects(completeGoogle({ state: 's', code: 'c' }, fakeAuth(null)), { status: 401 }, '沒登入不送出完成連接');
  } finally { globalThis.fetch = original; }
});

test('頁面檔：連接帳號頁有所需節點與 no-referrer；提單頁、追蹤頁的帳號選單有入口；管理頁有 Google 連接設定', () => {
  const ids = pageIds(new URL('../pages/connections/connections.html', import.meta.url));
  for (const id of ['account-name', 'account-id', 'account-avatar', 'account-department', 'logout-button', 'connections-status', 'connector-list', 'connector-detail']) assert.ok(ids.has(id), id);
  assert.match(readFileSync(new URL('../pages/connections/connections.html', import.meta.url), 'utf8'), /<meta name="referrer" content="no-referrer">/);
  for (const page of ['propose/propose.html', 'tickets/tickets.html']) assert.match(readFileSync(new URL(`../pages/${page}`, import.meta.url), 'utf8'), /href="\.\.\/connections\/connections\.html">連接帳號</, page);
  const admin = pageIds(new URL('../pages/admin/admin.html', import.meta.url));
  for (const id of ['admin-connectors', 'google-settings-form', 'google-client-id', 'google-client-secret', 'google-settings-save', 'google-redirect-uri', 'google-copy-redirect', 'google-settings-state', 'google-settings-status']) assert.ok(admin.has(id), id);
});

test('完成連接失敗：先盡力作廢 state 再處理；作廢也失敗時請使用者重新發起；登入失效時作廢後登出', async () => {
  for (const [voided, expected] of [[true, RESULT_TEXT.failed], [false, CANCELLED_TEXT]]) {
    const doc = createFakeDocument();
    buildConnectionsDom(doc);
    const win = windowWith('?state=st-9&code=secret-code');
    const api = fakeApi(win, {
      /** 連線失敗 @returns {Promise<never>} 失敗 */ async completeGoogle() { win.order.push(['complete']); throw Object.assign(new Error('連線失敗'), { status: 0 }); },
      /** 記錄並回指定結果 @param {string} value state @returns {Promise<boolean>} 結果 */ async abandonGoogle(value) { win.order.push(['abandon', value]); return voided; },
    });
    await initConnectionsPage(doc, win, { auth: fakeAuth(USER), api });
    assert.deepEqual(win.order.slice(1, 3), [['complete'], ['abandon', 'st-9']], '完成連接失敗後立刻作廢 state');
    assert.equal(doc.querySelector('#connections-status').textContent, expected);
  }
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('?state=st-10&code=secret-code');
  const auth = fakeAuth(USER);
  await initConnectionsPage(doc, win, { auth, api: fakeApi(win, { /** 登入失效 @returns {Promise<never>} 失敗 */ async completeGoogle() { throw Object.assign(new Error('x'), { status: 401 }); } }) });
  assert.ok(win.order.some(/** 找作廢 @param {Array} entry 呼叫 @returns {boolean} 是時 true */ (entry) => entry[0] === 'abandon' && entry[1] === 'st-10'), '登入失效也先作廢');
  assert.deepEqual(auth.calls, ['logout']);
});

test('無障礙：選左邊服務只換 aria-pressed，不重建清單，焦點留在按下的按鈕；重畫清單後焦點放回同一個服務', async () => {
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('');
  const api = fakeApi(win);
  api.state.connectors = connectorsFixture({ connection: { status: 'ACTIVE', account_email: 'racky@example.com', level: 'basic', connected_at: '2026-11-15T03:00:00.000Z' } });
  await initConnectionsPage(doc, win, { auth: fakeAuth(USER), api });
  const list = doc.querySelector('#connector-list');
  const [calendar, mail] = list.querySelectorAll('button');
  mail.focus();
  await mail.click();
  assert.equal(list.querySelectorAll('button')[1], mail, '同一個按鈕元素，沒有重建');
  assert.equal(doc.activeElement, mail);
  assert.deepEqual(list.querySelectorAll('button').map(/** 取選取狀態 @param {object} button 按鈕 @returns {string} 狀態 */ (button) => button.getAttribute('aria-pressed')), ['false', 'true']);
  await calendar.click();
  calendar.focus();
  await doc.querySelector('#disconnect-button').click();
  const rebuilt = doc.querySelector('#connector-list').querySelectorAll('button')[0];
  assert.notEqual(rebuilt, calendar, '中斷連接後清單重畫');
  assert.equal(doc.activeElement, rebuilt, '焦點放回同一個服務');
});

test('提供者文字：同意畫面提示與收回授權的地方取自連接器資料；降級提醒用等級名稱組字；畫面元件與結果文字不寫死提供者', async () => {
  const doc = createFakeDocument();
  buildConnectionsDom(doc);
  const win = windowWith('');
  const api = fakeApi(win);
  api.state.connectors = connectorsFixture({ connect_hint: '按下連接後會開啟提供者的同意畫面', account_page: '提供者帳戶的授權頁面', levels: [{ id: 'low', name: '甲級', summary: '少', reads: ['一'] }, { id: 'high', name: '乙級', summary: '多', reads: ['一', '二'] }], connection: { status: 'ACTIVE', account_email: 'a@example.com', level: 'high', connected_at: '2026-11-15T03:00:00.000Z' } });
  await initConnectionsPage(doc, win, { auth: fakeAuth(USER), api });
  const detail = doc.querySelector('#connector-detail');
  assert.ok(detail.textContent.includes('按下連接後會開啟提供者的同意畫面'));
  const radios = detail.querySelectorAll('input');
  radios[0].checked = true;
  await radios[0].dispatch('change');
  assert.equal(detail.querySelector('.detail-downgrade').textContent, '從乙級改回甲級後，提供者帳戶的授權頁面可能仍列出先前給過的權限；想完全收回，請先中斷連接，再用甲級重新連接');
  const view = readFileSync(new URL('../src/components/connections/connectionsView.js', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /Google|行事曆|進階|基本/, '畫面元件不寫死提供者、服務或等級名稱');
  for (const text of [...Object.values(RESULT_TEXT), CANCELLED_TEXT]) assert.doesNotMatch(text, /Google|行事曆/, text);
});

test('授權網址：用 URL 解析比對通訊協定、主機與路徑，三項都符合才導頁', () => {
  assert.equal(isAllowedAuthorizeUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true);
  for (const href of ['http://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth', 'https://accounts.google.com@evil.example/o/oauth2/v2/auth',
    'https://evil.example/?https://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/v2/auth/../../evil', 'https://accounts.google.com:8443/o/oauth2/v2/auth', 'https://user:pw@accounts.google.com/o/oauth2/v2/auth', 'not a url', 42]) {
    assert.equal(isAllowedAuthorizeUrl(href), false, String(href));
  }
});

test('管理頁密鑰欄：儲存失敗也清空；欄位關掉自動填入並請密碼管理工具不要存；複製按鈕有說明；詳細區沒有 aria-live', async () => {
  const doc = createFakeDocument();
  const nodes = buildAdminConnectorsDom(doc);
  const section = initAdminConnectors(doc, createFakeWindow(), {
    auth: fakeAuth(USER), leave() {},
    /** 讀設定 @returns {Promise<object>} 摘要 */ async load() { return { configured: false, client_id: '', redirect_uri: 'https://example.test/cb', updated_by: null, updated_at: null }; },
    /** 存設定失敗 @returns {Promise<never>} 失敗 */ async save() { throw Object.assign(new Error('暫時無法儲存'), { status: 503 }); },
  });
  nodes['google-client-id'].value = 'test-client.apps.googleusercontent.com';
  nodes['google-client-secret'].value = 'test-client-secret';
  await section.submit();
  assert.equal(nodes['google-client-secret'].value, '', '失敗也清空');
  assert.equal(nodes['google-settings-status'].textContent, '暫時無法儲存');
  const admin = readFileSync(new URL('../pages/admin/admin.html', import.meta.url), 'utf8');
  const secretInput = admin.match(/<input id="google-client-secret"[^>]*>/)[0];
  for (const attribute of ['autocomplete="off"', 'data-lpignore="true"', 'data-1p-ignore']) assert.ok(secretInput.includes(attribute), attribute);
  assert.match(admin, /<button id="google-copy-redirect"[^>]*aria-label="複製回呼網址"/);
  const page = readFileSync(new URL('../pages/connections/connections.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page.match(/<section id="connector-detail"[^>]*>/)[0], /aria-live/);
});
