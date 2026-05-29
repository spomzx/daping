'use strict';
/**
 * 可选：将已知账号的 display_name 写入 users 表（不改表结构）
 * 用法：node backend/scripts/sync-user-display-names.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');

const DISPLAY_NAMES = {
  cqchic: 'CQ CHIC',
  test01: '测试账户管理员',
  test02: '测试公司2管理员',
};

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL 不可用');
    process.exit(1);
  }
  for (const [username, display_name] of Object.entries(DISPLAY_NAMES)) {
    const [r] = await pool.execute(
      `UPDATE users SET display_name = ? WHERE username = ?`,
      [display_name, username],
    );
    console.log(username, '->', display_name, 'affected=', r.affectedRows);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
