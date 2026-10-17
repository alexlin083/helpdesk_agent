import { Router } from 'express';
import { accountFor, authService } from '../services/authService.js';
import { usageService } from '../services/usageService.js';
import { HttpError } from '../middleware/errorHandler.js';

const router = Router();
router.post('/login', login);

/**
 * 驗證十組展示帳號，原子套用 IP 整體及已知帳號＋IP 的失敗限制，再簽發憑證。
 * 未知帳號只累積 IP 失敗，不以任意輸入建立計數；不寫入密碼或憑證日誌。
 * @param {import('express').Request} req 包含 username 與 password。
 * @param {import('express').Response} res 回傳 token 與身分。
 * @returns {Promise<void>}
 * @throws {HttpError} 格式無效、查無帳號、密碼錯誤、限流或儲存故障。
 */
async function login(req, res) {
  const { username, password } = req.body ?? {};
  const wellFormed = typeof username === 'string' && username.length <= 100 && typeof password === 'string' && password.length <= 200;
  const name = wellFormed ? username.trim() : '';
  const user = wellFormed ? authService.credentials(name, password) : null;
  const account = accountFor(name);
  await usageService.loginAttempt(req.ip || req.socket.remoteAddress || 'unknown', Boolean(user), account?.username);
  if (!wellFormed) throw new HttpError(400, 'INVALID_PAYLOAD', '請提供有效帳號與密碼');
  if (!account) throw new HttpError(401, 'USER_NOT_FOUND', '查無使用者');
  if (!user) throw new HttpError(401, 'INVALID_CREDENTIALS', '密碼錯誤');
  res.set('Cache-Control', 'no-store');
  res.json(await authService.issue(user));
}
export default router;
