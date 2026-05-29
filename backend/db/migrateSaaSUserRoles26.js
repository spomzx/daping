'use strict';

/**
 * SaaS 用户体系：user_shop_permissions 预留表；历史 role 迁移为 admin/viewer。
 * 可重复执行，无 DROP/TRUNCATE。
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').PoolConnection} conn
 */
async function migrateSaaSUserRoles26(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`user_shop_permissions\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`user_id\` BIGINT UNSIGNED NOT NULL,
      \`shop_id\` BIGINT UNSIGNED NOT NULL,
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_user_shop\` (\`user_id\`, \`shop_id\`),
      KEY \`idx_usp_shop\` (\`shop_id\`),
      CONSTRAINT \`fk_usp_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE,
      CONSTRAINT \`fk_usp_shop\` FOREIGN KEY (\`shop_id\`) REFERENCES \`shops\` (\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [r1] = await conn.query(
    `UPDATE user_tenants SET role = 'admin' WHERE role IN ('tenant_owner', 'tenant_admin')`,
  );
  const [r2] = await conn.query(
    `UPDATE user_tenants SET role = 'viewer' WHERE role = 'tenant_viewer'`,
  );
  const n1 = r1 && r1.affectedRows != null ? Number(r1.affectedRows) : 0;
  const n2 = r2 && r2.affectedRows != null ? Number(r2.affectedRows) : 0;
  if (n1 > 0 || n2 > 0) {
    console.log('[mysql] migrateSaaSUserRoles26: role rows updated', { admin: n1, viewer: n2 });
  }
}

module.exports = { migrateSaaSUserRoles26 };
