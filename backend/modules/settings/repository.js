'use strict';

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number|null} tenantId
 */
async function listSettings(pool, tenantId) {
  const params = [];
  let clause = '';
  if (tenantId != null && Number.isFinite(tenantId)) {
    clause = ' WHERE tenant_id = ? OR tenant_id IS NULL';
    params.push(tenantId);
  }
  try {
    const [rows] = await pool.query(
      `SELECT id, tenant_id, setting_key, setting_value, value_type, updated_at
       FROM system_settings${clause}
       ORDER BY tenant_id IS NULL DESC, setting_key ASC`,
      params,
    );
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || String(e.message || '').includes('system_settings'))) {
      return [];
    }
    throw e;
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 */
async function listExchangeRates(pool) {
  try {
    const [rows] = await pool.query(
      `SELECT id, base_currency, target_currency, rate, source, effective_at, updated_at
       FROM exchange_rates
       ORDER BY base_currency ASC, target_currency ASC, effective_at DESC`,
    );
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || String(e.message || '').includes('exchange_rates'))) {
      return [];
    }
    throw e;
  }
}

module.exports = { listSettings, listExchangeRates };
