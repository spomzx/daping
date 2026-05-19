'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const BCRYPT_ROUNDS = 10;

function slugTenantCode(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suf = crypto.randomBytes(4).toString('hex');
  const core = base || 'tenant';
  return `${core}-${suf}`.slice(0, 64);
}

/**
 * 公开注册：创建 tenant + tenant_owner + user_tenants，全部为 pending_review。
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} body
 */
async function registerPublicTenantOwner(pool, body) {
  const tenant_name = String(body.tenant_name || '').trim();
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const confirm_password = String(body.confirm_password || '');
  const displayNameRaw = body.display_name;
  const display_name =
    displayNameRaw == null || displayNameRaw === '' ? null : String(displayNameRaw).trim().slice(0, 255);
  const contactRaw = body.contact;
  const contact =
    contactRaw == null || String(contactRaw).trim() === '' ? null : String(contactRaw).trim().slice(0, 512);

  if (!tenant_name || tenant_name.length > 255) {
    return { ok: false, status: 400, error: 'invalid_tenant_name' };
  }
  if (!username || username.length > 128) {
    return { ok: false, status: 400, error: 'invalid_username' };
  }
  if (password.length < 6) {
    return { ok: false, status: 400, error: 'weak_password' };
  }
  if (password !== confirm_password) {
    return { ok: false, status: 400, error: 'password_mismatch' };
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  for (let attempt = 0; attempt < 8; attempt++) {
    const label = attempt === 0 ? tenant_name : `${tenant_name}-${attempt}`;
    const tenant_code = slugTenantCode(label);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [tIns] = await conn.execute(
        `INSERT INTO tenants (tenant_code, tenant_name, status, plan_type, timezone, base_currency, max_shops, shop_limit, max_users, is_active)
         VALUES (?, ?, 'pending_review', 'basic', 'UTC', 'USD', 10, 10, 3, 1)`,
        [tenant_code, tenant_name],
      );
      const tenantId = Number(tIns.insertId);

      const [uIns] = await conn.execute(
        `INSERT INTO users (username, password_hash, display_name, status, contact)
         VALUES (?, ?, ?, 'pending_review', ?)`,
        [username, password_hash, display_name, contact],
      );
      const userId = Number(uIns.insertId);

      await conn.execute(
        `INSERT INTO user_tenants (user_id, tenant_id, role, status)
         VALUES (?, ?, 'admin', 'pending_review')`,
        [userId, tenantId],
      );

      await conn.commit();
      return {
        ok: true,
        tenant_id: tenantId,
        user_id: userId,
        username,
        tenant_code,
      };
    } catch (e) {
      await conn.rollback();
      if (e && e.code === 'ER_DUP_ENTRY') {
        const m = String(e.message || '');
        if (m.includes('username') || m.includes('users.username')) {
          return { ok: false, status: 409, error: 'username_taken' };
        }
        continue;
      }
      throw e;
    } finally {
      conn.release();
    }
  }
  return { ok: false, status: 409, error: 'tenant_code_failed' };
}

module.exports = { registerPublicTenantOwner, slugTenantCode };
