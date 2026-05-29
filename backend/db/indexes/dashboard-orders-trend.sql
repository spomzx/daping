-- Dashboard contract 查询性能（仅新增索引，不改表结构）
-- 执行前请确认库名；staging 可手工执行

-- 订单时间窗 + 租户（trend / gmv-compare / orders）
CREATE INDEX IF NOT EXISTS idx_orders_tenant_event_time
  ON orders (tenant_id, paid_at, created_at_platform, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_tenant_market_shop
  ON orders (tenant_id, market, shop_id);

-- order_items 关联排行
CREATE INDEX IF NOT EXISTS idx_order_items_tenant_platform_order
  ON order_items (tenant_id, platform, platform_order_id);
