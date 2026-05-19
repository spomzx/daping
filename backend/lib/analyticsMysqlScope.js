'use strict';

/**
 * Analytics MySQL：市场筛选（与 `buildAnalyticsFilter` 组合使用）。
 * - 仅 orders 表：用 marketClauseOrdersOnly
 * - orders + order_items JOIN：用 marketClauseOrdersJoinLineItems
 */

/** @param {string} alias 表别名，如 o */
function marketClauseOrdersOnly(alias, market) {
  const m = String(market || '').trim().toUpperCase();
  if (!m || m === 'ALL') return { sql: '', params: [] };
  return {
    sql: ` AND UPPER(COALESCE(NULLIF(TRIM(${alias}.market), ''), '')) = ? `,
    params: [m],
  };
}

/** @param {string} orderAlias @param {string} lineItemAlias */
function marketClauseOrdersJoinLineItems(orderAlias, lineItemAlias, market) {
  const m = String(market || '').trim().toUpperCase();
  if (!m || m === 'ALL') return { sql: '', params: [] };
  return {
    sql: ` AND UPPER(COALESCE(${orderAlias}.market, ${lineItemAlias}.market, '')) = ? `,
    params: [m],
  };
}

module.exports = {
  marketClauseOrdersOnly,
  marketClauseOrdersJoinLineItems,
};
