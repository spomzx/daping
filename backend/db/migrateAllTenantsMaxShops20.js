'use strict';

const { DEFAULT_TENANT_MAX_SHOPS } = require('../lib/tenantShopLimit');

/**
 * 全租户 max_shops 下限对齐为 20（可重复执行；不降低已大于 20 的额度）。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateAllTenantsMaxShops20(conn) {
  const [r] = await conn.query(
    `UPDATE tenants SET max_shops = ? WHERE max_shops IS NULL OR max_shops < ?`,
    [DEFAULT_TENANT_MAX_SHOPS, DEFAULT_TENANT_MAX_SHOPS],
  );
  const updatedRows = r?.affectedRows ?? 0;
  return { updatedRows, max_shops: DEFAULT_TENANT_MAX_SHOPS };
}

module.exports = { migrateAllTenantsMaxShops20 };
