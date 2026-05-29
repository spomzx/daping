'use strict';

/**
 * tenants.deleted_at 列迁移（幂等）。
 *
 * SaaS 红线：
 * 禁止自动删除 default tenant。
 * 禁止因「无 active admin」直接删除 tenant。
 * 删除 tenant 必须人工确认。
 *
 * repair（orphaned / no-admin）仅打审计日志；非保护租户可标记 warning，不自动 deleted。
 *
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').Pool} conn
 */

const { SQL_ADMIN_ROLES_IN } = require('../lib/roles');
const {
  isProtectedTenant,
  logBlockedProtectedTenant,
  logTenantAudit,
  logTenantRepairSkipped,
} = require('../lib/tenantSafety');

const DELETED_REMARK = 'deleted because no active tenant admin';

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Number(rows[0]?.c) > 0;
}

/**
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').Pool} conn
 * @param {'orphaned'|'no_admin'} kind
 */
async function auditRepairCandidates(conn, kind) {
  let sql;
  if (kind === 'orphaned') {
    sql = `SELECT id, tenant_code, status FROM tenants WHERE status = 'orphaned'`;
  } else {
    sql = `SELECT t.id, t.tenant_code, t.status
     FROM tenants t
     WHERE t.status NOT IN ('deleted')
       AND NOT EXISTS (
         SELECT 1 FROM user_tenants ut
         INNER JOIN users u ON u.id = ut.user_id
         WHERE ut.tenant_id = t.id
           AND ut.status = 'active'
           AND u.status NOT IN ('disabled','deleted')
           AND ut.role IN (${SQL_ADMIN_ROLES_IN})
       )`;
  }
  const [rows] = await conn.query(sql);
  const list = Array.isArray(rows) ? rows : [];
  let blocked = 0;
  let warned = 0;

  for (const t of list) {
    if (isProtectedTenant(t)) {
      blocked += 1;
      logBlockedProtectedTenant(t, {
        action: 'migrate_repair_blocked',
        reason: kind === 'orphaned' ? 'orphaned_tenant' : 'repair_no_admin',
        operator: 'migrateTenantsDeletedAt42',
      });
      continue;
    }

    warned += 1;
    logTenantRepairSkipped(t, {
      action: 'migrate_repair_skipped',
      reason: kind === 'orphaned' ? 'orphaned_tenant' : 'repair_no_admin',
      operator: 'migrateTenantsDeletedAt42',
      note: 'auto-delete disabled; marking warning if not deleted',
    });

    await conn.query(
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
      [kind === 'orphaned' ? 'migrate42: orphaned (no auto-delete)' : DELETED_REMARK, t.id],
    );
  }

  return { candidates: list.length, blocked, warned };
}

async function migrateTenantsDeletedAt42(conn) {
  if (!(await columnExists(conn, 'tenants', 'deleted_at'))) {
    await conn.query(
      `ALTER TABLE tenants ADD COLUMN deleted_at DATETIME(3) NULL DEFAULT NULL
       COMMENT '软删除时间' AFTER updated_at`,
    );
    console.log('[migrate42] tenants.deleted_at added');
  }

  const orphaned = await auditRepairCandidates(conn, 'orphaned');
  if (orphaned.candidates > 0) {
    console.log(
      `[migrate42] orphaned tenants audit candidates=${orphaned.candidates} blocked=${orphaned.blocked} warned=${orphaned.warned}`,
    );
  }

  const noAdmin = await auditRepairCandidates(conn, 'no_admin');
  if (noAdmin.candidates > 0) {
    console.log(
      `[migrate42] no-admin tenants audit candidates=${noAdmin.candidates} blocked=${noAdmin.blocked} warned=${noAdmin.warned}`,
    );
  }

  logTenantAudit({
    tenant_id: null,
    tenant_code: null,
    operator: 'migrateTenantsDeletedAt42',
    action: 'migrate_complete',
    reason: 'no_auto_delete',
  });

  return {
    deleted_at: true,
    repaired_orphaned: 0,
    repaired_no_admin: 0,
    audited_orphaned: orphaned,
    audited_no_admin: noAdmin,
  };
}

module.exports = { migrateTenantsDeletedAt42, DELETED_REMARK };
