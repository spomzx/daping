'use strict';
/**
 * 用户 �?租户归属诊断（users / user_tenants / tenants / user_shop_permissions�? * 用法：node backend/scripts/diagnose-user-tenant-membership.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../', '.env') });

const { getMysqlPool } = require('../../db/mysqlPool');
const {
  countUsersForTenant,
  COUNT_MODE_PLATFORM_LIST,
  buildListUsersWhere,
} = require('../../lib/tenantUserMembership');
const { SQL_VIEWER_ROLES_IN } = require('../../lib/roles');

const DIAG_SQL = `
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
  (SELECT COUNT(*) FROM user_shop_permissions usp WHERE usp.user_id = u.id) AS shop_perm_count,
  (SELECT GROUP_CONCAT(DISTINCT s.tenant_id ORDER BY s.tenant_id)
   FROM user_shop_permissions usp
   INNER JOIN shops s ON s.id = usp.shop_id
   WHERE usp.user_id = u.id) AS shop_perm_tenant_ids
FROM users u
LEFT JOIN user_tenants ut ON ut.user_id = u.id
LEFT JOIN tenants t ON t.id = ut.tenant_id
ORDER BY u.username ASC, ut.tenant_id ASC
`;

async function platformListCount(pool) {
  const built = buildListUsersWhere(
    { role: 'super_admin', scope: 'platform', tenant_id: 1, user_id: 1 },
    {},
  );
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM users u
     INNER JOIN user_tenants ut ON ut.user_id = u.id
     INNER JOIN tenants t ON t.id = ut.tenant_id
     WHERE ${built.whereSql}`,
    built.params,
  );
  return Number(rows?.[0]?.c) || 0;
}

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL 不可用，请配�?DB_* 环境变量');
    process.exit(1);
  }

  const [tenantRows] = await pool.query(
    `SELECT id, tenant_code, tenant_name, max_users, current_users FROM tenants ORDER BY id`,
  );

  console.log('\n========== 1. 租户列表 ==========\n');
  console.table(tenantRows);

  console.log('\n========== 2. 用户归属明细（权威来源：user_tenants JOIN tenants�?=========\n');
  const [diag] = await pool.query(DIAG_SQL);
  console.table(diag);

  const orphans = diag.filter((r) => r.user_tenant_row_id == null);
  if (orphans.length) {
    console.log('\n�?�?user_tenants 记录的用户：');
    console.table(orphans.map((r) => ({ user_id: r.user_id, username: r.username, scope: r.scope })));
  }

  const multi = {};
  for (const r of diag) {
    if (!r.user_id) continue;
    multi[r.user_id] = (multi[r.user_id] || 0) + (r.user_tenant_row_id ? 1 : 0);
  }
  const multiTenant = Object.entries(multi).filter(([, n]) => n > 1);
  if (multiTenant.length) {
    console.log('\n�?多租户成员（/users 会出现多行，各租户分别计数）�?);
    for (const [uid] of multiTenant) {
      const rows = diag.filter((r) => String(r.user_id) === uid);
      console.log(rows.map((r) => `${r.username} �?${r.tenant_name} (${r.tenant_code}) role=${r.membership_role}`).join(' | '));
    }
  }

  console.log('\n========== 3. /users「客户」字段来�?==========');
  console.log('API: GET /api/users �?listUsersPaged');
  console.log('SQL: user_tenants.tenant_id + tenants.tenant_name / tenant_code（非 users.scope，非 display_name�?);

  console.log('\n========== 4. 各租�?current_users（platform_list，与平台 /users 同口径）==========\n');
  const perTenant = [];
  let sum = 0;
  for (const t of tenantRows) {
    const n = await countUsersForTenant(pool, t.id, COUNT_MODE_PLATFORM_LIST);
    sum += n;
    perTenant.push({
      tenant_id: t.id,
      tenant_code: t.tenant_code,
      tenant_name: t.tenant_name,
      count_platform_list: n,
      tenants_cache: t.current_users,
      max_users: t.max_users,
    });
  }
  console.table(perTenant);

  const listTotal = await platformListCount(pool);
  console.log(`各租�?count 之和: ${sum}（多租户用户会被重复加总）`);
  console.log(`平台 /users 列表行数（含多租户重复行�? ${listTotal}`);

  const [byTenantUsers] = await pool.query(
    `SELECT t.id, t.tenant_name, GROUP_CONCAT(u.username ORDER BY u.username) AS usernames
     FROM tenants t
     LEFT JOIN user_tenants ut ON ut.tenant_id = t.id
       AND ut.status NOT IN ('disabled','deleted')
       AND ut.role NOT IN (${SQL_VIEWER_ROLES_IN})
     LEFT JOIN users u ON u.id = ut.user_id AND u.status NOT IN ('disabled','deleted')
     GROUP BY t.id, t.tenant_name
     ORDER BY t.id`,
  );
  console.log('\n========== 5. 每租户应展示用户（platform_list�?=========\n');
  console.table(byTenantUsers);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
