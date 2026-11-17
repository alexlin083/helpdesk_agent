import { connectionService } from '../services/connectors/index.js';

/**
 * 列出支援與規劃中的外部服務，以及目前帳號的連接狀態
 * @param {object} req 已驗證的一般帳號請求
 * @param {object} res Express 回應
 * @returns {void}
 */
export function listConnectors(req, res) {
  res.json({ connectors: connectionService.list(req.user.username) });
}

/**
 * 發起連接：回傳 Google 授權網址，由前端把瀏覽器導過去；本文 { level } 指定權限等級
 * @param {object} req 已驗證的一般帳號請求，params.id 為連接器 id
 * @param {object} res Express 回應
 * @returns {void}
 * @throws {HttpError} 見 connectionService.startConnect
 */
export function startConnect(req, res) {
  res.json(connectionService.startConnect(req.user.username, req.params.id, req.body?.level));
}

/**
 * 中斷連接：撤銷 Google 授權並刪除本地資料；本來就沒連接時照樣回 200
 * @param {object} req 已驗證的一般帳號請求，params.id 為連接器 id
 * @param {object} res Express 回應
 * @returns {Promise<void>} 完成回應
 * @throws {HttpError} 404 CONNECTOR_NOT_FOUND
 */
export async function disconnect(req, res) {
  res.json(await connectionService.disconnect(req.user.username, req.params.id));
}

/**
 * 完成 Google 連接：Google 授權後導回前端「連接帳號」頁，頁面帶本人的登入憑證送來 { state, code } 或 { state, error }；
 * 帳號必須和發起連接的帳號相同；結果一律以 200 回 { result, connector }，頁面依 result 顯示固定文字
 * @param {object} req 已驗證的一般帳號請求
 * @param {object} res Express 回應
 * @returns {Promise<void>} 完成回應
 */
export async function completeGoogle(req, res) {
  const pick = /** 只取單一字串參數 @param {unknown} value 參數 @returns {string|undefined} 字串 */ (value) => (typeof value === 'string' ? value.slice(0, 2048) : undefined);
  res.json(await connectionService.completeConnect(req.user.username, { state: pick(req.body?.state), code: pick(req.body?.code), error: pick(req.body?.error) }));
}

/**
 * 放棄還沒完成的 Google 連接：連接帳號頁在沒登入時送來 { state }，後端作廢這個 state；不需要登入，持有 state 就是憑據
 * @param {object} req Express 請求
 * @param {object} res Express 回應
 * @returns {void}
 */
export function abandonGoogle(req, res) {
  res.json(connectionService.abandonConnect(typeof req.body?.state === 'string' ? req.body.state.slice(0, 2048) : undefined));
}

/**
 * 管理員查看 Google 連接設定（不含 client secret）
 * @param {object} req 已驗證的管理員請求
 * @param {object} res Express 回應
 * @returns {void}
 */
export function googleSettings(req, res) {
  res.json(connectionService.adminSettings('google_calendar'));
}

/**
 * 管理員儲存 Google 連接設定；client secret 只寫不讀
 * @param {object} req 已驗證的管理員請求，本文 { client_id, client_secret }
 * @param {object} res Express 回應
 * @returns {void}
 * @throws {HttpError} 400 INVALID_PAYLOAD
 */
export function saveGoogleSettings(req, res) {
  res.json(connectionService.saveAdminSettings('google_calendar', req.body, req.user.username));
}
