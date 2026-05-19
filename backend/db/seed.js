'use strict';

const bcrypt = require('bcrypt');
const { DEFAULT_TENANT_MAX_SHOPS } = require('../lib/tenantShopLimit');

const BCRYPT_ROUNDS = 10;
const MIN_BOOTSTRAP_PASSWORD_LEN = 8;

/**
 * 建默认租户；可选通过环境变量一次性创建超管（禁止写死账号密码）。
 * 需同时设置 SEED_BOOTSTRAP_USERNAME 与 SEED_BOOTSTRAP_PASSWORD（≥8 位）。
 * 已存在用户时不会覆盖 password_hash。
 *
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').Pool} conn
 */
async function runSeed(conn) {
  const [[trow]] = await conn.query(
    "SELECT id FROM tenants WHERE tenant_code = 'default' LIMIT 1",
  );
  let tenantId = trow && trow.id ? Number(trow.id) : null;
  if (!tenantId) {
    const [r] = await conn.query(
      `INSERT INTO tenants (tenant_code, tenant_name, status, plan_type, timezone, base_currency, max_shops)
       VALUES ('default', 'Default Tenant', 'active', NULL, 'UTC', 'USD', ?)`,
      [DEFAULT_TENANT_MAX_SHOPS],
    );
    tenantId = Number(r.insertId);
  } else {
    await conn.query(`UPDATE tenants SET max_shops = ? WHERE tenant_code = 'default'`, [
      DEFAULT_TENANT_MAX_SHOPS,
    ]);
  }

  const bootstrapUser = String(process.env.SEED_BOOTSTRAP_USERNAME || '').trim();
  const bootstrapPass = String(process.env.SEED_BOOTSTRAP_PASSWORD || '');
  let adminId = null;

  if (bootstrapUser && bootstrapPass) {
    if (bootstrapPass.length < MIN_BOOTSTRAP_PASSWORD_LEN) {
      throw new Error(
        `SEED_BOOTSTRAP_PASSWORD must be at least ${MIN_BOOTSTRAP_PASSWORD_LEN} characters`,
      );
    }
    const passwordHash = await bcrypt.hash(bootstrapPass, BCRYPT_ROUNDS);
    await conn.query(
      `INSERT INTO users (username, password_hash, display_name, status)
       VALUES (?, ?, 'Bootstrap Administrator', 'active')
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = 'active'`,
      [bootstrapUser, passwordHash],
    );
    const [[adminUser]] = await conn.query('SELECT id FROM users WHERE username = ? LIMIT 1', [
      bootstrapUser,
    ]);
    adminId = adminUser?.id ? Number(adminUser.id) : null;
    if (adminId) {
      await conn.query(
        `INSERT INTO user_tenants (user_id, tenant_id, role, status)
         VALUES (?, ?, 'super_admin', 'active')
         ON DUPLICATE KEY UPDATE role = 'super_admin', status = 'active'`,
        [adminId, tenantId],
      );
      await conn.query(`UPDATE users SET scope = 'platform' WHERE id = ?`, [adminId]);
    }
  }

  return { tenantId, adminId };
}

module.exports = { runSeed };
