'use strict';
/**
 * 按用户名修正 user_tenants 租户归属（幂等，可重复执行）
 * 用法：node backend/scripts/fix-user-tenant-membership.js
 * 环境变量 DRY_RUN=1 仅预览不写库
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { syncCurrentUsersCache } = require('../modules/tenants/planService');
const { countUsersForTenant, COUNT_MODE_PLATFORM_LIST } = require('../lib/tenantUserMembership');

/** username -> 匹配 tenants.tenant_name 或 tenant_code */
const TARGET_BY_USERNAME = {
  admin: { tenant_code: 'default' },
  spomzx: { tenant_code: 'default' },
  cqchic: { tenant_name: '自用' },
  test01: { tenant_name: '测试账户' },
  test02: { tenant_name: '测试公司2' },
};

async function resolveTenant(conn, spec) {
  if (spec.tenant_code) {
    const [[r]] = await conn.query(`SELECT id, tenant_code, tenant_name FROM tenants WHERE tenant_code = ? LIMIT 1`, [
      spec.tenant_code,
    ]);
    return r || null;
  }
  if (spec.tenant_name) {
    const [[r]] = await conn.query(`SELECT id, tenant_code, tenant_name FROM tenants WHERE tenant_name = ? LIMIT 1`, [
      spec.tenant_name,
    ]);
    return r || null;
  }
  return null;
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL 不可用');
    process.exit(1);
  }

  const conn = await pool.getConnection();
  const changes = [];

  try {
    for (const [username, spec] of Object.entries(TARGET_BY_USERNAME)) {
      const tenant = await resolveTenant(conn, spec);
      if (!tenant) {
        console.warn(`[skip] 未找到租户: ${JSON.stringify(spec)} (用户 ${username})`);
        continue;
      }

      const [[user]] = await conn.query(`SELECT id, username, scope FROM users WHERE username = ? LIMIT 1`, [username]);
      if (!user) {
        console.warn(`[skip] 用户不存在: ${username}`);
        continue;
      }

      const [memberships] = await conn.query(
        `SELECT ut.id, ut.tenant_id, ut.role, ut.status, t.tenant_name
         FROM user_tenants ut
         LEFT JOIN tenants t ON t.id = ut.tenant_id
         WHERE ut.user_id = ?`,
        [user.id],
      );

      const wrong = memberships.filter((m) => Number(m.tenant_id) !== Number(tenant.id));
      const hasCorrect = memberships.some((m) => Number(m.tenant_id) === Number(tenant.id));

      if (username === 'cqchic' && String(user.scope) === 'platform') {
        if (!dryRun) {
          await conn.execute(`UPDATE users SET scope = 'tenant' WHERE id = ?`, [user.id]);
        }
        changes.push({ username, action: 'scope tenant', user_id: user.id });
      }

      if ((username === 'admin' || username === 'spomzx') && String(user.scope) !== 'platform') {
        if (!dryRun) {
          await conn.execute(`UPDATE users SET scope = 'platform' WHERE id = ?`, [user.id]);
        }
        changes.push({ username, action: 'scope platform', user_id: user.id });
      }

      for (const m of wrong) {
        if (!dryRun) {
          await conn.execute(`DELETE FROM user_tenants WHERE id = ?`, [m.id]);
        }
        changes.push({
          username,
          action: 'delete wrong membership',
          from_tenant: m.tenant_name,
          from_tenant_id: m.tenant_id,
        });
      }

      if (!hasCorrect) {
        const role =
          username === 'admin' || username === 'spomzx'
            ? 'super_admin'
            : memberships.find((m) => m.role)?.role || 'admin';
        if (!dryRun) {
          await conn.execute(
            `INSERT INTO user_tenants (user_id, tenant_id, role, status) VALUES (?, ?, ?, 'active')
             ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active'`,
            [user.id, tenant.id, role],
          );
        }
        changes.push({
          username,
          action: 'upsert membership',
          to_tenant: tenant.tenant_name,
          to_tenant_id: tenant.id,
          role,
        });
      } else if (wrong.length === 0) {
        console.log(`[ok] ${username} 已在 ${tenant.tenant_name} (${tenant.tenant_code})`);
      }
    }

    if (dryRun) {
      console.log('\n[DRY_RUN] 预览变更：');
    } else {
      const [allTenants] = await conn.query(`SELECT id FROM tenants`);
      for (const t of allTenants) {
        await syncCurrentUsersCache(pool, Number(t.id));
      }
    }

    console.table(changes);

    const [summary] = await conn.query(
      `SELECT t.id, t.tenant_name, t.tenant_code, t.max_users
       FROM tenants t ORDER BY t.id`,
    );
    console.log('\n修正后各租户用户数（platform_list）：');
    for (const t of summary) {
      const n = await countUsersForTenant(pool, t.id, COUNT_MODE_PLATFORM_LIST);
      console.log(`  ${t.tenant_name} (${t.tenant_code}): ${n}/${t.max_users}`);
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
