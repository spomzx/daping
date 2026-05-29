-- Phase-4.1 同步队列化（staging 执行：node db/init.js 或 migrateSyncStability41）
-- 回滚见 docs/sync-stability-rollback.md

-- 旧版 sync_jobs（无 shop_id）若存在则归档
-- RENAME TABLE sync_jobs TO sync_jobs_legacy_v0;  -- 由 migrateSyncStability41.js 按列检测执行

CREATE TABLE IF NOT EXISTS `sync_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `shop_id` BIGINT UNSIGNED NOT NULL,
  `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
  `job_type` VARCHAR(64) NOT NULL DEFAULT 'shop_orders',
  `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `priority` INT NOT NULL DEFAULT 100,
  `attempt_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` INT UNSIGNED NOT NULL DEFAULT 5,
  `locked_by` VARCHAR(128) NULL DEFAULT NULL,
  `locked_at` DATETIME(3) NULL DEFAULT NULL,
  `started_at` DATETIME(3) NULL DEFAULT NULL,
  `finished_at` DATETIME(3) NULL DEFAULT NULL,
  `next_retry_at` DATETIME(3) NULL DEFAULT NULL,
  `error_message` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_sync_jobs_tenant_status` (`tenant_id`, `status`),
  KEY `idx_sync_jobs_shop_status` (`shop_id`, `status`),
  KEY `idx_sync_jobs_platform_status` (`platform`, `status`),
  KEY `idx_sync_jobs_next_retry` (`next_retry_at`),
  KEY `idx_sync_jobs_tenant_shop_active` (`tenant_id`, `shop_id`, `platform`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sync_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `shop_id` BIGINT UNSIGNED NOT NULL,
  `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
  `sync_job_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `level` VARCHAR(16) NOT NULL DEFAULT 'info',
  `message` VARCHAR(512) NOT NULL,
  `context_json` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_sync_logs_shop_created` (`shop_id`, `created_at`),
  KEY `idx_sync_logs_job` (`sync_job_id`),
  KEY `idx_sync_logs_tenant_created` (`tenant_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `shop_sync_status` (
  `shop_id` BIGINT UNSIGNED NOT NULL,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
  `sync_status` VARCHAR(32) NOT NULL DEFAULT 'idle',
  `last_sync_at` DATETIME(3) NULL DEFAULT NULL,
  `last_success_sync_at` DATETIME(3) NULL DEFAULT NULL,
  `last_error` TEXT NULL,
  `last_error_code` VARCHAR(64) NULL DEFAULT NULL,
  `sync_fail_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_token_valid` TINYINT(1) NOT NULL DEFAULT 1,
  `token_expired_at` DATETIME(3) NULL DEFAULT NULL,
  `current_job_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `sync_lock_until` DATETIME(3) NULL DEFAULT NULL,
  `avg_sync_ms` INT UNSIGNED NULL DEFAULT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`shop_id`, `platform`),
  KEY `idx_shop_sync_status_tenant` (`tenant_id`, `sync_status`),
  KEY `idx_shop_sync_status_lock` (`sync_lock_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
