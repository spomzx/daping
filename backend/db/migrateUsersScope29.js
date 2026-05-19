'use strict';

/**
 * users.scope：tenant | platform（平台管理员跨租户运维）
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').PoolConnection} conn
 */
async function migrateUsersScope29(conn) {
  const [cols] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'scope'`,
  );
  if (Number(cols[0]?.c) === 0) {
    await conn.query(
      `ALTER TABLE users ADD COLUMN scope VARCHAR(16) NOT NULL DEFAULT 'tenant'
       COMMENT 'tenant=单租户; platform=全平台运维' AFTER status`,
    );
    console.log('[mysql] migrateUsersScope29: added users.scope');
  }

  const usernames = String(process.env.PLATFORM_SCOPE_USERNAMES || 'admin')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (usernames.length === 0) return { column: true, upgraded: 0 };

  const placeholders = usernames.map(() => '?').join(',');
  const [r] = await conn.query(
    `UPDATE users SET scope = 'platform' WHERE username IN (${placeholders})`,
    usernames,
  );
  const upgraded = r?.affectedRows != null ? Number(r.affectedRows) : 0;
  if (upgraded > 0) {
    console.log('[mysql] migrateUsersScope29: platform scope users', usernames, 'rows=', upgraded);
  }
  return { column: true, upgraded, usernames };
}

module.exports = { migrateUsersScope29 };
