/**
 * 建立文字元素；動態資料一律透過 textContent 放入，避免使用者或 AI 內容被解析成 HTML。
 * @param {string} tag HTML 標籤名稱。
 * @param {string} [className=''] 樣式類別。
 * @param {string} [text=''] 純文字內容。
 * @returns {HTMLElement} 尚未加入文件的元素。
 */
export function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
