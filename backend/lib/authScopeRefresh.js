'use strict';

const { getMysqlPool } = require('../db/mysqlPool');
const { normalizeUserScope } = require('./userScope');

/**
 * 以 DB users.scope 为准刷新 JWT 内 scope，避免旧 token 导致 platform/tenant 反转。
 * @param {{ user_id: number, scope?: string }} auth
 */
async function refreshAuthScopeFromDb(auth) {
  const pool = getMysqlPool();
  if (!pool || !auth?.user_id) return;
  try {
    const [rows] = await pool.query('SELECT scope FROM users WHERE id = ? LIMIT 1', [auth.user_id]);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.scope != null) {
      auth.scope = normalizeUserScope(row.scope);
    }
  } catch (e) {
    console.warn('[authScopeRefresh] failed:', e?.message || e);
  }
}

module.exports = { refreshAuthScopeFromDb };
