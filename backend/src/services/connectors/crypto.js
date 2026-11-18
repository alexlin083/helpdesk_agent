import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// 加密格式版本、演算法與長度；密文以「版本:iv:tag:ciphertext」（各段 base64url）保存，換演算法時改版本號
// v2：AES-256-GCM 加上附加驗證資料（AAD，為這筆密文所屬的 meta 名稱），把密文綁在原本的名稱上，複製到別人的名稱底下就解不開
// 沒有 AAD 的 v1 是功能上線前的舊格式，搬到別人名下照樣解得開，所以不再接受，一律當成解不開
const VERSION = 'v2';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_INFO = 'helpdesk-connectors-v1';

/**
 * 建立外部服務授權的加解密工具：以 HKDF-SHA256 從伺服器金鑰衍生一把專用的 AES-256-GCM 金鑰，每次加密用新的隨機 IV
 * 伺服器金鑰在第一次加解密時才向 getSecret 取得（正式環境為 AUTH_SECRET，本機為 SQLite meta 表的金鑰），之後快取在記憶體；
 * 換掉伺服器金鑰後舊的密文無法解開，使用者需要重新連接
 * 本機沒設定 AUTH_SECRET 時，金鑰和密文在同一個資料庫檔，拿到檔案就能解開，這時的加密只能防止直接看到原文；正式環境一定要設定 AUTH_SECRET
 * @param {() => string} getSecret 取得伺服器金鑰的函式，回傳至少 32 bytes 的字串
 * @returns {{seal: (text: string, aad: string) => string, open: (sealed: string, aad: string) => string}} seal 加密成可保存的文字；open 解密
 */
export function createSealer(getSecret) {
  let key = null;
  /** 取得（必要時衍生）加密金鑰 @returns {Buffer} 32 bytes 金鑰 */
  function keyOf() {
    if (key) return key;
    const secret = getSecret();
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw Object.assign(new Error('伺服器金鑰不足 32 bytes，無法加密外部服務授權'), { code: 'SEAL_KEY_MISSING' });
    key = Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from(KEY_INFO), 32));
    return key;
  }
  return {
    /**
     * 加密一段文字，並把它綁在所屬的 meta 名稱上（v2 格式）
     * @param {string} text 要保存的明文（例如 refresh token、client secret）
     * @param {string} aad 這筆密文所屬的 meta 名稱（例如 connector_user:racky.huang:google_calendar）
     * @returns {string} 「v2:iv:tag:ciphertext」格式的密文
     * @throws {TypeError} 明文不是字串，或沒有給 meta 名稱
     */
    seal(text, aad) {
      if (typeof text !== 'string') throw new TypeError('只能加密字串');
      if (typeof aad !== 'string' || !aad) throw new TypeError('加密時必須指定所屬的 meta 名稱');
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, keyOf(), iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
    },
    /**
     * 解密 seal 產生的密文；必須用加密時的 meta 名稱才解得開；內容被改過、名稱不同或金鑰不同時 GCM 驗證失敗；v1 舊格式一律拒絕
     * @param {string} sealed 密文
     * @param {string} aad 這筆密文所屬的 meta 名稱
     * @returns {string} 明文
     * @throws {Error} code SEAL_INVALID：格式不符、版本不是 v2、沒給名稱、驗證標籤不是 16 bytes 或驗證失敗；SEAL_KEY_MISSING：伺服器金鑰不足
     */
    open(sealed, aad) {
      const parts = typeof sealed === 'string' ? sealed.split(':') : [];
      if (parts.length !== 4 || parts[0] !== VERSION) throw Object.assign(new Error('密文格式不符'), { code: 'SEAL_INVALID' });
      if (typeof aad !== 'string' || !aad) throw Object.assign(new Error('解密時必須指定所屬的 meta 名稱'), { code: 'SEAL_INVALID' });
      try {
        const decipher = createDecipheriv(ALGORITHM, keyOf(), Buffer.from(parts[1], 'base64url'), { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
      } catch (error) {
        if (error?.code === 'SEAL_KEY_MISSING') throw error;
        throw Object.assign(new Error('密文無法解開（內容被改過、名稱不符或伺服器金鑰已更換）'), { code: 'SEAL_INVALID' });
      }
    },
  };
}
