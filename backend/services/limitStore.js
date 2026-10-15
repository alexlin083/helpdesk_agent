import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * 建立單一程序的測試／開發儲存；每次同步修改快照後提交，重啟會歸零。
 * @returns {object} read 與 transact 操作；mutator 必須同步且沒有外部副作用。
 */
export function createMemoryLimitStore() {
  let state = {};
  return {
    /** 讀取獨立快照。@returns {Promise<object>} 目前限制資料。 */
    async read() { return structuredClone(state); },
    /**
     * 在同一個事件迴圈中同步執行限制檢查與寫入，失敗不提交。
     * @param {Function} mutate 同步修改快照並回傳結果的函式。
     * @returns {Promise<unknown>} 修改函式的結果。
     */
    async transact(mutate) {
      const next = structuredClone(state);
      const result = mutate(next);
      state = next;
      return result;
    },
  };
}

/**
 * 建立 DynamoDB 單項目版本鎖定儲存，原子性更新帳號／全站配額與並行租約。
 * 適用於十組課堂帳號；同一部署所有 instance 必須使用相同表格。
 * @param {object} [options={}] AWS 設定與可注入 client。
 * @param {object} [options.client] DynamoDB DocumentClient。
 * @param {string} [options.table=env.limitTable] 以 pk（String）為主鍵的表格。
 * @returns {object} read 與 transact；儲存失敗時拒絕新請求，不退回記憶體。
 */
export function createDynamoLimitStore({ client, table = env.limitTable } = {}) {
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.awsRegion, maxAttempts: 1,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 } }));
  const key = { pk: 'helpdesk#limits#v1' };
  /**
   * 讀取強一致版本快照，避免使用過時配額。
   * @returns {Promise<object>} DynamoDB 項目，尚未建立時回傳空物件。
   */
  async function snapshot() {
    return (await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item ?? {};
  }
  /**
   * 將不可用的限制儲存轉成安全的 503，避免資料庫故障時放行 Gemini。
   * @returns {HttpError} 可回傳前端的固定錯誤。
   */
  function unavailable() {
    logger('error', 'limits.store.unavailable');
    return new HttpError(503, 'LIMIT_STORE_UNAVAILABLE', '用量保護服務暫時無法使用，請稍後再試');
  }
  return {
    /** 讀取限制資料。@returns {Promise<object>} 狀態。@throws {HttpError} AWS 無法使用。 */
    async read() {
      try { return (await snapshot()).state ?? {}; } catch { throw unavailable(); }
    },
    /**
     * 使用版本條件寫入；衝突時重新讀取再計算，確保不超額與不部分扣款。
     * SDK 寫入重試結果不明時拒絕請求，不再次扣額，可能保守消耗一次配額。
     * @param {Function} mutate 同步且無副作用的狀態修改函式，可能執行多次。
     * @returns {Promise<unknown>} 已成功提交版本的結果。
     * @throws {HttpError} 業務限制、儲存故障或持續競爭。
     */
    async transact(mutate) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        let item;
        try { item = await snapshot(); } catch { throw unavailable(); }
        const state = structuredClone(item.state ?? {});
        const result = mutate(state);
        try {
          await client.send(new PutCommand({ TableName: table,
            Item: { ...key, version: (item.version ?? 0) + 1, state },
            ConditionExpression: item.version === undefined ? 'attribute_not_exists(pk)' : '#version = :version',
            ...(item.version === undefined ? {} : { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': item.version } }),
          }));
          return result;
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException') throw unavailable();
        }
      }
      throw unavailable();
    },
  };
}

export const limitStore = env.limitStore === 'dynamodb' ? createDynamoLimitStore() : createMemoryLimitStore();
