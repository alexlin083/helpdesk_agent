// 共用標點規範：不使用句號「。」，句子之間改用「；」串接，句尾不加句號（問號、驚嘆號照常使用）
// 「自動生成」（Gemini 與 Claude）與 AI 判斷部門的輸出整理都使用這裡的函式，「自動生成」的回應出口也用它整理招呼語、檢核清單與固定說明；
// 提示詞另外要求模型遵守，這裡是不依賴模型的最後一道整理
const FULL_STOP = '。';
const JOINER = '；';
// 句號後面接這些字元時直接刪除句號，不改成「；」：收尾的引號與括號，以及其他標點。
const CLOSERS = new Set(Array.from('」』）》〉】〕］｝)]}"\'”’'));
const MARKS = new Set(Array.from('，、；：！？,;:!?…'));
const INLINE_SPACE = /[^\S\n]/u;

/**
 * 依共用標點規範整理顯示給使用者的文字（AI 輸出與「自動生成」回應中的固定文字）：
 * - 句尾的「。」（後面只剩空白、換行或文字結束）刪除；
 * - 「。」後面接收尾的引號、括號或其他標點時刪除（例如「好。」→「好」、「。，」→「，」）；
 * - 「。」前面已經是標點或位於行首時刪除，避免出現「；；」「？；」；
 * - 其他位於句子之間的「。」改成「；」；連續的「。」視為一個。
 * 只處理全形句號「。」，不改動英文句點、問號與驚嘆號，也不增刪其他文字。
 * @param {string} text 已去除首尾空白的文字。
 * @returns {string} 整理後的文字；沒有「。」時原樣回傳。
 */
export function removeFullStops(text) {
  if (!text.includes(FULL_STOP)) return text;
  const chars = Array.from(text);
  let result = '';
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== FULL_STOP) { result += chars[index]; continue; }
    let next = index + 1;
    while (chars[next] === FULL_STOP) next += 1;
    let ahead = next;
    while (ahead < chars.length && INLINE_SPACE.test(chars[ahead])) ahead += 1;
    const following = chars[ahead];
    const previous = result.replace(/[^\S\n]+$/u, '').at(-1);
    const ending = following === undefined || following === '\n' || CLOSERS.has(following) || MARKS.has(following);
    const joined = previous === undefined || previous === '\n' || MARKS.has(previous);
    if (!ending && !joined) result += JOINER;
    index = next - 1;
  }
  return result;
}
