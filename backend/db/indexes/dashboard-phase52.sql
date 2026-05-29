-- Phase-5.2 Dashboard paid 场景慢查询索引（MySQL 5.7 / MariaDB 兼容，可重复执行）
-- staging: mysql -u root -p daping_staging < backend/db/indexes/dashboard-phase52.sql

DROP PROCEDURE IF EXISTS sp_dashboard_p52_ensure_indexes;

DELIMITER $$

CREATE PROCEDURE sp_dashboard_p52_ensure_indexes()
BEGIN
  DECLARE db_name VARCHAR(64);
  SET db_name = DATABASE();

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'orders'
        AND index_name = 'idx_orders_p52_tenant_created_sort') = 0 THEN
    CREATE INDEX idx_orders_p52_tenant_created_sort
      ON orders (tenant_id, created_at_platform, paid_at, created_at, platform_order_id);
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'orders'
        AND index_name = 'idx_orders_p52_tenant_shop_event') = 0 THEN
    CREATE INDEX idx_orders_p52_tenant_shop_event
      ON orders (tenant_id, shop_id, paid_at, created_at_platform, created_at);
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'orders'
        AND index_name = 'idx_orders_p52_tenant_status_event') = 0 THEN
    CREATE INDEX idx_orders_p52_tenant_status_event
      ON orders (tenant_id, order_status, paid_at, created_at_platform, created_at);
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'order_items'
        AND index_name = 'idx_order_items_p52_tenant_platform_order') = 0 THEN
    CREATE INDEX idx_order_items_p52_tenant_platform_order
      ON order_items (tenant_id, platform, platform_order_id);
  END IF;

  IF (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = db_name AND table_name = 'order_items'
        AND index_name = 'idx_order_items_p52_tenant_product_order') = 0 THEN
    CREATE INDEX idx_order_items_p52_tenant_product_order
      ON order_items (tenant_id, product_id, sku_id, platform, platform_order_id);
  END IF;
END$$

DELIMITER ;

CALL sp_dashboard_p52_ensure_indexes();
DROP PROCEDURE IF EXISTS sp_dashboard_p52_ensure_indexes;
