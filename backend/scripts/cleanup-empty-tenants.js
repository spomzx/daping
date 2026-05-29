'use strict';
/**
 * 删除已确认无关联数据的空租户（禁止删除 Default Tenant）
 *
 * 用法：
 *   node backend/scripts/cleanup-empty-tenants.js
 *   TENANT_CODES=cq-chic-b2b12d3a node backend/scripts/cleanup-empty-tenants.js
 *   DRY_RUN=1 node backend/scripts/cleanup-empty-tenants.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { SYSTEM_TENANT_CODE, isSystemTenantCode } = require('../lib/systemTenant');

const DEFAULT_TARGETS = [
  { tenant_name: 'cq chic', tenant_code: 'cq-chic-b2b12d3a' },
];

const REQUIRED_ZERO_CHECKS = [
  { key: 'user_tenants', sql: 'SELECT COUNT(*) AS c FROM user_tenants WHERE tenant_id = ?' },
  { key: 'shops', sql: 'SELECT COUNT(*) AS c FROM shops WHERE tenant_id = ?' },
  { key: 'orders', sql: 'SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ?' },
  { key: 'shop_auth_tokens', sql: 'SELECT COUNT(*) AS c FROM shop_auth_tokens WHERE tenant_id = ?' },
  { key: 'sync_shop_logs', sql: 'SELECT COUNT(*) AS c FROM sync_shop_logs WHERE tenant_id = ?' },
];

const GATE_KEYS = REQUIRED_ZERO_CHECKS.map((x) => x.key);

async function countFor(conn, spec, tenantId) {
  const [[row]] = await conn.query(spec.sql, [tenantId]);
  return Number(row?.c) || 0;
}

async function resolveTargets(conn) {
  const envCodes = String(process.env.TENANT_CODES || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (envCodes.length) {
    const out = [];
    for (const code of envCodes) {
      const [[t]] = await conn.query(
        `SELECT id, tenant_code, tenant_name FROM tenants WHERE tenant_code = ? LIMIT 1`,
        [code],
      );
      if (t) out.push(t);
      else console.warn(`[warn] 未找到 tenant_code=${code}`);
    }
    return out;
  }

  const out = [];
  for (const spec of DEFAULT_TARGETS) {
    const [[t]] = await conn.query(
      `SELECT id, tenant_code, tenant_name FROM tenants WHERE tenant_code = ? OR tenant_name = ? LIMIT 1`,
      [spec.tenant_code, spec.tenant_name],
    );
    if (t) out.push(t);
    else console.warn(`[warn] 未找到租户: ${spec.tenant_name} / ${spec.tenant_code}`);
  }
  return out;
}

async function auditTenant(conn, tenant) {
  const counts = {};
  for (const spec of REQUIRED_ZERO_CHECKS) {
    counts[spec.key] = await countFor(conn, spec, tenant.id);
  }
  return counts;
}

function canDelete(counts) {
  const reasons = [];
  for (const key of GATE_KEYS) {
    const n = counts[key] ?? 0;
    if (n > 0) reasons.push(`${key}=${n}`);
  }
  return { ok: reasons.length === 0, reasons };
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL 不可用');
    process.exit(1);
  }

  const conn = await pool.getConnection();
  try {
    const targets = await resolveTargets(conn);
    if (!targets.length) {
      console.log('无待处理租户');
      return;
    }

    for (const tenant of targets) {
      console.log(`\n--- ${tenant.tenant_name} (${tenant.tenant_code}) id=${tenant.id} ---`);

      if (isSystemTenantCode(tenant.tenant_code)) {
        console.error('禁止删除系统租户 Default Tenant');
        continue;
      }

      const counts = await auditTenant(conn, tenant);
      console.table(
        Object.entries(counts).map(([k, c]) => ({
          table: k,
          count: c,
          gate: GATE_KEYS.includes(k) ? (c === 0 ? 'ok' : 'BLOCK') : 'info',
        })),
      );

      const gate = canDelete(counts);
      if (!gate.ok) {
        console.error('拒绝删除，以下计数须全部为 0：', gate.reasons.join(', '));
        continue;
      }

      if (dryRun) {
        console.log('[DRY_RUN] 将删除 tenants.id =', tenant.id);
        continue;
      }

      await conn.beginTransaction();
      try {
        await conn.execute(`DELETE FROM tenants WHERE id = ?`, [tenant.id]);
        await conn.commit();
        console.log('已删除租户:', tenant.tenant_name);
      } catch (e) {
        await conn.rollback();
        console.error('删除失败:', e?.message || e);
      }
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
