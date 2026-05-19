'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });


const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const { getMysqlConfig } = require('../config/database');
const { runSeed } = require('./seed');
const { migrateShops21Columns } = require('./migrateShops21');
const { migrateShops22HealthColumns } = require('./migrateShops22Health');
const { migrateOrders231 } = require('./migrateOrders231');
const { migrateOrderItems233 } = require('./migrateOrderItems233');
const { migrateOrderItems233Fix } = require('./migrateOrderItems233Fix');
const { migrateAnalytics24Indexes } = require('./migrateAnalytics24Indexes');
const { migrateOrders25AnalyticsStatus } = require('./migrateOrders25AnalyticsStatus');
const { migrateStage4dRegistrationReview } = require('./migrateStage4dRegistrationReview');
const { migrateSaaSUserRoles26 } = require('./migrateSaaSUserRoles26');
const { migrateShops27OAuthColumns } = require('./migrateShops27OAuth');
const { migrateTenantMaxShops28 } = require('./migrateTenantMaxShops28');
const { migrateAllTenantsMaxShops20 } = require('./migrateAllTenantsMaxShops20');
const { migrateUsersScope29 } = require('./migrateUsersScope29');
const { migrateSaaS31Tables } = require('./migrateSaaS31Tables');
const { migrateSyncShopLogs32 } = require('./migrateSyncShopLogs32');
const { migrateOrders33ListIndexes } = require('./migrateOrders33ListIndexes');
const { migrateOrders35PlatformShopIdAudit } = require('./migrateOrders35PlatformShopIdAudit');
const { migrateTenantPlan36 } = require('./migrateTenantPlan36');
const { migrateTenantPlan37 } = require('./migrateTenantPlan37');
const { migrateFixPlatformScope38 } = require('./migrateFixPlatformScope38');
const { migrateTenantPlanType39 } = require('./migrateTenantPlanType39');
const { migrateFixUserTenantMembership40 } = require('./migrateFixUserTenantMembership40');

async function migrateShops21ColumnsAndIndex(conn) {
  await migrateShops21Columns(conn);
  const [ixRows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND INDEX_NAME = 'uk_shops_tenant_platform_shop'`,
  );
  const hasUk = Number(ixRows[0]?.c) > 0;
  if (hasUk) return;
  const [dup] = await conn.query(
    `SELECT tenant_id, platform, platform_shop_id, COUNT(*) AS n FROM shops
     GROUP BY tenant_id, platform, platform_shop_id HAVING n > 1 LIMIT 1`,
  );
  if (Array.isArray(dup) && dup.length > 0) {
    console.warn('[mysql] shops 存在重复键，跳过 uk_shops_tenant_platform_shop');
    return;
  }
  try {
    await conn.query(
      'ALTER TABLE shops ADD UNIQUE KEY `uk_shops_tenant_platform_shop` (`tenant_id`, `platform`, `platform_shop_id`)',
    );
  } catch (e) {
    console.warn('[mysql] 添加 shops 唯一索引失败（可忽略）:', e && e.message ? e.message : e);
  }
}

async function applySchema(connection) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await connection.query({ sql, multipleStatements: true });
}

/**
 * 建表 + 默认租户；可选 SEED_BOOTSTRAP_* 创建超管（可重复执行，不覆盖已有密码）。
 * @returns {Promise<void>}
 */
async function runMysqlMigrateAndSeed() {
  const cfg = getMysqlConfig();
  const connection = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: true,
  });
  let maxShopsMigrate;
  try {
    await applySchema(connection);
    await migrateShops21ColumnsAndIndex(connection);
    await migrateShops22HealthColumns(connection);
    await migrateOrders231(connection);
    await migrateOrderItems233(connection);
    await migrateOrderItems233Fix(connection);
    await migrateAnalytics24Indexes(connection);
    await migrateOrders25AnalyticsStatus(connection);
    await migrateStage4dRegistrationReview(connection);
    await migrateSaaSUserRoles26(connection);
    await migrateShops27OAuthColumns(connection);
    maxShopsMigrate = await migrateTenantMaxShops28(connection);
    const allTenantsMaxShops = await migrateAllTenantsMaxShops20(connection);
    console.log('[mysql] migrateAllTenantsMaxShops20', allTenantsMaxShops);
    const usersScope = await migrateUsersScope29(connection);
    console.log('[mysql] migrateUsersScope29', usersScope);
    await migrateSaaS31Tables(connection);
    console.log('[mysql] migrateSaaS31Tables ok');
    await migrateSyncShopLogs32(connection);
    console.log('[mysql] migrateSyncShopLogs32 ok');
    await migrateOrders33ListIndexes(connection);
    console.log('[mysql] migrateOrders33ListIndexes ok');
    const orders35 = await migrateOrders35PlatformShopIdAudit(connection);
    console.log('[mysql] migrateOrders35PlatformShopIdAudit', orders35);
    const tenantPlan36 = await migrateTenantPlan36(connection);
    console.log('[mysql] migrateTenantPlan36', tenantPlan36);
    const tenantPlan37 = await migrateTenantPlan37(connection);
    console.log('[mysql] migrateTenantPlan37', tenantPlan37);
    const fixPlatformScope = await migrateFixPlatformScope38(connection);
    console.log('[mysql] migrateFixPlatformScope38', fixPlatformScope);
    const tenantPlanType39 = await migrateTenantPlanType39(connection);
    console.log('[mysql] migrateTenantPlanType39', tenantPlanType39);
    const fixMembership40 = await migrateFixUserTenantMembership40(connection);
    console.log('[mysql] migrateFixUserTenantMembership40', fixMembership40);
    const ids = await runSeed(connection);
    return { ids, maxShopsMigrate, orders35 };
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  runMysqlMigrateAndSeed()
    .then((result) => {
      const ids = result?.ids ?? result;
      console.log('[mysql] init ok', {
        ...(typeof ids === 'object' && ids !== null ? ids : { ids }),
        maxShopsMigrate: result?.maxShopsMigrate,
        orders35: result?.orders35,
      });
      process.exit(0);
    })
    .catch((e) => {
      console.error('[mysql] init failed:', e && e.message ? e.message : e);
      process.exit(1);
    });
}

module.exports = { runMysqlMigrateAndSeed, applySchema };
