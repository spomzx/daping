'use strict';

/**
 * tenants：current_users 缓存、updated_by 审计
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').PoolConnection} conn
 */
async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Number(rows[0]?.c) > 0;
}

async function migrateTenantPlan37(conn) {
  const added = [];

  if (!(await columnExists(conn, 'tenants', 'current_users'))) {
    await conn.query(
      `ALTER TABLE tenants ADD COLUMN current_users INT UNSIGNED NOT NULL DEFAULT 0
       COMMENT '当前租户账户数缓存' AFTER max_users`,
    );
    added.push('current_users');
  }

  if (!(await columnExists(conn, 'tenants', 'updated_by'))) {
    await conn.query(
      `ALTER TABLE tenants ADD COLUMN updated_by BIGINT UNSIGNED NULL DEFAULT NULL
       COMMENT '最后修改套餐的管理员 users.id' AFTER plan_remark`,
    );
    added.push('updated_by');
  }

  await conn.query(
    `UPDATE tenants t SET current_users = (
       SELECT COUNT(DISTINCT u.id) FROM users u
       INNER JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = t.id
       WHERE ut.status NOT IN ('disabled','deleted')
         AND u.status NOT IN ('disabled','deleted')
     )`,
  );

  return { added };
}

module.exports = { migrateTenantPlan37 };
