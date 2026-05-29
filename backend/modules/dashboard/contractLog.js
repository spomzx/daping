'use strict';

/**
 * Dashboard 契约日志（MySQL-only）：统一 endpoint / filter / reason 输出。
 */

/**
 * @param {{
 *   invalidShop?: boolean,
 *   rows?: number,
 *   points?: number,
 *   orders?: number,
 *   reason?: string,
 *   orderFilterApplied?: boolean,
 * }} ctx
 */
function resolveDashboardEmptyReason(ctx = {}) {
  if (ctx.reason) return String(ctx.reason);
  if (ctx.invalidShop) return 'shop_filter_no_match';
  const rows = Number(ctx.rows ?? ctx.points ?? ctx.orders ?? 0);
  if (rows > 0) return '';
  return 'no_orders_matched_filter';
}

/**
 * @param {string} endpoint
 * @param {import('./filterContract').DashboardFilterContract} contract
 * @param {{
 *   durationMs?: number,
 *   rows?: number,
 *   points?: number,
 *   orders?: number,
 *   invalidShop?: boolean,
 *   reason?: string,
 *   source?: string,
 *   sqlTag?: string,
 *   cache?: string,
 *   filterHash?: string,
 *   usedMarketField?: string,
 *   usedStatusField?: string,
 *   usedDateField?: string,
 *   matchedOrderCount?: number,
 * }} meta
 */
function logDashboardContractResult(endpoint, contract, meta = {}) {
  const rows =
    meta.rows != null
      ? Number(meta.rows)
      : meta.points != null
        ? Number(meta.points)
        : meta.orders != null
          ? Number(meta.orders)
          : undefined;
  let reason =
    rows === 0 || meta.invalidShop
      ? resolveDashboardEmptyReason({ ...meta, rows: rows ?? 0 })
      : '';
  if (
    !reason &&
    rows === 0 &&
    meta.matchedOrderCount != null &&
    Number(meta.matchedOrderCount) > 0
  ) {
    reason = 'sql_contract_mismatch_suspected';
  }

  const parts = [
    '[dashboard-contract]',
    `endpoint=${endpoint}`,
    `source=${meta.source || 'mysql'}`,
    `tenantId=${contract?.tenantId != null ? contract.tenantId : ''}`,
    `shopId=${contract?.shopId ?? 'all'}`,
    `market=${contract?.market ?? 'ALL'}`,
    `orderStatus=${contract?.orderFilter ?? 'all'}`,
    `timeRange=${contract?.timeRange ?? ''}`,
    `startDate=${contract?.startDate ?? ''}`,
    `endDate=${contract?.endDate ?? ''}`,
  ];
  if (meta.filterHash) parts.push(`filterHash=${meta.filterHash}`);
  if (meta.usedMarketField) parts.push(`usedMarketField=${meta.usedMarketField}`);
  if (meta.usedStatusField) parts.push(`usedStatusField=${meta.usedStatusField}`);
  if (meta.usedDateField) parts.push(`usedDateField=${meta.usedDateField}`);
  if (rows != null && Number.isFinite(rows)) parts.push(`rows=${rows}`);
  if (meta.durationMs != null) parts.push(`durationMs=${Math.floor(Number(meta.durationMs))}`);
  if (meta.sqlTag) parts.push(`sqlTag=${meta.sqlTag}`);
  if (meta.cache) parts.push(`cache=${meta.cache}`);
  if (meta.matchedOrderCount != null) parts.push(`matchedOrderCount=${meta.matchedOrderCount}`);
  if (reason) parts.push(`reason=${reason}`);
  console.log(parts.join(' '));

  return reason;
}

module.exports = { resolveDashboardEmptyReason, logDashboardContractResult };
