'use strict';

const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getMysqlPool } = require('../db/mysqlPool');
const { isMysqlConfigured } = require('../config/database');
const { getMetricsSnapshot } = require('./syncMetrics');
const { saasHealthFlags } = require('./saasMysqlOnly');

/**
 * @param {string} storageDir
 */
async function runHealthCheck(storageDir) {
  const checks = {
    mysql: { ok: false, configured: isMysqlConfigured(), message: '' },
    ordersMysql: { ok: false, count: null, message: '' },
    shopsMysql: { ok: false, count: null, message: '' },
    usersMysql: { ok: false, count: null, message: '' },
    syncWorker: { ok: false, lastRunAt: null, message: '' },
  };

  const pool = getMysqlPool();
  if (!pool) {
    checks.mysql.message = checks.mysql.configured ? 'pool_unavailable' : 'not_configured';
  } else {
    try {
      await pool.query('SELECT 1');
      checks.mysql.ok = true;
      checks.mysql.message = 'connected';

      const [[oRow]] = await pool.query('SELECT COUNT(*) AS c FROM orders');
      checks.ordersMysql.count = Number(oRow?.c ?? 0);
      checks.ordersMysql.ok = true;

      const [[sRow]] = await pool.query("SELECT COUNT(*) AS c FROM shops WHERE status <> 'deleted'");
      checks.shopsMysql.count = Number(sRow?.c ?? 0);
      checks.shopsMysql.ok = true;

      const [[uRow]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE status NOT IN ('disabled','deleted')");
      checks.usersMysql.count = Number(uRow?.c ?? 0);
      checks.usersMysql.ok = true;
    } catch (e) {
      checks.mysql.message = String(e?.message || e);
    }
  }

  const metrics = getMetricsSnapshot();
  checks.syncWorker.lastRunAt = metrics.sync?.lastRunAt ?? null;
  if (checks.syncWorker.lastRunAt) {
    const ageMin = dayjs().diff(dayjs(checks.syncWorker.lastRunAt), 'minute');
    const maxMin = Math.max(30, Number(process.env.SYNC_HEALTH_MAX_MINUTES || 360));
    checks.syncWorker.ok = ageMin <= maxMin;
    checks.syncWorker.message = `last run ${ageMin} min ago`;
  } else {
    checks.syncWorker.message = 'no_sync_runs_recorded';
  }

  const mysqlReady = checks.mysql.ok && checks.ordersMysql.ok;
  const status =
    mysqlReady && (checks.ordersMysql.count > 0 || checks.syncWorker.ok)
      ? 'ok'
      : mysqlReady
        ? 'degraded'
        : 'unhealthy';

  return {
    status,
    dataSourcePrimary: 'mysql',
    ...saasHealthFlags(),
    checks,
    timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };
}

module.exports = { runHealthCheck };
