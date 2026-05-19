'use strict';

/**
 * orders 列表查询索引（阶段四 · 可重复执行）
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateOrders33ListIndexes(conn) {
  try {
    await conn.query(
      `CREATE INDEX idx_orders_tenant_created_shop ON orders (tenant_id, created_at_platform, shop_id, market)`,
    );
  } catch (e) {
    if (!String(e?.message || '').includes('Duplicate')) {
      console.warn('[mysql] migrateOrders33ListIndexes:', e?.message || e);
    }
  }
}

module.exports = { migrateOrders33ListIndexes };
