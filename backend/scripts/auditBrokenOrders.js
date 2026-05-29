'use strict';

/**
 * 审计 orders 映射异常
 * node backend/scripts/auditBrokenOrders.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL unavailable');
    process.exit(1);
  }

  const queries = {
    no_shop_id: `SELECT COUNT(*) AS c FROM orders WHERE shop_id IS NULL`,
    no_tenant_id: `SELECT COUNT(*) AS c FROM orders WHERE tenant_id IS NULL`,
    shop_id_not_in_shops: `
      SELECT COUNT(*) AS c FROM orders o
      LEFT JOIN shops s ON s.id = o.shop_id
      WHERE o.shop_id IS NOT NULL AND s.id IS NULL`,
    shop_id_looks_like_platform_id: `
      SELECT COUNT(*) AS c FROM orders o
      INNER JOIN shops s ON LOWER(TRIM(s.platform_shop_id)) = LOWER(TRIM(CAST(o.shop_id AS CHAR)))
      WHERE o.shop_id <> s.id`,
    missing_platform_shop_id_column: `
      SELECT COUNT(*) AS c FROM orders
      WHERE platform_shop_id IS NULL OR TRIM(platform_shop_id) = ''`,
  };

  const out = {};
  for (const [key, sql] of Object.entries(queries)) {
    try {
      const [rows] = await pool.query(sql);
      out[key] = rows[0]?.c ?? rows[0];
    } catch (e) {
      out[key] = { error: e.message };
    }
  }

  console.log('=== AUDIT BROKEN ORDERS ===');
  console.log(JSON.stringify(out, null, 2));

  const [sample] = await pool.query(`
    SELECT o.id, o.tenant_id, o.shop_id, o.platform_shop_id, o.platform_order_id,
           o.shop_name, o.market, s.platform_shop_id AS shops_platform_id, s.shop_name AS shops_name
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE o.shop_id IS NULL
       OR s.id IS NULL
       OR (o.platform_shop_id IS NOT NULL AND LOWER(TRIM(o.platform_shop_id)) <> LOWER(TRIM(s.platform_shop_id)))
    LIMIT 30
  `);
  console.log('\n=== SAMPLE (max 30) ===');
  console.log(JSON.stringify(sample, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
