import { readFileSync } from 'node:fs';
import { env } from '../config/env.js';
import { logger, diagnoseError } from '../utils/logger.js';

const knowledgeBase = JSON.parse(readFileSync(new URL('../data/knowledgeBase.json', import.meta.url), 'utf8'));

function validateVector(vector) {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)
    || !vector.some((value) => value !== 0)) throw new Error('Invalid embedding');
}

export function cosineSimilarity(left, right) {
  validateVector(left);
  validateVector(right);
  if (left.length !== right.length) throw new Error('Embedding dimensions differ');
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const magnitude = (vector) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const similarity = dot / (magnitude(left) * magnitude(right));
  if (!Number.isFinite(similarity)) throw new Error('Invalid similarity');
  // API 合約要求 0～1；負相關顯示為 0。
  return Math.max(0, Math.min(1, similarity));
}

/**
 * 建立檢索器；文件向量以共用 Promise 快取，失敗時清除以允許後續請求重建。
 * @param {object} [options={}] 檢索設定。
 * @param {Array<object>} [options.documents=knowledgeBase] 已切片文件。
 * @param {string} [options.model=env.geminiEmbeddingModel] 向量模型名稱。
 * @returns {Function} 接受問題與 SDK client、回傳 Top-3 文件的非同步函式。
 */
export function createKnowledgeRetriever({ documents = knowledgeBase, model = env.geminiEmbeddingModel } = {}) {
  let indexPromise;
  /**
   * 呼叫 Gemini embedding 並驗證向量；以 taskType 區分文件索引與問題向量。
   * @param {object} ai SDK client。
   * @param {string[]} contents 待向量化文字，原文不寫入日誌。
   * @param {string} taskType 文件或查詢用途。
   * @returns {Promise<number[][]>} 通過數量與數值驗證的向量。
   * @throws {Error} 上游失敗或回傳向量異常；日誌記錄固定原因與排查提示。
   */
  async function embed(ai, contents, taskType) {
    const started = Date.now();
    let stage = 'api';
    logger('info', 'gemini.embedding.started', { model, taskType, itemCount: contents.length });
    logger('debug', 'gemini.embedding.config', { model, taskType, dimensions: 768, timeoutMs: 30000 });
    try {
      const response = await ai.models.embedContent({
        model, contents,
        config: { taskType, outputDimensionality: 768, httpOptions: { timeout: 30000 } },
      });
      stage = 'validate';
      const vectors = [];
      for (const item of response.embeddings ?? []) vectors.push(item.values);
      if (vectors.length !== contents.length) throw new Error('Missing embeddings');
      vectors.forEach(validateVector);
      logger('info', 'gemini.embedding.completed', { model, taskType, itemCount: vectors.length, durationMs: Date.now() - started });
      logger('debug', 'gemini.embedding.metadata', { dimensions: vectors[0]?.length });
      return vectors;
    } catch (error) {
      logger('error', 'gemini.embedding.failed', { model, taskType, stage, durationMs: Date.now() - started,
        ...diagnoseError(error), ...(stage === 'validate' ? { reason: 'INVALID_EMBEDDING', hint: '向量數量或數值異常，確認 embedding 模型與回傳格式。' } : {}) });
      throw error;
    }
  }

  /**
   * 重設失敗的文件索引並傳遞原始錯誤，不在同一請求中自動重送。
   * @param {Error} error 建立索引時的錯誤。
   * @returns {never}
   * @throws {Error} 原始錯誤供 Agent 統一處理。
   */
  function resetIndex(error) {
    indexPromise = undefined;
    logger('debug', 'knowledge.index.reset');
    throw error;
  }

  /**
   * 取得文件向量後建立查詢向量，依相似度降冪排序並回傳最多三筆資料。
   * @param {string} message 單次使用者問題。
   * @param {object} ai SDK client。
   * @returns {Promise<Array<object>>} 帶有相似度的文件段落；無文件時回傳空陣列。
   * @throws {Error} embedding 或向量計算失敗。
   */
  return async function retrieve(message, ai) {
    const started = Date.now();
    if (!documents.length) return [];
    // 共用 Promise 避免同時重複建立記憶體索引，失敗可重試。
    logger('debug', 'knowledge.index.state', { cachedOrPending: Boolean(indexPromise), documentCount: documents.length });
    if (!indexPromise) {
      const contents = [];
      for (const doc of documents) contents.push(`${doc.doc_name}\n${doc.content}`);
      indexPromise = embed(ai, contents, 'RETRIEVAL_DOCUMENT').catch(resetIndex);
    }
    const vectors = await indexPromise;
    const [query] = await embed(ai, [message], 'RETRIEVAL_QUERY');
    const ranked = [];
    for (const [index, doc] of documents.entries()) ranked.push({ ...doc, relevance: cosineSimilarity(query, vectors[index]) });
    /**
     * 依向量相似度降冪排序；先以原始精度排序，選出結果後才四捨五入。
     * @param {object} left 左側文件。
     * @param {object} right 右側文件。
     * @returns {number} 陣列排序比較值。
     */
    function byRelevance(left, right) { return right.relevance - left.relevance; }
    const top = ranked.sort(byRelevance).slice(0, 3);
    const scores = [];
    for (const doc of top) {
      doc.relevance = Number(doc.relevance.toFixed(4));
      scores.push(doc.relevance);
    }
    logger('debug', 'knowledge.retrieve.completed', { sourceCount: top.length, scores, durationMs: Date.now() - started });
    return top;
  };
}
