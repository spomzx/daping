'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const {
  migrateSyncStability41,
  verifySyncStabilitySchema,
} = require('../../db/migrateSyncStability41');

let schemaReadyCache = null;
let schemaEnsurePromise = null;

/**
 * 启动前确保迁移已执行并校验表结构
 * @returns {Promise<{ ok: boolean, missing?: string[] }>}
 */
async function ensureSyncSchemaReady() {
  if (schemaReadyCache?.ok) return schemaReadyCache;

  if (schemaEnsurePromise) return schemaEnsurePromise;

  schemaEnsurePromise = (async () => {
    const pool = getMysqlPool();
    if (!pool) {
      return { ok: false, missing: ['mysql_unavailable'] };
    }

    const conn = await pool.getConnection();
    try {
      await migrateSyncStability41(conn);
      const v = await verifySyncStabilitySchema(conn);
      schemaReadyCache = v;
      return v;
    } finally {
      conn.release();
      schemaEnsurePromise = null;
    }
  })();

  return schemaEnsurePromise;
}

function isMissingSyncTableError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err).toLowerCase();
  return (
    code === 'ER_NO_SUCH_TABLE' ||
    code === 'ER_BAD_FIELD_ERROR' ||
    msg.includes("doesn't exist") ||
    msg.includes('unknown column')
  );
}

module.exports = { ensureSyncSchemaReady, isMissingSyncTableError };
