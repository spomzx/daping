'use strict';

const { SQL_ADMIN_ROLES_IN, isAdminFamily } = require('../../lib/roles');
const {
  isProtectedTenant,
  logBlockedProtectedTenant,
  logTenantAudit,
  logTenantRepairSkipped,
} = require('../../lib/tenantSafety');

const DELETED_REMARK = 'deleted because no active tenant admin';

const ACTIVE_SYNC_JOB_STATUSES = ['queued', 'running', 'retry_wait'];

/**
 * @param {import('mysql2/promise').Pool | import('mysql2/promise').Connection} db
 * @param {number} tenantId
 * @param {number|null} [excludeUserId]
 */
async function countActiveTenantAdmins(db, tenantId, excludeUserId = null) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return 0;

  const params = [tid];
  let excludeSql = '';
  const ex = excludeUserId != null ? Number(excludeUserId) : null;
  if (Number.isFinite(ex) && ex > 0) {
    excludeSql = ' AND ut.user_id <> ?';
    params.push(ex);
  }

  const [rows] = await db.query(
    `SELECT COUNT(DISTINCT ut.user_id) AS c
     FROM user_tenants ut
     INNER JOIN users u ON u.id = ut.user_id
     WHERE ut.tenant_id = ?
       AND ut.status = 'active'
       AND u.status NOT IN ('disabled','deleted')
       AND ut.role IN (${SQL_ADMIN_ROLES_IN})
       ${excludeSql}`,
    params,
  );
  return Number(rows?.[0]?.c) || 0;
}

/**
 * SaaS 红线：
 * 禁止自动删除 default tenant。
 * 禁止因「无 active admin」直接删除 tenant。
 * 删除 tenant 必须人工确认。
 *
 * 无管理员时仅审计 + warning，不软删租户。
 *
 * @param {import('mysql2/promise').Connection} conn
 * @param {number} tenantId
 */
async function softDeleteTenantIfNoActiveAdmin(conn, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return { updated: false };

  const remaining = await countActiveTenantAdmins(conn, tid);
  if (remaining > 0) return { updated: false };

  const [[trow]] = await conn.query(
    'SELECT id, tenant_name, tenant_code, status FROM tenants WHERE id = ? LIMIT 1',
    [tid],
  );
  if (!trow || String(trow.status || '').toLowerCase() === 'deleted') {
    return { updated: false };
  }

  if (isProtectedTenant(trow)) {
    logBlockedProtectedTenant(trow, {
      action: 'repair_no_admin_blocked',
      reason: DELETED_REMARK,
      operator: 'tenantAdminSync',
    });
    return { updated: false, blocked: true };
  }

  logTenantRepairSkipped(trow, {
    action: 'repair_no_admin_skipped',
    reason: DELETED_REMARK,
    operator: 'tenantAdminSync',
    note: 'no auto-delete',
  });

  await conn.execute(
    `UPDATE tenants
     SET status = IF(status = 'deleted', status, 'warning'),
         plan_remark = CONCAT(
           IFNULL(NULLIF(TRIM(plan_remark), ''), ''),
           IF(TRIM(IFNULL(plan_remark, '')) = '', '', ' | '),
           ?
         ),
         updated_at = NOW(3)
     WHERE id = ?
       AND status <> 'deleted'`,
    ['repair_no_admin: no active admin (auto-delete disabled)', tid],
  );

  logTenantAudit({
    tenant_id: tid,
    tenant_code: trow.tenant_code,
    operator: 'tenantAdminSync',
    action: 'tenant_marked_warning',
    reason: 'no_active_admin',
  });

  return {
    updated: false,
    warning: true,
    tenantId: tid,
    status: 'warning',
    tenant_name: String(trow.tenant_name || ''),
    tenant_code: String(trow.tenant_code || ''),
  };
}

/**
 * cqchic 主账户：禁止删除唯一租户管理员。
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 * @param {Array<{ tenant_id: unknown, role: string }>} memberships
 */
async function assertCanDeleteUser(pool, userId, memberships) {
  const [[u]] = await pool.query('SELECT username FROM users WHERE id = ? LIMIT 1', [userId]);
  const username = String(u?.username || '').trim().toLowerCase();
  if (username !== 'cqchic') return null;

  for (const m of memberships) {
    const role = String(m.role || '');
    if (!isAdminFamily(role)) continue;
    const tid = Number(m.tenant_id);
    if (!Number.isFinite(tid) || tid <= 0) continue;
    const remaining = await countActiveTenantAdmins(pool, tid, userId);
    if (remaining === 0) {
      return {
        ok: false,
        status: 400,
        error: 'cannot_delete_cqchic_primary_admin',
        message: '不能删除 CQ CHIC 主账户唯一管理员',
      };
    }
  }
  return null;
}

module.exports = {
  DELETED_REMARK,
  countActiveTenantAdmins,
  softDeleteTenantIfNoActiveAdmin,
  assertCanDeleteUser,
};
