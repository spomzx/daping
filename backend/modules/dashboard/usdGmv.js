'use strict';

/**
 * Dashboard 统一 GMV 口径：按币种聚合原币后 convertToUSDSync → USD。
 * 禁止跨币种直接 SUM(total_amount) 作为 GMV。
 */

const {
  DEFAULT_CURRENCIES,
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  sumNativeGroupsToUsd,
  nativeAmountToUsd,
} = require('./gmvUsdConvert');

/**
 * 契约时间窗内订单 GMV（USD）+ 订单数；WHERE 仅 buildDashboardWhere。
 * 延迟加载 summaryQuery，避免与 todayMetricsQuery 循环依赖。
 */
async function queryDashboardGmvUsd(pool, tenantId, contract, fo, window = null, slowCtx = null) {
  const { queryDashboardSummaryAggregates } = require('./summaryQuery');
  return queryDashboardSummaryAggregates(pool, tenantId, contract, fo, window, slowCtx);
}

module.exports = {
  DEFAULT_CURRENCIES,
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  sumNativeGroupsToUsd,
  nativeAmountToUsd,
  queryDashboardGmvUsd,
};
