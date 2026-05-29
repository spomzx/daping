'use strict';

const { DEFAULT_TENANT_MAX_SHOPS } = require('../lib/tenantShopLimit');

/**
 * 将 default 租户及新注册默认上限对齐为 20（可重复执行）。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateTenantMaxShops28(conn) {
  const [r] = await conn.query(
    `UPDATE tenants SET max_shops = ? WHERE tenant_code = 'default'`,
    [DEFAULT_TENANT_MAX_SHOPS],
  );
  return { defaultTenantRows: r?.affectedRows ?? 0, max_shops: DEFAULT_TENANT_MAX_SHOPS };
}

module.exports = { migrateTenantMaxShops28 };
