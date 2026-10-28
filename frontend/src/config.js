// 保留既有 Python 靜態伺服器的本機開發方式；Docker 與正式環境改走同站點 /api。
// Node 測試沒有 location，沿用本機後端位址。公開設定不可包含金鑰或密碼。
const location = globalThis.location;
const separateLocalServer = location?.hostname === 'localhost' && location?.port === '5173';
export const API_BASE_URL = !location || separateLocalServer ? 'http://localhost:3000' : location.origin;
