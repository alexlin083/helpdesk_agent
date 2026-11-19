import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeDocument, createFakeWindow } from './helpers/fakeDom.js';
import { initAdminSections } from '../src/components/admin/adminSections.js';

const IDS = ['admin-monitoring', 'admin-tickets', 'admin-accounts', 'admin-protection', 'admin-connectors', 'admin-holidays', 'admin-reset'];

/**
 * 建立左側清單與六個區塊（id 和 admin.html 相同），視窗記錄改網址與捲動
 * @param {string} [hash=''] 網址的 hash
 * @returns {object} 文件、視窗、連結與區塊
 */
function setup(hash = '') {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  win.location.hash = hash;
  win.replaced = [];
  win.scrolls = 0;
  win.history = { /** 記錄改網址 @param {unknown} state 狀態 @param {string} title 標題 @param {string} url 網址 @returns {void} */ replaceState(state, title, url) { win.replaced.push(url); } };
  /** 記錄回到頁首 @returns {void} */
  win.scrollTo = () => { win.scrolls += 1; };
  const nav = doc.createElement('nav');
  nav.className = 'admin-nav';
  doc.body.append(nav);
  const links = {};
  const sections = {};
  for (const id of IDS) {
    const link = doc.createElement('a');
    link.setAttribute('href', `#${id}`);
    nav.append(link);
    links[id] = link;
    const section = doc.createElement('section');
    section.setAttribute('id', id);
    doc.body.append(section);
    sections[id] = section;
  }
  return { doc, win, links, sections };
}

/**
 * 列出目前看得到的區塊
 * @param {object} sections 區塊
 * @returns {string[]} 沒有 hidden 的區塊 id
 */
function visible(sections) { return IDS.filter(/** 沒有隱藏 @param {string} id 區塊 id @returns {boolean} 看得到時 true */ (id) => !sections[id].hidden); }

/**
 * 列出清單上標成目前項目的連結
 * @param {object} links 連結
 * @returns {string[]} 有 aria-current 的區塊 id
 */
function marked(links) { return IDS.filter(/** 是目前項目 @param {string} id 區塊 id @returns {boolean} 是時 true */ (id) => links[id].getAttribute('aria-current') === 'true'); }

test('管理頁左側清單：預設只顯示即時監測，清單標出目前項目', () => {
  const { doc, win, links, sections } = setup();
  const page = initAdminSections(doc, win);
  assert.deepEqual(visible(sections), ['admin-monitoring']);
  assert.deepEqual(marked(links), ['admin-monitoring']);
  assert.equal(page.current(), 'admin-monitoring');
});

test('管理頁左側清單：點一項只顯示那一區，改網址並回到頁首，不跳錨點', async () => {
  const { doc, win, links, sections } = setup();
  initAdminSections(doc, win);
  let prevented = 0;
  await links['admin-tickets'].dispatch('click', { /** 記錄攔下錨點跳躍 @returns {void} */ preventDefault() { prevented += 1; } });
  assert.deepEqual(visible(sections), ['admin-tickets']);
  assert.deepEqual(marked(links), ['admin-tickets']);
  assert.deepEqual(win.replaced, ['#admin-tickets']);
  assert.equal(win.scrolls, 1);
  assert.equal(prevented, 1);
  await links['admin-reset'].click();
  assert.deepEqual(visible(sections), ['admin-reset'], '清除工作單也是單獨一區');
  assert.deepEqual(marked(links), ['admin-reset']);
});

test('管理頁左側清單：網址帶區塊時打開那一區，不認得的改開即時監測；上一頁或改網址時跟著切換', () => {
  const opened = setup('#admin-connectors');
  initAdminSections(opened.doc, opened.win);
  assert.deepEqual(visible(opened.sections), ['admin-connectors']);
  const unknown = setup('#admin-nothing');
  initAdminSections(unknown.doc, unknown.win);
  assert.deepEqual(visible(unknown.sections), ['admin-monitoring']);
  unknown.win.location.hash = '#admin-protection';
  unknown.win.events.get('hashchange')();
  assert.deepEqual(visible(unknown.sections), ['admin-protection']);
  assert.deepEqual(marked(unknown.links), ['admin-protection']);
});

test('管理頁左側清單：瀏覽器不能改網址或捲動時照樣切換；頁面沒有清單時不做事', async () => {
  const { doc, win, links, sections } = setup();
  win.history = { /** 模擬瀏覽器拒絕改網址 @returns {never} 例外 */ replaceState() { throw new Error('blocked'); } };
  delete win.scrollTo;
  initAdminSections(doc, win);
  await links['admin-accounts'].click();
  assert.deepEqual(visible(sections), ['admin-accounts']);
  assert.equal(initAdminSections(createFakeDocument(), createFakeWindow()), null);
});

test('管理頁檔：載入前就只顯示即時監測，避免一開頁全部區塊閃一下', () => {
  const html = readFileSync(new URL('../pages/admin/admin.html', import.meta.url), 'utf8');
  for (const id of IDS) {
    const tag = html.match(new RegExp(`<section id="${id}"[^>]*>`))[0];
    assert.equal(/\shidden[\s>]/.test(tag), id !== 'admin-monitoring', id);
  }
  assert.match(html, /<a href="#admin-monitoring" aria-current="true">/);
});
