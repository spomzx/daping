'use strict';

/**
 * Staging：清空 order_items；执行后立即校验 COUNT(*)=0。
 * 用法: cd /home/admin/daping-staging && node backend/scripts/truncateOrderItems.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mysql = require('mysql2/promise');
const { getMysqlConfig } = require('../config/database');

async function main() {
  const cfg = getMysqlConfig();
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: false,
  });
  try {
    await conn.query('TRUNCATE TABLE order_items');
    const [crows] = await conn.query('SELECT COUNT(*) AS c FROM order_items');
    const n = Number(crows[0]?.c);
    if (n !== 0) {
      throw new Error(`TRUNCATE 后 order_items 仍为 ${n} 行`);
    }
    console.log('[truncate-order-items] TRUNCATE 完成，校验 COUNT(*)=0 ✓');
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('[truncate-order-items]', e && e.message ? e.message : e);
  process.exit(1);
});
