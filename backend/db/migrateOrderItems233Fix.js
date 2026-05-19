'use strict';

/**
 * 2.3.3 修复：order_items 关键列禁止 NULL（避免 UNIQUE 失效），quantity 默认 1。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateOrderItems233Fix(conn) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'`,
  );
  if (!rows.length || Number(rows[0].cnt) === 0) return;

  await conn.query(`UPDATE order_items SET platform_item_id = '' WHERE platform_item_id IS NULL`);
  await conn.query(`UPDATE order_items SET sku_id = '' WHERE sku_id IS NULL`);
  await conn.query(`UPDATE order_items SET product_id = '' WHERE product_id IS NULL`);
  await conn.query(`UPDATE order_items SET quantity = 1 WHERE quantity IS NULL OR quantity < 1`);

  const mod = async (sql) => {
    try {
      await conn.query(sql);
    } catch (e) {
      console.warn('[mysql] order_items alter (可忽略):', e && e.message ? e.message : e);
    }
  };

  await mod(
    'ALTER TABLE order_items MODIFY COLUMN platform_item_id VARCHAR(128) NOT NULL DEFAULT \'\'',
  );
  await mod('ALTER TABLE order_items MODIFY COLUMN sku_id VARCHAR(128) NOT NULL DEFAULT \'\'');
  await mod('ALTER TABLE order_items MODIFY COLUMN product_id VARCHAR(128) NOT NULL DEFAULT \'\'');
  await mod('ALTER TABLE order_items MODIFY COLUMN quantity INT NOT NULL DEFAULT 1');
}

module.exports = { migrateOrderItems233Fix };
