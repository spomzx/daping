'use strict';

const { recordDashboardRequest } = require('./dashboardSlowCollector');

/** 与现有 dashboard-contract slow 阈值一致（可用 DASHBOARD_SLOW_MS 覆盖） */
const SLOW_MS_DEFAULT = Math.max(100, Number(process.env.DASHBOARD_SLOW_MS || 800));

/**
 * 大屏慢请求日志（不输出 SQL 参数 / token / 密码）
 * @param {{
 *   endpoint: string,
 *   durationMs: number,
 *   sqlTag?: string,
 *   timeRange?: string,
 *   orderFilter?: string,
 *   market?: string,
 *   shopId?: string,
 *   tenant?: number|null,
 *   rows?: number,
 *   points?: number,
 *   cache?: number|string|boolean,
 *   cacheHit?: boolean,
 *   thresholdMs?: number,
 * }} meta
 */
function logDashboardSlow(meta) {
  const durationMs = Math.max(0, Math.floor(Number(meta.durationMs) || 0));
  const threshold = Math.max(100, Number(meta.thresholdMs) || SLOW_MS_DEFAULT);

  const cacheLabel =
    meta.cacheHit === true ? 'hit' : meta.cacheHit === false ? 'miss' : meta.cache === 1 ? 'hit' : 'miss';

  recordDashboardRequest({
    endpoint: meta.endpoint,
    sqlTag: meta.sqlTag,
    durationMs,
    cacheHit: meta.cacheHit ?? meta.cache === 1,
    tenant: meta.tenant,
    market: meta.market,
    orderFilter: meta.orderFilter,
    timeRange: meta.timeRange,
    shopId: meta.shopId,
    rows: meta.rows,
    points: meta.points,
  });

  if (durationMs < threshold) return;

  const parts = [
    '[dashboard-contract]',
    'slow',
    `endpoint=${String(meta.endpoint || 'unknown')}`,
    `sqlTag=${String(meta.sqlTag || 'main')}`,
    `durationMs=${durationMs}`,
    `cache=${cacheLabel}`,
    `tenant=${meta.tenant != null ? meta.tenant : ''}`,
    `market=${String(meta.market ?? '')}`,
    `orderFilter=${String(meta.orderFilter ?? '')}`,
    `timeRange=${String(meta.timeRange ?? '')}`,
    `shopId=${String(meta.shopId ?? '')}`,
  ];
  if (meta.rows != null && String(meta.rows) !== '') parts.push(`rows=${meta.rows}`);
  if (meta.points != null && String(meta.points) !== '') parts.push(`points=${meta.points}`);
  console.warn(parts.join(' '));
}

/**
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {Record<string, unknown>} [extra]
 */
function slowMetaFromContract(contract, extra = {}) {
  return {
    timeRange: contract?.timeRange ?? '',
    orderFilter: contract?.orderFilter ?? '',
    market: contract?.market ?? '',
    shopId: contract?.shopId ?? '',
    tenant: contract?.tenantId != null ? contract.tenantId : '',
    ...extra,
  };
}

module.exports = { logDashboardSlow, slowMetaFromContract, SLOW_MS_DEFAULT };
