import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 前端畫面完全依後端的需求類型定義繪製；這些是特定需求類型才會出現的欄位代號、類型 id 或領域文字，不應出現在前端程式碼（註解除外）中。
const FORBIDDEN = ['請假', '假別', '代理人', '特休', '病假', '事假', 'leave_type', 'start_at', 'end_at', "'leave'", '"leave"', 'agent', 'LEAVE_', '設備', 'equipment', 'quantity', 'needed_by'];
const ROOTS = ['../src', '../pages'];

/**
 * 遞迴列出目錄下所有 .js 與 .html 檔案。
 * @param {string} directory 目錄的絕對路徑。
 * @returns {string[]} 檔案的絕對路徑。
 */
function listSources(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...listSources(path));
    else if (/\.(js|html)$/.test(name)) files.push(path);
  }
  return files;
}

/**
 * 移除 JavaScript 的區塊註解與行註解（行註解只認行首或空白後的 //，避免誤刪網址）以及 HTML 註解；註解中的說明範例不列入檢查。
 * @param {string} text 原始檔內容。
 * @returns {string} 去除註解後的內容。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * 驗證前端程式碼與頁面不含任何特定需求類型的欄位代號、類型 id 或領域文字（新增需求類型只需要後端的 JSON 定義檔）。
 * @returns {void}
 */
function noDomainStrings() {
  const found = [];
  for (const root of ROOTS) {
    for (const file of listSources(fileURLToPath(new URL(root, import.meta.url)))) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const word of FORBIDDEN) if (code.includes(word)) found.push(`${file}: ${word}`);
    }
  }
  assert.deepEqual(found, []);
}
test('前端程式碼不含特定需求類型的欄位或文字', noDomainStrings);
