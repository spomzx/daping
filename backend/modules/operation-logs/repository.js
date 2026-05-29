'use strict';

const { loadOperationLogsSchema, statusExpr, messageExpr } = require('./schemaMeta');

function parseDetail(row) {
  let d = row?.detail_json;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      d = null;
    }
  }
  return d && typeof d === 'object' ? d : {};
}

function mapRow(row) {
  const detail = parseDetail(row);
  const status =
    row.status != null
      ? String(row.status)
      : detail.status != null
        ? String(detail.status)
        : 'success';
  return {
    id: Number(row.id),
    tenant_id: row.tenant_id != null ? Number(row.tenant_id) : null,
    user_id: row.user_id != null ? Number(row.user_id) : null,
    username: row.username || detail.username || row.uname || null,
    role: row.role || detail.role || null,
    action: String(row.action || ''),
    module: String(row.module || ''),
    target_type: row.target_type || null,
    target_id: row.target_id || null,
    ip: row.ip || null,
    user_agent: row.user_agent || null,
    status,
    message: row.message || detail.message || null,
    before_data: row.before_data ?? detail.before_data ?? null,
    after_data: row.after_data ?? detail.after_data ?? null,
    detail_json: detail,
    created_at: row.created_at,
  };
}

function buildWhere(query, scope) {
  const stExpr = statusExpr('ol');
  const conditions = ['1=1'];
  const params = [];

  if (scope.tenantId != null) {
    conditions.push('ol.tenant_id = ?');
    params.push(scope.tenantId);
  } else if (query.tenantId != null && String(query.tenantId).trim() !== '') {
    const tid = Number(query.tenantId);
    if (Number.isFinite(tid) && tid > 0) {
      conditions.push('ol.tenant_id = ?');
      params.push(tid);
    }
  }

  if (query.module != null && String(query.module).trim() !== '') {
    conditions.push('ol.module = ?');
    params.push(String(query.module).trim().slice(0, 64));
  }
  if (query.action != null && String(query.action).trim() !== '') {
    conditions.push('ol.action = ?');
    params.push(String(query.action).trim().slice(0, 64));
  }
  if (query.userId != null && String(query.userId).trim() !== '') {
    const uid = Number(query.userId);
    if (Number.isFinite(uid)) {
      conditions.push('ol.user_id = ?');
      params.push(uid);
    }
  }
  if (query.status != null && String(query.status).trim() !== '') {
    conditions.push(`${stExpr} = ?`);
    params.push(String(query.status).trim().slice(0, 32));
  }
  if (query.startDate != null && String(query.startDate).trim() !== '') {
    conditions.push('ol.created_at >= ?');
    params.push(`${String(query.startDate).trim()} 00:00:00.000`);
  }
  if (query.endDate != null && String(query.endDate).trim() !== '') {
    conditions.push('ol.created_at <= ?');
    params.push(`${String(query.endDate).trim()} 23:59:59.999`);
  }

  return { sql: conditions.join(' AND '), params, stExpr };
}

async function listLogs(pool, query, scope) {
  await loadOperationLogsSchema(pool);
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  const { sql, params } = buildWhere(query, scope);

  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM operation_logs ol WHERE ${sql}`,
    params,
  );
  const total = Number(countRow?.total) || 0;

  const [rows] = await pool.query(
    `SELECT ol.*, u.username AS uname
     FROM operation_logs ol
     LEFT JOIN users u ON u.id = ol.user_id
     WHERE ${sql}
     ORDER BY ol.created_at DESC, ol.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return {
    page,
    pageSize,
    total,
    items: (Array.isArray(rows) ? rows : []).map(mapRow),
    source: 'mysql',
  };
}

async function getLogById(pool, id, scope) {
  await loadOperationLogsSchema(pool);
  const { sql, params } = buildWhere({}, scope);
  const [rows] = await pool.query(
    `SELECT ol.*, u.username AS uname
     FROM operation_logs ol
     LEFT JOIN users u ON u.id = ol.user_id
     WHERE ol.id = ? AND ${sql}`,
    [id, ...params],
  );
  const row = rows && rows[0];
  return row ? mapRow(row) : null;
}

async function getStats(pool, scope) {
  await loadOperationLogsSchema(pool);
  const { sql, params, stExpr } = buildWhere({}, scope);
  const msgExpr = messageExpr('ol');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todaySql = `${todayStart.getFullYear()}-${String(todayStart.getMonth() + 1).padStart(2, '0')}-${String(todayStart.getDate()).padStart(2, '0')} 00:00:00.000`;

  const [[todayRow]] = await pool.query(
    `SELECT
       COUNT(*) AS today_total,
       SUM(CASE WHEN ${stExpr} = 'failed' THEN 1 ELSE 0 END) AS today_failed
     FROM operation_logs ol
     WHERE ${sql} AND ol.created_at >= ?`,
    [...params, todaySql],
  );

  const [moduleRows] = await pool.query(
    `SELECT ol.module, COUNT(*) AS c
     FROM operation_logs ol
     WHERE ${sql} AND ol.created_at >= ?
     GROUP BY ol.module
     ORDER BY c DESC
     LIMIT 10`,
    [...params, todaySql],
  );

  const [recentFails] = await pool.query(
    `SELECT ol.id, ol.module, ol.action, ${msgExpr} AS message, ol.created_at,
            ${stExpr} AS st
     FROM operation_logs ol
     WHERE ${sql} AND ${stExpr} = 'failed'
     ORDER BY ol.created_at DESC
     LIMIT 5`,
    params,
  );

  const [[userOps]] = await pool.query(
    `SELECT COUNT(DISTINCT ol.user_id) AS user_ops
     FROM operation_logs ol
     WHERE ${sql} AND ol.created_at >= ?`,
    [...params, todaySql],
  );

  const [[syncFails]] = await pool.query(
    `SELECT COUNT(*) AS sync_fail_today
     FROM operation_logs ol
     WHERE ${sql} AND ol.created_at >= ?
       AND ol.module = 'sync'
       AND ${stExpr} = 'failed'`,
    [...params, todaySql],
  );

  return {
    today_total: Number(todayRow?.today_total) || 0,
    today_failed: Number(todayRow?.today_failed) || 0,
    user_ops_today: Number(userOps?.user_ops) || 0,
    sync_fail_today: Number(syncFails?.sync_fail_today) || 0,
    module_stats: (Array.isArray(moduleRows) ? moduleRows : []).map((r) => ({
      module: r.module,
      count: Number(r.c) || 0,
    })),
    recent_failures: Array.isArray(recentFails) ? recentFails : [],
    source: 'mysql',
  };
}

module.exports = { listLogs, getLogById, getStats, mapRow };
