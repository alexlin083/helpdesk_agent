import { readFileSync } from 'node:fs';
import { env } from '../config/env.js';

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

export function createKnowledgeRetriever({ documents = knowledgeBase, model = env.geminiEmbeddingModel } = {}) {
  let indexPromise;
  async function embed(ai, contents, taskType) {
    const response = await ai.models.embedContent({
      model, contents,
      config: { taskType, outputDimensionality: 768, httpOptions: { timeout: 30000 } },
    });
    const vectors = response.embeddings?.map((item) => item.values);
    if (!vectors || vectors.length !== contents.length) throw new Error('Missing embeddings');
    vectors.forEach(validateVector);
    return vectors;
  }

  return async (message, ai) => {
    if (!documents.length) return [];
    // 共用 Promise 避免同時重複建立記憶體索引，失敗可重試。
    indexPromise ??= embed(ai, documents.map((doc) => `${doc.doc_name}\n${doc.content}`), 'RETRIEVAL_DOCUMENT')
      .catch((error) => { indexPromise = undefined; throw error; });
    const vectors = await indexPromise;
    const [query] = await embed(ai, [message], 'RETRIEVAL_QUERY');
    return documents.map((doc, index) => ({ ...doc, relevance: cosineSimilarity(query, vectors[index]) }))
      .sort((a, b) => b.relevance - a.relevance).slice(0, 3)
      .map((doc) => ({ ...doc, relevance: Number(doc.relevance.toFixed(4)) }));
  };
}
