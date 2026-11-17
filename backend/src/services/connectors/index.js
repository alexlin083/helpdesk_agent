import { env } from '../../config/env.js';
import { accountService } from '../personnel/accountService.js';
import { dataStore } from '../storage/dataStore.js';
import { createCalendarTools } from './calendarMcp.js';
import { createConnectionService } from './connectionService.js';
import { createSealer } from './crypto.js';
import { createGoogleOAuth } from './googleOAuth.js';
import { createLazyRegistry } from './registry.js';

// 加密外部服務授權的伺服器金鑰：正式環境為 AUTH_SECRET（env 在 production 缺少時拒絕啟動），本機沒設定時用保存在 SQLite meta 表的本機金鑰
const sealer = createSealer(/** 取得伺服器金鑰 @returns {string} 金鑰 */ () => env.authSecret || dataStore.localAuthSecret());

// 正式服務使用的連接服務；Google 授權後導回 PUBLIC_APP_URL 底下的連接帳號頁；連接器設定檔延後載入，壞掉時只停用連接功能
// 測試以 createConnectionService 另外建立，注入假的 Google 與資料庫
export const connectionService = createConnectionService({
  store: dataStore, accounts: accountService, registry: createLazyRegistry(), sealer, oauth: createGoogleOAuth(), publicAppUrl: env.publicAppUrl,
});

// 需求類型的行事曆工具（calendar_busy、calendar_events）：經官方 MCP SDK 的記憶體連線呼叫自寫的唯讀行事曆伺服器，只查本人
export const calendarTools = createCalendarTools({ connections: connectionService });
