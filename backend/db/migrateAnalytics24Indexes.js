'use strict';

/**
 * 2.4 分析层：orders / order_items 组合索引（可重复执行）
 */
async function migrateAnalytics24Indexes(conn) {
  const mod = async (sql) => {
    try {
      await conn.query(sql);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes('Duplicate key name') || msg.includes('check that column/key exists')) {
        return;
      }
      console.warn('[mysql] analytics 索引（可忽略）:', msg);
    }
  };

  await mod('CREATE INDEX `idx_orders_created_platform` ON `orders` (`created_at_platform`)');
  await mod('CREATE INDEX `idx_orders_shop_created` ON `orders` (`shop_id`, `created_at_platform`)');
  await mod('CREATE INDEX `idx_orders_total_amount` ON `orders` (`total_amount`)');

  await mod('CREATE INDEX `idx_order_items_shop_created` ON `order_items` (`shop_id`, `created_at_platform`)');
  await mod('CREATE INDEX `idx_order_items_product_sku` ON `order_items` (`product_id`, `sku_id`)');
  await mod(
    'CREATE INDEX `idx_order_items_name_sku` ON `order_items` (`product_name`(64), `sku_name`(64))',
  );
}

module.exports = { migrateAnalytics24Indexes };
