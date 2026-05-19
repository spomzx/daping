-- 用户 ↔ 租户归属诊断（在业务库执行）
-- 权威归属：user_tenants + tenants；/users「客户」列同此来源

SET NAMES utf8mb4;

-- 1) 每用户每行成员关系（含无归属用户）
SELECT
  u.id AS user_id,
  u.username,
  u.scope,
  u.status AS user_status,
  ut.id AS user_tenant_row_id,
  ut.tenant_id,
  t.tenant_code,
  t.tenant_name,
  ut.role AS membership_role,
  ut.status AS membership_status,
  'user_tenants' AS source_table,
  (SELECT COUNT(*) FROM user_shop_permissions usp WHERE usp.user_id = u.id) AS shop_perm_count
FROM users u
LEFT JOIN user_tenants ut ON ut.user_id = u.id
LEFT JOIN tenants t ON t.id = ut.tenant_id
ORDER BY u.username ASC, ut.tenant_id ASC;

-- 2) 各租户 platform_list 口径用户数（与 /tenants 展示、平台 /users 列表一致）
SELECT
  t.id AS tenant_id,
  t.tenant_code,
  t.tenant_name,
  t.max_users,
  t.current_users AS cache_current_users,
  COUNT(DISTINCT u.id) AS count_platform_list
FROM tenants t
LEFT JOIN user_tenants ut ON ut.tenant_id = t.id
  AND ut.status NOT IN ('disabled', 'deleted')
  AND ut.role NOT IN ('viewer', 'tenant_viewer')
LEFT JOIN users u ON u.id = ut.user_id
  AND u.status NOT IN ('disabled', 'deleted')
GROUP BY t.id, t.tenant_code, t.tenant_name, t.max_users, t.current_users
ORDER BY t.id;

-- 3) 每租户下用户名（platform_list）
SELECT
  t.tenant_name,
  t.tenant_code,
  GROUP_CONCAT(u.username ORDER BY u.username) AS usernames
FROM tenants t
LEFT JOIN user_tenants ut ON ut.tenant_id = t.id
  AND ut.status NOT IN ('disabled', 'deleted')
  AND ut.role NOT IN ('viewer', 'tenant_viewer')
LEFT JOIN users u ON u.id = ut.user_id AND u.status NOT IN ('disabled', 'deleted')
GROUP BY t.id, t.tenant_name, t.tenant_code
ORDER BY t.id;

-- 4) 多租户成员（会导致 /users 多行、各租户分别 +1）
SELECT u.username, COUNT(DISTINCT ut.tenant_id) AS tenant_count
FROM users u
INNER JOIN user_tenants ut ON ut.user_id = u.id
WHERE ut.status NOT IN ('disabled', 'deleted')
GROUP BY u.id, u.username
HAVING tenant_count > 1;

-- 5) user_shop_permissions 仅影响店铺分配，不决定「客户」列
SELECT
  u.username,
  usp.shop_id,
  s.shop_name,
  s.tenant_id AS shop_tenant_id,
  t.tenant_name AS shop_tenant_name
FROM user_shop_permissions usp
INNER JOIN users u ON u.id = usp.user_id
INNER JOIN shops s ON s.id = usp.shop_id
LEFT JOIN tenants t ON t.id = s.tenant_id
ORDER BY u.username;
