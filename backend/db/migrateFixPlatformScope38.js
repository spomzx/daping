'use strict';

/**
 * 修正 platform scope：仅平台管理员（默认 admin）保留 scope=platform；
 * 误设为 platform 的租户用户（如 cqchic）恢复为 tenant。
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').PoolConnection} conn
 */
async function migrateFixPlatformScope38(conn) {
  const platformUsernames = String(process.env.PLATFORM_SCOPE_USERNAMES || 'admin')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const [r1] = await conn.query(`UPDATE users SET scope = 'tenant' WHERE scope = 'platform'`);
  const resetRows = r1?.affectedRows != null ? Number(r1.affectedRows) : 0;

  let upgraded = 0;
  if (platformUsernames.length > 0) {
    const placeholders = platformUsernames.map(() => '?').join(',');
    const [r2] = await conn.query(
      `UPDATE users SET scope = 'platform' WHERE username IN (${placeholders})`,
      platformUsernames,
    );
    upgraded = r2?.affectedRows != null ? Number(r2.affectedRows) : 0;
  }

  return { resetRows, upgraded, platformUsernames };
}

module.exports = { migrateFixPlatformScope38 };
