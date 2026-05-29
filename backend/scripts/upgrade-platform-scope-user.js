'use strict';
/**
 * 将指定用户升级为 platform scope（默认 admin）
 * 用法：PLATFORM_SCOPE_USERNAMES=admin node backend/scripts/upgrade-platform-scope-user.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { migrateUsersScope29 } = require('../db/migrateUsersScope29');

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL 不可用');
    process.exit(1);
  }
  const conn = await pool.getConnection();
  try {
    const out = await migrateUsersScope29(conn);
    console.log('done', out);
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
