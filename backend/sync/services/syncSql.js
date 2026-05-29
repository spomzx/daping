'use strict';

/**
 * @param {string} tag
 * @param {string} table
 * @param {unknown} err
 * @param {Record<string, unknown>} [extra]
 */
function logSyncSqlError(tag, table, err, extra) {
  const parts = [
    `[sync-worker] sqlTag=${tag}`,
    `table=${table}`,
    `error=${String(err?.message || err)}`,
  ];
  if (extra && Object.keys(extra).length) {
    parts.push(`detail=${JSON.stringify(extra)}`);
  }
  console.error(parts.join(' '));
}

/**
 * @param {import('mysql2/promise').Pool | import('mysql2/promise').Connection} db
 * @param {{ tag: string, table: string, sql: string, params?: unknown[] }} spec
 */
async function runSyncSql(db, spec) {
  const { tag, table, sql, params = [] } = spec;
  try {
    return await db.query(sql, params);
  } catch (err) {
    logSyncSqlError(tag, table, err);
    const e = err instanceof Error ? err : new Error(String(err));
    e.sqlTag = tag;
    e.sqlTable = table;
    e.sqlTagLogged = true;
    throw e;
  }
}

module.exports = { logSyncSqlError, runSyncSql };
