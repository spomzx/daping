-- Phase-5.1 Dashboard 慢查询索引（MySQL 5.7 / MariaDB 兼容，可重复执行）
-- staging: mysql -u root -p daping_staging < backend/db/indexes/dashboard-phase5-1.sql

DROP PROCEDURE IF EXISTS sp_dashboard_p51_ensure_indexes;

DELIMITER $$

CREATE PROCEDURE sp_dashboard_p51_ensure_indexes()
BEGIN
  DECLARE db_name VARCHAR(64);
  SET db_name = DATABASE();

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'orders'
        AND index_name = 'idx_orders_p51_tenant_status_market_shop_time') = 0 THEN
    CREATE INDEX idx_orders_p51_tenant_status_market_shop_time
      ON orders (tenant_id, order_status, market, shop_id, paid_at, created_at_platform, created_at);
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'orders'
        AND index_name = 'idx_orders_p51_tenant_event_time') = 0 THEN
    CREATE INDEX idx_orders_p51_tenant_event_time
      ON orders (tenant_id, paid_at, created_at_platform, created_at);
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'orders'
        AND index_name = 'idx_orders_p51_tenant_market_shop') = 0 THEN
    CREATE INDEX idx_orders_p51_tenant_market_shop
      ON orders (tenant_id, market, shop_id);
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'order_items'
        AND index_name = 'idx_order_items_p51_tenant_shop_market_order') = 0 THEN
    CREATE INDEX idx_order_items_p51_tenant_shop_market_order
      ON order_items (tenant_id, shop_id, market, platform_order_id);
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'order_items'
        AND index_name = 'idx_order_items_p51_tenant_product_sku') = 0 THEN
    CREATE INDEX idx_order_items_p51_tenant_product_sku
      ON order_items (tenant_id, product_id, sku_id);
  END IF;
END$$

DELIMITER ;

CALL sp_dashboard_p51_ensure_indexes();
DROP PROCEDURE IF EXISTS sp_dashboard_p51_ensure_indexes;
