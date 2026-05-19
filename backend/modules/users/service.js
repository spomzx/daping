'use strict';

const bcrypt = require('bcrypt');
const {
  normalizeRoleFromDb,
  normalizeRoleForStorage,
  isSuperAdmin,
  isAdminFamily,
  isReadOnlyRole,
  SQL_ADMIN_ROLES_IN,
} = require('../../lib/roles');
const { normalizeUserScope, isPlatformScopeUser } = require('../../lib/userScope');
const { buildListUsersWhere } = require('../../lib/tenantUserMembership');
const { actorHasPlatformPrivileges, getMembershipInTenant } = require('./serviceHelpers');
const repo = require('./repository');
const {
  assertTenantActive,
  assertUserLimit,
  PlanGuardError,
  syncCurrentUsersCache,
} = require('../tenants/planService');

const BCRYPT_ROUNDS = 10;

function mapUserRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    role: normalizeRoleFromDb(row.role),
    scope: normalizeUserScope(row.user_scope ?? row.scope),
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} username
 */
async function findLoginContextByUsername(pool, username) {
  const u = String(username || '').trim();
  if (!u) return null;
  const [rows] = await pool.query(
    `SELECT
       u.id AS user_id,
       u.username,
       u.password_hash,
       u.display_name,
       u.status AS user_status,
       u.scope AS user_scope,
       ut.tenant_id,
       ut.role,
       ut.status AS membership_status,
       t.tenant_code,
       t.max_shops,
       t.tenant_name,
       t.status AS tenant_status
     FROM users u
     INNER JOIN user_tenants ut ON ut.user_id = u.id
       AND ut.status NOT IN ('disabled','deleted')
     INNER JOIN tenants t ON t.id = ut.tenant_id
       AND t.status NOT IN ('disabled','deleted')
     WHERE u.username = ?
       AND u.status NOT IN ('disabled','deleted')
     ORDER BY CASE WHEN t.tenant_code = 'default' THEN 0 ELSE 1 END, t.id ASC`,
    [u],
  );
  const list = Array.isArray(rows) ? rows : [];
  return list[0] || null;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 */
async function touchLastLogin(pool, userId) {
  await pool.execute('UPDATE users SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [userId]);
}

/**
 * 当前 JWT 上下文下的用户 + 租户 + 成员关系（与登录口径一致：不强制 tenant 行 status，便于排查）
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 * @param {number} tenantId
 */
async function getMeProfile(pool, userId, tenantId) {
  const [rows] = await pool.query(
    `SELECT
       u.id,
       u.username,
       u.display_name,
       u.contact,
       u.status AS user_status,
       u.scope AS user_scope,
       u.last_login_at,
       u.created_at,
       u.updated_at,
       ut.tenant_id,
       ut.role,
       ut.status AS membership_status,
       t.id AS tenant_row_id,
       t.tenant_code,
       t.tenant_name,
       t.status AS tenant_status,
       t.max_shops,
       t.shop_limit,
       t.max_users,
       t.expires_at,
       t.is_active,
       t.plan_remark,
       t.base_currency,
       t.timezone,
       t.plan_type
     FROM users u
     INNER JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = ?
     INNER JOIN tenants t ON t.id = ut.tenant_id
     WHERE u.id = ?
     LIMIT 1`,
    [tenantId, userId],
  );
  const list = Array.isArray(rows) ? rows : [];
  return list[0] || null;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ user_id: number, tenant_id: number, role: string }} auth
 * @param {Record<string, unknown>} [query]
 */
async function listUsersForActor(pool, auth, query = {}) {
  const role = String(auth.role || '');
  if (isReadOnlyRole(role)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.page_size || query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const built = buildListUsersWhere(auth, query);
  if (!built.ok) {
    return { ok: false, status: built.status || 403, error: built.error };
  }
  if (built.empty) {
    return {
      ok: true,
      list: [],
      users: [],
      total: 0,
      page,
      page_size: pageSize,
    };
  }

  const baseWhere = built.whereSql;
  const params = built.params;
  const total = await repo.countUsers(pool, baseWhere, params);
  const rows = await repo.listUsersPaged(pool, baseWhere, params, pageSize, offset);
  const users = rows.map((row) => ({
    ...mapUserRow(row),
    assigned_shop_count: Number(row.assigned_shop_count) || 0,
  }));

  return {
    ok: true,
    list: users,
    users,
    total,
    page,
    page_size: pageSize,
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ user_id: number, tenant_id: number, role: string }} auth
 * @param {object} body
 */
async function createUserByActor(pool, auth, body) {
  const role = String(auth.role || '');
  if (isReadOnlyRole(role)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayNameRaw = body.display_name;
  const display_name =
    displayNameRaw == null || displayNameRaw === '' ? null : String(displayNameRaw).trim().slice(0, 255);
  if (!username || username.length > 128) {
    return { ok: false, status: 400, error: 'invalid_username' };
  }
  if (password.length < 6) {
    return { ok: false, status: 400, error: 'weak_password' };
  }

  let tenantId;
  let storeRole;

  if (actorHasPlatformPrivileges(auth)) {
    const raw = String(body.role || 'admin').trim();
    const nr = normalizeRoleForStorage(raw);
    if (nr !== 'admin') {
      return {
        ok: false,
        status: 400,
        error: 'invalid_role',
        message: '平台管理员仅可创建账户管理员',
      };
    }
    if (nr === 'super_admin') {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    storeRole = 'admin';
    const tid = Number(body.tenant_id);
    if (!Number.isFinite(tid) || tid <= 0) {
      return { ok: false, status: 400, error: 'invalid_tenant_id' };
    }
    tenantId = tid;
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return { ok: false, status: 400, error: 'invalid_tenant_id' };
    }
    const [[t]] = await pool.query('SELECT id FROM tenants WHERE id = ? LIMIT 1', [tenantId]);
    if (!t) {
      return { ok: false, status: 404, error: 'tenant_not_found' };
    }
  } else if (isAdminFamily(role)) {
    const [[tp]] = await pool.query(
      `SELECT u.status AS us, ut.status AS ms, t.status AS ts
       FROM user_tenants ut
       INNER JOIN users u ON u.id = ut.user_id
       INNER JOIN tenants t ON t.id = ut.tenant_id
       WHERE ut.user_id = ? AND ut.tenant_id = ?
       LIMIT 1`,
      [auth.user_id, auth.tenant_id],
    );
    if (!tp || String(tp.us) !== 'active' || String(tp.ms) !== 'active' || String(tp.ts) !== 'active') {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    tenantId = auth.tenant_id;
    storeRole = 'viewer';
  } else {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  try {
    await assertTenantActive(pool, tenantId);
    await assertUserLimit(pool, tenantId);
  } catch (e) {
    if (e instanceof PlanGuardError) {
      return { ok: false, status: e.status || 403, error: e.code, message: e.message };
    }
    throw e;
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.execute(
      `INSERT INTO users (username, password_hash, display_name, status)
       VALUES (?, ?, ?, 'active')`,
      [username, password_hash, display_name],
    );
    const uid = Number(ins.insertId);
    await conn.execute(
      `INSERT INTO user_tenants (user_id, tenant_id, role, status)
       VALUES (?, ?, ?, 'active')`,
      [uid, tenantId, storeRole],
    );
    await conn.commit();
    await syncCurrentUsersCache(pool, tenantId);
    return {
      ok: true,
      user: {
        id: uid,
        username,
        display_name,
        tenant_id: tenantId,
        role: normalizeRoleFromDb(storeRole),
        status: 'active',
        membership_status: 'active',
      },
    };
  } catch (e) {
    await conn.rollback();
    if (e && e.code === 'ER_DUP_ENTRY') {
      return { ok: false, status: 409, error: 'username_taken' };
    }
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ user_id: number, tenant_id: number, role: string }} auth
 * @param {number} targetUserId
 * @param {string} status active|disabled
 */
async function setUserStatusByActor(pool, auth, targetUserId, status) {
  const st = String(status || '').trim();
  if (st !== 'active' && st !== 'disabled') {
    return { ok: false, status: 400, error: 'invalid_status' };
  }
  if (targetUserId === auth.user_id && st === 'disabled') {
    return { ok: false, status: 400, error: 'cannot_disable_self' };
  }

  const actorRole = String(auth.role || '');
  if (isReadOnlyRole(actorRole)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  if (actorHasPlatformPrivileges(auth)) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [u] = await conn.execute('SELECT id FROM users WHERE id = ? LIMIT 1', [targetUserId]);
      if (!Array.isArray(u) || !u[0]) {
        await conn.rollback();
        return { ok: false, status: 404, error: 'user_not_found' };
      }
      await conn.execute('UPDATE users SET status = ? WHERE id = ?', [st, targetUserId]);
      await conn.execute('UPDATE user_tenants SET status = ? WHERE user_id = ?', [st, targetUserId]);
      const [tenantRows] = await conn.query(
        'SELECT DISTINCT tenant_id FROM user_tenants WHERE user_id = ?',
        [targetUserId],
      );
      await conn.commit();
      for (const tr of Array.isArray(tenantRows) ? tenantRows : []) {
        const tid = Number(tr.tenant_id);
        if (Number.isFinite(tid) && tid > 0) await syncCurrentUsersCache(pool, tid);
      }
      return { ok: true };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  if (isAdminFamily(actorRole)) {
    const m = await getMembershipInTenant(pool, targetUserId, auth.tenant_id);
    if (!m) {
      return { ok: false, status: 404, error: 'user_not_found' };
    }
    if (isSuperAdmin(m.role) || isPlatformScopeUser({ scope: m.user_scope, role: m.role })) {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    if (isAdminFamily(m.role)) {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        'UPDATE user_tenants SET status = ? WHERE user_id = ? AND tenant_id = ?',
        [st, targetUserId, auth.tenant_id],
      );
      await conn.execute('UPDATE users SET status = ? WHERE id = ?', [st, targetUserId]);
      await conn.commit();
      await syncCurrentUsersCache(pool, auth.tenant_id);
      return { ok: true };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  return { ok: false, status: 403, error: 'forbidden' };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ user_id: number, tenant_id: number, role: string }} auth
 * @param {number} targetUserId
 * @param {string} newPassword
 */
async function resetPasswordByActor(pool, auth, targetUserId, newPassword) {
  const password = String(newPassword || '');
  if (password.length < 6) {
    return { ok: false, status: 400, error: 'weak_password' };
  }

  const actorRole = String(auth.role || '');
  if (isReadOnlyRole(actorRole)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  if (actorHasPlatformPrivileges(auth)) {
    const [rows] = await pool.query('SELECT id FROM users WHERE id = ? LIMIT 1', [targetUserId]);
    if (!Array.isArray(rows) || !rows[0]) {
      return { ok: false, status: 404, error: 'user_not_found' };
    }
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, targetUserId]);
    return { ok: true };
  }

  if (isAdminFamily(actorRole)) {
    const m = await getMembershipInTenant(pool, targetUserId, auth.tenant_id);
    if (!m) {
      return { ok: false, status: 404, error: 'user_not_found' };
    }
    if (isSuperAdmin(m.role) || isPlatformScopeUser({ scope: m.user_scope, role: m.role })) {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    if (isAdminFamily(m.role)) {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, targetUserId]);
    return { ok: true };
  }

  return { ok: false, status: 403, error: 'forbidden' };
}

/**
 * super_admin：审核通过 pending_review 主账号（租户 + 用户 + 成员置 active）。
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ user_id: number, tenant_id: number, role: string }} auth
 * @param {number} targetUserId
 */
async function approvePendingTenantOwner(pool, auth, targetUserId) {
  if (!actorHasPlatformPrivileges(auth)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const uid = Number(targetUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, status: 400, error: 'invalid_id' };
  }
  const [[ut]] = await pool.query(
    `SELECT ut.tenant_id
     FROM user_tenants ut
     WHERE ut.user_id = ?
       AND ut.role IN (${SQL_ADMIN_ROLES_IN})
       AND ut.status = 'pending_review'
     LIMIT 1`,
    [uid],
  );
  if (!ut || ut.tenant_id == null) {
    return { ok: false, status: 404, error: 'not_found' };
  }
  const tenantId = Number(ut.tenant_id);
  const { insertNotification } = require('../notifications/service');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`UPDATE tenants SET status = 'active' WHERE id = ? AND status = 'pending_review'`, [tenantId]);
    await conn.execute(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending_review'`, [uid]);
    await conn.execute(
      `UPDATE user_tenants SET status = 'active' WHERE user_id = ? AND tenant_id = ? AND status = 'pending_review'`,
      [uid, tenantId],
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await insertNotification(pool, {
    tenant_id: tenantId,
    user_id: uid,
    title: '账号已开通',
    content: '管理员已通过审核，您可正常使用系统。',
    type: 'review_approved',
  });
  return { ok: true };
}

/**
 * super_admin：拒绝注册（禁用租户、用户、成员关系）。
 */
async function rejectPendingTenantOwner(pool, auth, targetUserId) {
  if (!actorHasPlatformPrivileges(auth)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const uid = Number(targetUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, status: 400, error: 'invalid_id' };
  }
  const [[ut]] = await pool.query(
    `SELECT ut.tenant_id
     FROM user_tenants ut
     WHERE ut.user_id = ?
       AND ut.role IN (${SQL_ADMIN_ROLES_IN})
       AND ut.status = 'pending_review'
     LIMIT 1`,
    [uid],
  );
  if (!ut || ut.tenant_id == null) {
    return { ok: false, status: 404, error: 'not_found' };
  }
  const tenantId = Number(ut.tenant_id);
  const { insertNotification } = require('../notifications/service');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`UPDATE tenants SET status = 'disabled' WHERE id = ?`, [tenantId]);
    await conn.execute(`UPDATE users SET status = 'disabled' WHERE id = ?`, [uid]);
    await conn.execute(`UPDATE user_tenants SET status = 'disabled' WHERE user_id = ? AND tenant_id = ?`, [uid, tenantId]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await insertNotification(pool, {
    tenant_id: tenantId,
    user_id: uid,
    title: '注册未通过',
    content: '管理员已拒绝本次注册申请，账号已禁用。如有疑问请联系平台。',
    type: 'review_rejected',
  });
  return { ok: true };
}

/**
 * 删除用户：viewer 硬删；admin 仅 super_admin 可删；super_admin 不可删。
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ user_id: number, tenant_id: number, role: string }} auth
 * @param {number} targetUserId
 */
async function deleteUserByActor(pool, auth, targetUserId) {
  const actorRole = String(auth.role || '');
  if (isReadOnlyRole(actorRole)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  if (!actorHasPlatformPrivileges(auth) && !isAdminFamily(actorRole)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  const uid = Number(targetUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, status: 400, error: 'invalid_id' };
  }
  if (uid === Number(auth.user_id)) {
    return {
      ok: false,
      status: 400,
      error: 'cannot_delete_self',
      message: '不允许删除当前登录用户',
    };
  }

  const [memRows] = await pool.query(
    `SELECT ut.tenant_id, ut.role, u.scope AS user_scope
     FROM user_tenants ut
     INNER JOIN users u ON u.id = ut.user_id
     WHERE ut.user_id = ?`,
    [uid],
  );
  const memberships = Array.isArray(memRows) ? memRows : [];
  if (memberships.length === 0) {
    return { ok: false, status: 404, error: 'user_not_found' };
  }

  const targetHasSuper = memberships.some(
    (m) => isSuperAdmin(m.role) || isPlatformScopeUser({ scope: m.user_scope, role: m.role }),
  );
  if (targetHasSuper && !actorHasPlatformPrivileges(auth)) {
    return {
      ok: false,
      status: 403,
      error: 'cannot_delete_super_admin',
      message: '不能删除超级管理员',
    };
  }
  if (targetHasSuper && actorHasPlatformPrivileges(auth)) {
    const [[row]] = await pool.query(
      `SELECT COUNT(DISTINCT ut.user_id) AS c
       FROM user_tenants ut
       INNER JOIN users u ON u.id = ut.user_id
       WHERE ut.status = 'active'
         AND u.status NOT IN ('disabled','deleted')
         AND ut.role IN ('super_admin','platform_admin')`,
    );
    const cnt = row && row.c != null ? Number(row.c) : 0;
    if (cnt <= 1) {
      return {
        ok: false,
        status: 400,
        error: 'cannot_delete_last_super_admin',
        message: '不能删除最后一个平台管理员',
      };
    }
  }

  const targetIsAdmin = memberships.some((m) => isAdminFamily(m.role));
  const targetIsViewerOnly = memberships.every((m) => isReadOnlyRole(m.role));

  if (targetIsAdmin) {
    if (!actorHasPlatformPrivileges(auth)) {
      return {
        ok: false,
        status: 400,
        error: 'cannot_delete_owner',
        message: '管理员不能被客户管理员删除，请联系平台管理员处理',
      };
    }
  } else if (!targetIsViewerOnly) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  if (isAdminFamily(actorRole)) {
    const m = await getMembershipInTenant(pool, uid, auth.tenant_id);
    if (!m || !isReadOnlyRole(m.role)) {
      return { ok: false, status: 404, error: 'user_not_found' };
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM user_tenants WHERE user_id = ?', [uid]);
    await conn.execute('DELETE FROM users WHERE id = ?', [uid]);
    await conn.commit();
    const tenantIds = new Set(
      memberships.map((m) => Number(m.tenant_id)).filter((id) => Number.isFinite(id) && id > 0),
    );
    for (const tid of tenantIds) {
      await syncCurrentUsersCache(pool, tid);
    }
    return { ok: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  findLoginContextByUsername,
  touchLastLogin,
  getMeProfile,
  listUsersForActor,
  createUserByActor,
  setUserStatusByActor,
  resetPasswordByActor,
  approvePendingTenantOwner,
  rejectPendingTenantOwner,
  deleteUserByActor,
  isReadOnlyRole,
  isAdminFamily,
  isSuperAdmin,
  normalizeRoleFromDb,
};
