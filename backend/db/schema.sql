-- GMV 大屏 2.0 业务库（MySQL）。可重复执行: node backend/db/init.js

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `tenants` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_code` VARCHAR(64) NOT NULL,
  `tenant_name` VARCHAR(255) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `plan_type` VARCHAR(64) NULL DEFAULT NULL,
  `timezone` VARCHAR(64) NULL DEFAULT 'UTC',
  `base_currency` VARCHAR(8) NOT NULL DEFAULT 'USD',
  `max_shops` INT UNSIGNED NOT NULL DEFAULT 20,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tenants_code` (`tenant_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(128) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `display_name` VARCHAR(255) NULL DEFAULT NULL,
  `email` VARCHAR(255) NULL DEFAULT NULL,
  `phone` VARCHAR(64) NULL DEFAULT NULL,
  `contact` VARCHAR(512) NULL DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `scope` VARCHAR(16) NOT NULL DEFAULT 'tenant' COMMENT 'tenant=单租户; platform=全平台运维',
  `last_login_at` DATETIME(3) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_tenants` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `role` VARCHAR(32) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_tenant` (`user_id`, `tenant_id`),
  KEY `idx_user_tenants_tenant` (`tenant_id`),
  CONSTRAINT `fk_user_tenants_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_user_tenants_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 子账号店铺可见范围（预留，当前阶段不接入业务逻辑）
CREATE TABLE IF NOT EXISTS `user_shop_permissions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `shop_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_shop` (`user_id`, `shop_id`),
  KEY `idx_usp_shop` (`shop_id`),
  CONSTRAINT `fk_usp_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_usp_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `shops` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
  `platform_shop_id` VARCHAR(128) NOT NULL,
  `shop_name` VARCHAR(255) NOT NULL,
  `display_name` VARCHAR(255) NULL DEFAULT NULL,
  `market` VARCHAR(32) NULL DEFAULT NULL,
  `region` VARCHAR(32) NULL DEFAULT NULL,
  `currency` VARCHAR(8) NULL DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `hidden` TINYINT(1) NOT NULL DEFAULT 0,
  `sync_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `remarks` TEXT NULL,
  `imported_from_cache` TINYINT(1) NOT NULL DEFAULT 0,
  `last_cache_sync_at` DATETIME(3) NULL DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `auth_status` VARCHAR(64) NULL DEFAULT NULL,
  `last_sync_at` DATETIME(3) NULL DEFAULT NULL,
  `last_order_seen_at` DATETIME(3) NULL DEFAULT NULL,
  `last_order_count` INT NOT NULL DEFAULT 0,
  `last_gmv_amount` DECIMAL(18,4) NOT NULL DEFAULT 0,
  `last_health_status` VARCHAR(32) NOT NULL DEFAULT 'unknown',
  `last_health_message` TEXT NULL,
  `last_health_checked_at` DATETIME(3) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_shops_tenant` (`tenant_id`),
  KEY `idx_shops_tenant_sort` (`tenant_id`, `sort_order`, `id`),
  UNIQUE KEY `uk_shops_tenant_platform_shop` (`tenant_id`, `platform`, `platform_shop_id`),
  CONSTRAINT `fk_shops_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `shop_auth_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `shop_id` BIGINT UNSIGNED NOT NULL,
  `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
  `access_token` TEXT NULL,
  `refresh_token` TEXT NULL,
  `token_expire_at` DATETIME(3) NULL DEFAULT NULL,
  `refresh_token_expire_at` DATETIME(3) NULL DEFAULT NULL,
  `scope_json` JSON NULL,
  `raw_auth_json` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_shop_auth_tenant_shop` (`tenant_id`, `shop_id`),
  CONSTRAINT `fk_shop_auth_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_shop_auth_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `operation_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `action` VARCHAR(64) NOT NULL,
  `module` VARCHAR(64) NOT NULL,
  `target_type` VARCHAR(64) NULL DEFAULT NULL,
  `target_id` VARCHAR(128) NULL DEFAULT NULL,
  `ip` VARCHAR(64) NULL DEFAULT NULL,
  `user_agent` VARCHAR(512) NULL DEFAULT NULL,
  `detail_json` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_oplog_tenant_created` (`tenant_id`, `created_at`),
  KEY `idx_oplog_module_action` (`module`, `action`),
  KEY `idx_oplog_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sync_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `job_type` VARCHAR(64) NULL DEFAULT NULL,
  `status` VARCHAR(32) NULL DEFAULT 'pending',
  `payload_json` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `plans` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_code` VARCHAR(64) NOT NULL,
  `plan_name` VARCHAR(255) NULL DEFAULT NULL,
  `metadata_json` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_plans_code` (`plan_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tenant_subscriptions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `plan_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `status` VARCHAR(32) NULL DEFAULT 'inactive',
  `started_at` DATETIME(3) NULL DEFAULT NULL,
  `ended_at` DATETIME(3) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_tsub_tenant` (`tenant_id`),
  CONSTRAINT `fk_tsub_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_tsub_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `billing_accounts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `external_ref` VARCHAR(128) NULL DEFAULT NULL,
  `metadata_json` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_billing_tenant` (`tenant_id`),
  CONSTRAINT `fk_billing_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2.3.1 订单（主数据：OpenAPI 同步写入；大屏默认读 MySQL，见 DASHBOARD_DATA_SOURCE）
-- analytics_status：入库时由 orderFilter.deriveAnalyticsStatusFromOrder 写入；Analytics 只按列筛选，不在 SQL 中解析 raw_json。
CREATE TABLE IF NOT EXISTS `orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `shop_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `platform_shop_id` VARCHAR(128) NULL DEFAULT NULL COMMENT 'TikTok platform shop id; orders.shop_id = shops.id',
  `platform` VARCHAR(32) NOT NULL,
  `platform_order_id` VARCHAR(128) NOT NULL,
  `shop_name` VARCHAR(255) NULL DEFAULT NULL,
  `market` VARCHAR(32) NULL DEFAULT NULL,
  `currency` VARCHAR(16) NULL DEFAULT NULL,
  `buyer_name` VARCHAR(255) NULL DEFAULT NULL,
  `order_status` VARCHAR(64) NULL DEFAULT NULL,
  `analytics_status` VARCHAR(20) NULL DEFAULT NULL,
  `total_amount` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `created_at_platform` DATETIME(3) NULL DEFAULT NULL,
  `paid_at` DATETIME(3) NULL DEFAULT NULL,
  `raw_json` LONGTEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_orders_platform_order` (`platform`, `platform_order_id`),
  KEY `idx_orders_shop` (`shop_id`),
  KEY `idx_orders_platform_shop` (`platform_shop_id`),
  KEY `idx_orders_created` (`created_at_platform`),
  KEY `idx_orders_market` (`market`),
  KEY `idx_orders_tenant` (`tenant_id`),
  KEY `idx_analytics` (`tenant_id`, `analytics_status`, `created_at_platform`, `market`, `shop_id`),
  CONSTRAINT `fk_orders_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_orders_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2.3.3 订单商品行（主数据；与 orders 同步写入）
CREATE TABLE IF NOT EXISTS `order_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `order_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `platform` VARCHAR(32) NOT NULL,
  `platform_order_id` VARCHAR(128) NOT NULL,
  `platform_item_id` VARCHAR(128) NOT NULL DEFAULT '',
  `shop_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `shop_name` VARCHAR(255) NULL DEFAULT NULL,
  `market` VARCHAR(32) NULL DEFAULT NULL,
  `product_id` VARCHAR(128) NOT NULL DEFAULT '',
  `sku_id` VARCHAR(128) NOT NULL DEFAULT '',
  `sku_name` VARCHAR(255) NULL DEFAULT NULL,
  `product_name` VARCHAR(512) NULL DEFAULT NULL,
  `product_image` VARCHAR(1024) NULL DEFAULT NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `currency` VARCHAR(16) NULL DEFAULT NULL,
  `unit_price` DECIMAL(18,4) NOT NULL DEFAULT 0,
  `total_amount` DECIMAL(18,4) NOT NULL DEFAULT 0,
  `raw_json` LONGTEXT NULL,
  `created_at_platform` DATETIME(3) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_items_unique` (`platform`, `platform_order_id`, `platform_item_id`, `sku_id`, `product_id`),
  KEY `idx_order_items_order` (`order_id`),
  KEY `idx_order_items_shop` (`shop_id`),
  KEY `idx_order_items_product` (`product_id`),
  KEY `idx_order_items_sku` (`sku_id`),
  KEY `idx_order_items_market` (`market`),
  KEY `idx_order_items_created` (`created_at_platform`),
  CONSTRAINT `fk_order_items_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_order_items_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sync_shop_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `shop_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `platform_shop_id` VARCHAR(128) NULL DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'ok',
  `message` TEXT NULL,
  `orders_fetched` INT NOT NULL DEFAULT 0,
  `started_at` DATETIME(3) NULL DEFAULT NULL,
  `finished_at` DATETIME(3) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_sync_shop_logs_tenant` (`tenant_id`, `created_at`),
  KEY `idx_sync_shop_logs_shop` (`shop_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `system_settings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `setting_key` VARCHAR(128) NOT NULL,
  `setting_value` TEXT NULL,
  `value_type` VARCHAR(32) NOT NULL DEFAULT 'string',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_settings_tenant_key` (`tenant_id`, `setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `exchange_rates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `base_currency` VARCHAR(8) NOT NULL,
  `target_currency` VARCHAR(8) NOT NULL,
  `rate` DECIMAL(18,8) NOT NULL,
  `source` VARCHAR(64) NULL DEFAULT NULL,
  `effective_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_exchange_pair` (`base_currency`, `target_currency`, `effective_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `roles` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `role_code` VARCHAR(64) NOT NULL,
  `role_name` VARCHAR(128) NOT NULL,
  `description` VARCHAR(512) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_roles_code` (`role_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `permissions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `permission_code` VARCHAR(128) NOT NULL,
  `permission_name` VARCHAR(255) NOT NULL,
  `module` VARCHAR(64) NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_permissions_code` (`permission_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
