'use strict';

/**
 * 输出当前 MySQL 驱动下的真实 OpenAPI 同步店铺列表
 * node backend/scripts/auditSyncShops.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const {
  getOpenApiShopsSource,
  readSyncShopsFromMysql,
  buildOpenApiSyncShopListLog,
  DB_SCHEMA_DOC,
  CAVERA_PLATFORM_SHOP_ID,
} = require('../lib/readSyncShops');

async function main() {
  console.log('=== DB SCHEMA (sync) ===');
  console.log(JSON.stringify(DB_SCHEMA_DOC, null, 2));
  console.log('OPENAPI_SHOPS_SOURCE=', getOpenApiShopsSource());

  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL unavailable');
    process.exit(1);
  }

  const shops = await readSyncShopsFromMysql(pool);
  console.log('\n=== ELIGIBLE SYNC SHOPS ===');
  console.log(JSON.stringify(buildOpenApiSyncShopListLog(shops), null, 2));

  const cavera = shops.find((s) => String(s.platform_shop_id) === CAVERA_PLATFORM_SHOP_ID);
  console.log('\n=== CAVERA ===');
  console.log(JSON.stringify(cavera || { found: false, note: 'not in sync list — check sync_enabled/token/cipher' }, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
