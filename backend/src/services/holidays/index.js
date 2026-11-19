import { dataStore } from '../storage/dataStore.js';
import { getRequestTypes } from '../requestTypes/registry.js';
import { logger } from '../../utils/logger.js';
import { createHolidaySync } from './holidaySync.js';

// 正式服務使用的假日同步服務：資料存在 SQLite 的 meta 表，定義檔的假日由需求類型目錄提供；測試以 createHolidaySync 另外建立，注入假的來源與資料庫
export const holidaySync = createHolidaySync({ store: dataStore, types: getRequestTypes, log: logger });
