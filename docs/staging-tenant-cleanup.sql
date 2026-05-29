-- staging 租户脏数据审计 / 清理（仅手工执行，禁止自动删除）
-- 用途：同一 platform_shop_id 跨 tenant 重复时，确认 tenant_id=1 为历史脏数据后再删

-- 1) 跨 tenant 重复的 platform_shop_id（全局）
SELECT
  LOWER(TRIM(platform_shop_id)) AS platform_shop_id_norm,
  COUNT(*) AS row_count,
  GROUP_CONCAT(CONCAT('tenant=', tenant_id, ',shop_id=', id) ORDER BY tenant_id, id SEPARATOR ' | ') AS shops
FROM shops
WHERE TRIM(COALESCE(platform_shop_id, '')) <> ''
  AND status <> 'deleted'
GROUP BY LOWER(TRIM(platform_shop_id))
HAVING COUNT(*) > 1
ORDER BY row_count DESC;

-- 2) 指定 platform_shop_id 明细（示例：CQ Chic Thailand）
SELECT id, tenant_id, platform, platform_shop_id, shop_name, market, status, sync_enabled, last_sync_at
FROM shops
WHERE LOWER(TRIM(platform_shop_id)) = LOWER(TRIM('8648040114093262679'))
ORDER BY tenant_id, id;

-- 3) 仅 tenant_id=1 的 shops（staging 脏数据候选）
SELECT id, tenant_id, platform_shop_id, shop_name, status, created_at
FROM shops
WHERE tenant_id = 1
ORDER BY id;

-- 4) tenant_id=1 关联 token（删除 shop 前先看）
SELECT t.id, t.tenant_id, t.shop_id, s.platform_shop_id,
       (CASE WHEN t.access_token IS NOT NULL AND TRIM(t.access_token) <> '' THEN 1 ELSE 0 END) AS has_token
FROM shop_auth_tokens t
INNER JOIN shops s ON s.id = t.shop_id AND s.tenant_id = t.tenant_id
WHERE t.tenant_id = 1;

-- 5) 订单 tenant 与 shops 不一致（同步修复后应归零；也可手工一次性纠正）
SELECT o.id, o.tenant_id AS order_tenant, s.tenant_id AS shop_tenant, o.shop_id, o.platform_order_id
FROM orders o
INNER JOIN shops s ON s.id = o.shop_id
WHERE o.tenant_id <> s.tenant_id
LIMIT 50;

-- UPDATE orders o
-- INNER JOIN shops s ON s.id = o.shop_id
-- SET o.tenant_id = s.tenant_id
-- WHERE o.tenant_id <> s.tenant_id;

-- 6) 同步后验收
-- SELECT tenant_id, COUNT(*) FROM orders GROUP BY tenant_id;

-- ========== 以下 DELETE 仅在你确认 tenant_id=1 为脏数据后手工执行 ==========

-- DELETE FROM shop_auth_tokens WHERE tenant_id = 1;
-- DELETE FROM sync_shop_logs WHERE tenant_id = 1;
-- DELETE FROM orders WHERE tenant_id = 1;
-- DELETE FROM shops WHERE tenant_id = 1;
