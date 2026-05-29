'use strict';

/**
 * 从 MySQL orders 重建 orders-cache.json（非主统计源，仅 cache/reconcile）
 * node backend/scripts/rebuildOrdersCacheFromMysql.js [--tenant_id=1]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { rebuildOrdersCacheFromMysql } = require('../modules/orders/orderCacheRebuildService');
const { getDashboardTenantId } = require('../lib/dashboardShopGate');

function parseTenantId() {
  for (const a of process.argv.slice(2)) {
    const m = /^--tenant_id=(\d+)$/.exec(a);
    if (m) return Number(m[1]);
  }
  return getDashboardTenantId();
}

async function main() {
  if (!getMysqlPool()) {
    console.error('MySQL unavailable');
    process.exit(1);
  }
  const tenantId = parseTenantId();
  const result = await rebuildOrdersCacheFromMysql(tenantId, {
    scope: 'tenant_admin',
    tenant_id: tenantId,
    role: 'tenant_admin',
  });
  console.log('[rebuild-cache]', JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
