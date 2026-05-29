'use strict';

/**
 * Dashboard MySQL 查询组合索引（可重复执行）
 * 覆盖 tenant + 时间 + market/shop 筛选及 order_items 关联 join
 */
async function migrateDashboardPerf43(conn) {
  const mod = async (sql) => {
    try {
      await conn.query(sql);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes('Duplicate key name') || msg.includes('check that column/key exists')) {
        return;
      }
      console.warn('[mysql] dashboard perf 索引（可忽略）:', msg);
    }
  };

  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_paid` ON `orders` (`tenant_id`, `paid_at`, `market`, `shop_id`)',
  );
  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_created` ON `orders` (`tenant_id`, `created_at_platform`, `market`, `shop_id`)',
  );
  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_status` ON `orders` (`tenant_id`, `order_status`, `created_at_platform`)',
  );
  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_astatus_paid` ON `orders` (`tenant_id`, `analytics_status`, `paid_at`)',
  );
  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_astatus_created` ON `orders` (`tenant_id`, `analytics_status`, `created_at_platform`)',
  );
  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_shop_astatus_paid` ON `orders` (`tenant_id`, `shop_id`, `analytics_status`, `paid_at`)',
  );
  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_market_astatus_paid` ON `orders` (`tenant_id`, `market`, `analytics_status`, `paid_at`)',
  );
  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_shop_status_paid` ON `orders` (`tenant_id`, `shop_id`, `order_status`, `paid_at`)',
  );
  await mod(
    'CREATE INDEX `idx_orders_dash_tenant_market_status_paid` ON `orders` (`tenant_id`, `market`, `order_status`, `paid_at`)',
  );
  await mod(
    'CREATE INDEX `idx_order_items_tenant_platform_order` ON `order_items` (`tenant_id`, `platform`, `platform_order_id`)',
  );
  await mod(
    'CREATE INDEX `idx_order_items_tenant_order_id` ON `order_items` (`tenant_id`, `order_id`)',
  );
}

module.exports = { migrateDashboardPerf43 };
