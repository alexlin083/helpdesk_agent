// 本機開發用的靜態檔案伺服器：只提供 frontend 目錄的檔案，監聽 localhost:5173。
// 每個回應都帶 Cache-Control: no-cache（與正式環境的 Caddy 相同），瀏覽器每次重新整理都會向伺服器確認，修改 CSS／JS 後不必強制重新整理。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST = 'localhost';
const PORT = Number(process.env.PORT || 5173);
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
});

/**
 * 把網址路徑轉成 frontend 目錄內的檔案路徑：去掉查詢字串並解碼，目錄（以 / 結尾）補上 index.html；
 * 解析後若跑出 frontend 目錄（例如 ../）則拒絕。
 * @param {string} url 請求網址（例如 /pages/propose/propose.html?v=1）。
 * @returns {string|null} 檔案的絕對路徑；不合法時為 null。
 */
export function resolvePath(url) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname); } catch { return null; }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(ROOT, pathname));
  return file === ROOT || file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) ? file : null;
}

/**
 * 處理一個請求：只接受 GET 與 HEAD；找得到檔案時回 200 與檔案內容（HEAD 不帶內容），找不到回 404，路徑不合法回 400。
 * 所有回應都帶 Cache-Control: no-cache。
 * @param {import('node:http').IncomingMessage} req 請求。
 * @param {import('node:http').ServerResponse} res 回應。
 * @returns {Promise<void>}
 */
async function handle(req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  const file = resolvePath(req.url ?? '/');
  if (!file) { res.writeHead(400).end('Bad Request'); return; }
  try {
    if (!(await stat(file)).isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

/**
 * 啟動伺服器並在主控台印出網址；連接埠被占用等錯誤時印出原因並以結束碼 1 結束。
 * @returns {void}
 */
function start() {
  const server = createServer(/** 轉交請求。@param {object} req 請求。@param {object} res 回應。@returns {Promise<void>} */ (req, res) => handle(req, res));
  server.on('error', /** 啟動失敗。@param {Error & {code?: string}} error 錯誤。@returns {void} */ (error) => {
    console.error(`前端開發伺服器無法啟動（${error.code ?? error.message}）；連接埠 ${PORT} 可能已被使用`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, /** 啟動完成。@returns {void} */ () => console.log(`前端開發伺服器：http://${HOST}:${PORT}/（Cache-Control: no-cache，按 Ctrl + C 停止）`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) start();
