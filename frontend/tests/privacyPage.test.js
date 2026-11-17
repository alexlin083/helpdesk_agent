import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PRIVACY = new URL('../pages/privacy/privacy.html', import.meta.url);
const CONNECTIONS = new URL('../pages/connections/connections.html', import.meta.url);
const CONNECTORS = new URL('../../backend/src/services/connectors/connectors.json', import.meta.url);
const CALENDAR_MCP = new URL('../../backend/src/services/connectors/calendarMcp.js', import.meta.url);

test('隱私權政策頁：公開頁不放腳本、不隱藏，五段標題與關鍵說明都在', () => {
  const html = readFileSync(PRIVACY, 'utf8');
  assert.doesNotMatch(html, /<script/i, '不放腳本，沒登入也能直接看');
  assert.doesNotMatch(html.match(/<body[^>]*>/)[0], /hidden/, 'body 不隱藏');
  for (const heading of ['什麼時候會讀', '會讀哪些資料', '怎麼使用', '存在哪裡、存多久', '怎麼收回']) assert.match(html, new RegExp(`<h2>${heading}</h2>`), heading);
  for (const text of ['<title>隱私權政策', '最後更新：2026-11-16', '忙碌時段', '行程標題', 'email', 'Google Gemini', 'Anthropic Claude', 'AES-256-GCM', '中斷連接', 'href="https://myaccount.google.com/connections"']) assert.ok(html.includes(text), text);
});

test('隱私權政策頁：連接帳號頁有連結；寫的範圍與標題字數和連接器設定一致', () => {
  assert.match(readFileSync(CONNECTIONS, 'utf8'), /<a href="\.\.\/privacy\/privacy\.html">隱私權政策<\/a>/);
  const google = JSON.parse(readFileSync(CONNECTORS, 'utf8')).connectors.filter((item) => item.provider === 'google' && item.status === 'available');
  const scopes = new Set(google.flatMap((item) => item.levels.flatMap((level) => level.scopes)));
  const described = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/calendar.events.readonly'];
  assert.deepEqual([...scopes].sort(), [...described].sort(), '連接器的授權範圍變了，隱私權政策頁要跟著改');
  const limit = readFileSync(CALENDAR_MCP, 'utf8').match(/const TITLE_LIMIT = (\d+);/)[1];
  assert.ok(readFileSync(PRIVACY, 'utf8').includes(`最多 ${limit} 字`), '行程標題字數上限和行事曆工具一致');
});
