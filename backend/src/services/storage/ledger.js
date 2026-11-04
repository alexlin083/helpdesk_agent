// 通用額度帳（ledger）的計算：服務的需求單儲存（dataStore.js）與人員維運（personnel.js 的 grant）共用，
// 只依傳入的 SQL 語句函式與允許清單運作，不開連線、不依賴其他模組，避免 dataStore 與 personnel 互相匯入

// 只計算這兩種狀態的需求單（待簽核先扣除，已退回與已取消不計）。
export const ACTIVE_STATUSES = "('PENDING', 'APPROVED')";

/**
 * 組出需求單文件中表單欄位或計算結果的 JSON 路徑；需求類型的 key 已由定義驗證為小寫英數與底線，
 * 這裡再檢查一次，路徑一律以參數綁定傳入 SQL，不拼接進語句。
 * @param {'fields'|'computed'} group 欄位或計算結果。
 * @param {string} key 欄位或計算結果的 key。
 * @returns {string} 例如 $.form.fields.category。
 * @throws {Error} key 格式不符（程式錯誤，不應發生）。
 */
export function formPath(group, key) {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error('ledger 路徑的 key 格式不符');
  return `$.form.${group}.${key}`;
}

/**
 * 依允許清單取得額度資料表的設定；資料表與欄位名稱只會來自程式內的允許清單，因此可以組成 SQL。
 * @param {object} ledgerTables 允許的額度資料表（database.js 的 LEDGER_TABLES）。
 * @param {string} table 資料表名稱。
 * @returns {object} 欄位設定。
 * @throws {Error} 資料表不在允許清單。
 */
export function ledgerTable(ledgerTables, table) {
  if (!Object.hasOwn(ledgerTables, table)) throw new Error(`額度資料表 ${table} 不在允許清單`);
  return ledgerTables[table];
}

/**
 * 依 ledger 規格計算申請人某期間各類別的額度：額度表＋人資調整－已核准－待簽核的同類需求單數量。
 * 需求單的類別、數量與期間優先取自送出時保存的 form.ledger；沒有這份快照的舊版需求單改取定義指定的欄位與計算結果
 * （期間為期間欄位的年度）。已退回與已取消的需求單不計，因此取消或清空需求單後剩餘自然回到額度＋調整。
 * @param {Function} statement 依 SQL 取得快取語句的函式。
 * @param {object} ledgerTables 允許的額度資料表。
 * @param {object} spec ledger 規格（typeId、table、categoryField、amountKey、periodField、categories）。
 * @param {string} username 申請人帳號。
 * @param {number} period 期間（年度）。
 * @returns {Array<{category: string, granted: number, adjusted: number, used: number, pending: number, remaining: number}>}
 *   依 categories 順序的額度；used 為已核准、pending 為待簽核。
 */
export function computeLedgerBalances(statement, ledgerTables, spec, username, period) {
  const table = ledgerTable(ledgerTables, spec.table);
  const byCategory = new Map(spec.categories.map(/** 建立類別的初始額度。@param {string} category 類別。@returns {[string, object]} [類別, 額度]。 */ (category) => [category,
    { category, granted: 0, adjusted: 0, used: 0, pending: 0, remaining: 0 }]));
  const granted = statement(`SELECT ${table.category} AS category, ${table.amount} AS amount FROM ${spec.table} WHERE ${table.owner} = ? AND ${table.period} = ?`);
  for (const row of granted.all(username, period)) if (byCategory.has(row.category)) byCategory.get(row.category).granted = row.amount;
  const adjustments = table.adjustments;
  if (adjustments) {
    const adjusted = statement(`SELECT ${adjustments.category} AS category, SUM(${adjustments.amount}) AS amount FROM ${adjustments.table} WHERE ${adjustments.owner} = ? AND ${adjustments.period} = ? GROUP BY 1`);
    for (const row of adjusted.all(username, period)) if (byCategory.has(row.category)) byCategory.get(row.category).adjusted = row.amount;
  }
  const usage = statement(`SELECT COALESCE(json_extract(document, '$.form.ledger.category'), json_extract(document, ?)) AS category,
      json_extract(document, '$.status') AS status,
      SUM(COALESCE(json_extract(document, '$.form.ledger.amount'), json_extract(document, ?))) AS amount
    FROM tickets
    WHERE json_extract(document, '$.form.id') = ? AND json_extract(document, '$.requester.username') = ?
      AND json_extract(document, '$.status') IN ${ACTIVE_STATUSES}
      AND COALESCE(json_extract(document, '$.form.ledger.period'), CAST(substr(json_extract(document, ?), 1, 4) AS INTEGER)) = ?
    GROUP BY 1, 2`);
  for (const row of usage.all(formPath('fields', spec.categoryField), formPath('computed', spec.amountKey), spec.typeId, username, formPath('fields', spec.periodField), period)) {
    const balance = byCategory.get(row.category);
    if (!balance) continue;
    if (row.status === 'APPROVED') balance.used += row.amount;
    else balance.pending += row.amount;
  }
  const balances = [...byCategory.values()];
  for (const balance of balances) balance.remaining = balance.granted + balance.adjusted - balance.used - balance.pending;
  return balances;
}
