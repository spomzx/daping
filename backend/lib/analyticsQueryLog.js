'use strict';

/**
 * Analytics 主查询耗时日志（>300ms）
 * @param {string} endpoint
 * @param {string} status
 * @param {number} ms
 * @param {number} rows
 */
function logAnalyticsQuerySlow(endpoint, status, ms, rows) {
  if (ms <= 300) return;
  const st = String(status || 'all');
  const r = Number.isFinite(Number(rows)) ? Number(rows) : 0;
  console.log(`[analytics-query] endpoint=${endpoint} status=${st} ms=${Math.round(ms)} rows=${r}`);
}

module.exports = { logAnalyticsQuerySlow };
