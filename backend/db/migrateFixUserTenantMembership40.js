'use strict';

/**
 * 修正已知账号的 user_tenants 归属（与 scripts/fix-user-tenant-membership.js 规则一致）
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').PoolConnection} conn
 */
async function migrateFixUserTenantMembership40(conn) {
  const rules = [
    { username: 'admin', tenant_code: 'default', scope: 'platform', role: 'super_admin' },
    { username: 'spomzx', tenant_code: 'default', scope: 'platform', role: 'super_admin' },
    { username: 'cqchic', tenant_name: '自用', scope: 'tenant', role: 'admin' },
    { username: 'test01', tenant_name: '测试账户', scope: 'tenant', role: null },
    { username: 'test02', tenant_name: '测试公司2', scope: 'tenant', role: null },
  ];

  const changes = [];

  for (const rule of rules) {
    const [[user]] = await conn.query(`SELECT id, username, scope FROM users WHERE username = ? LIMIT 1`, [
      rule.username,
    ]);
    if (!user) continue;

    let tenantId;
    if (rule.tenant_code) {
      const [[t]] = await conn.query(`SELECT id FROM tenants WHERE tenant_code = ? LIMIT 1`, [rule.tenant_code]);
      tenantId = t?.id;
    } else {
      const [[t]] = await conn.query(`SELECT id FROM tenants WHERE tenant_name = ? LIMIT 1`, [rule.tenant_name]);
      tenantId = t?.id;
    }
    if (!tenantId) {
      changes.push({ username: rule.username, skipped: 'tenant_not_found' });
      continue;
    }

    if (rule.scope && String(user.scope) !== rule.scope) {
      await conn.query(`UPDATE users SET scope = ? WHERE id = ?`, [rule.scope, user.id]);
      changes.push({ username: rule.username, scope: rule.scope });
    }

    const [others] = await conn.query(`SELECT id, tenant_id FROM user_tenants WHERE user_id = ? AND tenant_id <> ?`, [
      user.id,
      tenantId,
    ]);
    for (const o of others) {
      await conn.query(`DELETE FROM user_tenants WHERE id = ?`, [o.id]);
      changes.push({ username: rule.username, deleted_tenant_id: o.tenant_id });
    }

    const [[existing]] = await conn.query(
      `SELECT id, role FROM user_tenants WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      [user.id, tenantId],
    );
    const role = rule.role || existing?.role || 'admin';
    if (!existing) {
      await conn.query(
        `INSERT INTO user_tenants (user_id, tenant_id, role, status) VALUES (?, ?, ?, 'active')`,
        [user.id, tenantId, role],
      );
      changes.push({ username: rule.username, inserted: tenantId, role });
    } else if (rule.role && existing.role !== rule.role) {
      await conn.query(`UPDATE user_tenants SET role = ?, status = 'active' WHERE id = ?`, [role, existing.id]);
      changes.push({ username: rule.username, role });
    }
  }

  const [tenants] = await conn.query(`SELECT id FROM tenants`);
  for (const t of tenants) {
    const tid = Number(t.id);
    const [rows] = await conn.query(
      `SELECT COUNT(DISTINCT u.id) AS c
       FROM users u
       INNER JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = ?
       WHERE ut.status NOT IN ('disabled','deleted')
         AND u.status NOT IN ('disabled','deleted')
         AND ut.role NOT IN ('viewer','tenant_viewer')`,
      [tid],
    );
    const n = Number(rows[0]?.c) || 0;
    await conn.query(`UPDATE tenants SET current_users = ? WHERE id = ?`, [n, tid]);
  }

  return { changes };
}

module.exports = { migrateFixUserTenantMembership40 };
