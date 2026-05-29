'use strict';

/**
 * Dashboard 性能探测日志（仅检测，不改变 API 响应）。
 * 启用：DASHBOARD_PERF_PROBE=1
 */

function isPerfProbeEnabled() {
  const s = String(process.env.DASHBOARD_PERF_PROBE ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * @param {{
 *   endpoint: string,
 *   filterHash?: string,
 *   cache?: 'hit'|'miss'|'bypass',
 *   durationMs?: number,
 *   sqlMs?: number,
 *   rows?: number,
 *   points?: number,
 *   tenantId?: number|null,
 *   shopId?: string,
 *   market?: string,
 *   orderFilter?: string,
 *   timeRange?: string,
 *   usedStatusField?: string,
 *   cacheSource?: 'memory'|'table'|'db',
 *   refreshSource?: 'polling'|'manual'|'ordersChanged'|'scheduler'|'unknown',
 *   sqlTag?: string,
 * }} meta
 */
function logDashboardPerfProbe(meta) {
  if (!isPerfProbeEnabled()) return;

  const parts = [
    '[perf-probe]',
    `endpoint=${meta.endpoint || ''}`,
    `filterHash=${meta.filterHash ?? ''}`,
    `refreshPending=${meta.refreshPending === true ? 'true' : meta.refreshPending === false ? 'false' : ''}`,
    `cache=${meta.cache ?? ''}`,
    `durationMs=${Math.max(0, Math.floor(Number(meta.durationMs) || 0))}`,
    `sqlMs=${Math.max(0, Math.floor(Number(meta.sqlMs) || 0))}`,
    `rows=${meta.rows != null ? meta.rows : ''}`,
    `tenantId=${meta.tenantId != null ? meta.tenantId : ''}`,
    `shopId=${meta.shopId ?? ''}`,
    `market=${meta.market ?? ''}`,
    `orderFilter=${meta.orderFilter ?? ''}`,
    `timeRange=${meta.timeRange ?? ''}`,
  ];
  if (meta.points != null) parts.push(`points=${meta.points}`);
  if (meta.cacheSource) parts.push(`cacheSource=${meta.cacheSource}`);
  if (meta.refreshSource) parts.push(`refreshSource=${meta.refreshSource}`);
  if (meta.usedStatusField) parts.push(`usedStatusField=${meta.usedStatusField}`);
  if (meta.sqlTag) parts.push(`sqlTag=${meta.sqlTag}`);
  console.log(parts.join(' '));
}

module.exports = { isPerfProbeEnabled, logDashboardPerfProbe };
