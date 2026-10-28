import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

export const TICKET_STATUSES = Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

/**
 * 建立需求單儲存無法使用時的固定錯誤並記錄事件；不輸出需求單原文或底層錯誤訊息。
 * @param {string} operation 失敗的操作（load、persist）。
 * @returns {HttpError} 503 TICKET_STORE_UNAVAILABLE。
 */
function unavailable(operation) {
  logger('error', 'tickets.store.unavailable', { operation });
  return new HttpError(503, 'TICKET_STORE_UNAVAILABLE', '需求單儲存暫時無法使用，請稍後再試');
}

/**
 * 建立以單一 JSON 檔保存全部需求單的儲存；第一次使用時載入，之後以記憶體為準並在每次寫入後整檔覆寫。
 * 寫入先寫暫存檔再改名，避免中途失敗留下半截 JSON；所有寫入依序排隊，不會交錯。只適用單一程序。
 * @param {object} [options={}] 設定。
 * @param {string} [options.file=env.ticketsFile] 需求單 JSON 檔的絕對路徑，不存在時自動建立。
 * @returns {object} all、find、insert、update、clear 操作。
 */
export function createFileTicketStore({ file = env.ticketsFile } = {}) {
  let tickets;
  let queue = Promise.resolve();

  /**
   * 載入檔案內容到記憶體；檔案不存在視為空陣列，內容不是陣列視為儲存損毀。
   * @returns {Promise<void>}
   * @throws {HttpError} 檔案無法讀取或解析。
   */
  async function load() {
    if (tickets) return;
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') { tickets = []; return; }
      throw unavailable('load');
    }
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      tickets = parsed;
    } catch { throw unavailable('load'); }
  }

  /**
   * 把暫存檔改名成正式檔；Windows 上防毒或索引程式短暫鎖住檔案時會回 EPERM／EBUSY，最多重試三次（每次間隔 60 毫秒）。
   * @param {string} temporary 暫存檔路徑。
   * @returns {Promise<void>}
   * @throws {Error} 重試後仍失敗的原始錯誤。
   */
  async function renameWithRetry(temporary) {
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, file); return; } catch (error) {
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }
  }

  /**
   * 把記憶體中的需求單整檔寫回磁碟（UTF-8、縮排 2 空白）：先寫暫存檔再改名，改名遇到暫時性鎖定會重試。
   * @returns {Promise<void>}
   * @throws {HttpError} 寫入失敗。
   */
  async function persist() {
    const temporary = `${file}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(tickets, null, 2)}\n`, 'utf8');
      await renameWithRetry(temporary);
    } catch { throw unavailable('persist'); }
  }

  /**
   * 將操作排入序列，確保同一時間只有一個讀寫在進行。
   * @param {Function} task 要執行的非同步操作。
   * @returns {Promise<*>} 操作結果。
   */
  function serialize(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  return {
    /**
     * 在維護鎖內排隊清空所有需求單，同步更新快取與磁碟；寫檔失敗還原快取。
     * 呼叫端必須先阻擋新請求並排空既有工作，避免 AI 回覆在清空後重新寫入。
     * @returns {Promise<number>} 已清除的工作單筆數。
     * @throws {HttpError} 檔案無法載入或寫入；失敗時不重置其他保護計數。
     */
    clear() {
      /** 原子替換為空陣列，沿用暫存檔改名與程序內排隊。@returns {Promise<number>} 清除筆數。 */
      async function clearAll() {
        await load();
        const previous = tickets;
        tickets = [];
        try { await persist(); } catch (error) { tickets = previous; throw error; }
        return previous.length;
      }
      return serialize(clearAll);
    },
    /** 取得所有需求單的複本。@returns {Promise<object[]>} 需求單陣列。 */
    all() { return serialize(async () => { await load(); return structuredClone(tickets); }); },
    /**
     * 依單號查詢。
     * @param {string} ticketId 單號。
     * @returns {Promise<object|null>} 需求單複本，查無時 null。
     */
    find(ticketId) {
      return serialize(async () => { await load(); const found = tickets.find((ticket) => ticket.ticket_id === ticketId); return found ? structuredClone(found) : null; });
    },
    /**
     * 新增一張需求單並寫回檔案；單號重複視為程式錯誤。寫檔失敗時把記憶體中的那筆移除，避免呼叫端重送後產生重複的需求單。
     * @param {object} ticket 已組好的需求單。
     * @returns {Promise<object>} 寫入後的複本。
     * @throws {HttpError} 單號重複或寫入失敗。
     */
    insert(ticket) {
      return serialize(async () => {
        await load();
        if (tickets.some((item) => item.ticket_id === ticket.ticket_id)) throw unavailable('persist');
        tickets.push(structuredClone(ticket));
        try { await persist(); } catch (error) { tickets.pop(); throw error; }
        return structuredClone(ticket);
      });
    },
    /**
     * 以修改函式更新一張需求單並寫回檔案；修改函式收到複本，回傳的物件取代原記錄。
     * @param {string} ticketId 單號。
     * @param {(ticket: object) => object} mutate 同步修改函式，可拋出 HttpError 拒絕更新。
     * @returns {Promise<object>} 更新後的複本。
     * @throws {HttpError} 404 TICKET_NOT_FOUND、修改函式拋出的錯誤或寫入失敗。
     */
    update(ticketId, mutate) {
      return serialize(async () => {
        await load();
        const index = tickets.findIndex((ticket) => ticket.ticket_id === ticketId);
        if (index < 0) throw new HttpError(404, 'TICKET_NOT_FOUND', '找不到這張需求單');
        const next = mutate(structuredClone(tickets[index]));
        const previous = tickets[index];
        tickets[index] = next;
        try { await persist(); } catch (error) { tickets[index] = previous; throw error; }
        return structuredClone(next);
      });
    },
  };
}

export const ticketStore = createFileTicketStore();
