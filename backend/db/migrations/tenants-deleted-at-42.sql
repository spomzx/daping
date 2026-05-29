-- Phase: 无管理员租户软删除（手工参考；推荐 node db/init.js 幂等迁移）
-- 仅 ALTER ADD COLUMN，不 DROP

-- ALTER TABLE tenants ADD COLUMN deleted_at DATETIME(3) NULL DEFAULT NULL COMMENT '软删除时间' AFTER updated_at;

-- 修复历史 orphaned / 无管理员（示例，以 migrateTenantsDeletedAt42.js 为准）
-- UPDATE tenants SET status='deleted', deleted_at=NOW(3), plan_remark='deleted because no active tenant admin', is_active=0 WHERE status='orphaned';
