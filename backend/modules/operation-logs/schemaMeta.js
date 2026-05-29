'use strict';

/** @type {{ hasStatus: boolean; hasMessage: boolean; hasUsername: boolean; hasRole: boolean; hasBeforeData: boolean; hasAfterData: boolean } | null} */
let cache = null;

async function loadOperationLogsSchema(pool) {
  if (cache) return cache;
  if (!pool) {
    cache = {
      hasStatus: false,
      hasMessage: false,
      hasUsername: false,
      hasRole: false,
      hasBeforeData: false,
      hasAfterData: false,
    };
    return cache;
  }
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'operation_logs'`,
  );
  const cols = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.COLUMN_NAME)));
  cache = {
    hasStatus: cols.has('status'),
    hasMessage: cols.has('message'),
    hasUsername: cols.has('username'),
    hasRole: cols.has('role'),
    hasBeforeData: cols.has('before_data'),
    hasAfterData: cols.has('after_data'),
  };
  return cache;
}

function resetOperationLogsSchemaCache() {
  cache = null;
}

/** 状态表达式：无 status 列时仅读 detail_json，避免 Unknown column */
function statusExpr(alias = 'ol') {
  const json = `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.detail_json, '$.status')), 'null')`;
  if (!cache?.hasStatus) {
    return `COALESCE(${json}, 'success')`;
  }
  return `COALESCE(NULLIF(${alias}.status, ''), ${json}, 'success')`;
}

function messageExpr(alias = 'ol') {
  if (cache?.hasMessage) {
    const json = `JSON_UNQUOTE(JSON_EXTRACT(${alias}.detail_json, '$.message'))`;
    return `COALESCE(NULLIF(${alias}.message, ''), NULLIF(${json}, 'null'))`;
  }
  return `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.detail_json, '$.message')), 'null')`;
}

module.exports = {
  loadOperationLogsSchema,
  resetOperationLogsSchemaCache,
  statusExpr,
  messageExpr,
};
