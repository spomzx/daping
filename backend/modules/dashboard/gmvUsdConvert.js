'use strict';

/**
 * Dashboard GMV 原币 → USD 换算（纯函数，无 dashboard 查询依赖）。
 * todayMetricsQuery / rankingQuery / summaryQuery 共用，禁止 require summaryQuery。
 */

const {
  normalizeCurrency,
  getCurrencyByMarket,
  convertToUSDSync,
  preloadUsdRates,
} = require('../../lib/currency');

const DEFAULT_CURRENCIES = ['USD', 'THB', 'MYR', 'VND', 'PHP', 'IDR', 'SGD', 'CNY'];

/** KPI GMV 唯一舍入契约：先累加 raw USD，再一次 round 到 2 位 */
const KPI_GMV_ROUNDING_CONTRACT = 'ROUND(SUM(raw_usd_amount), 2)';

/**
 * @param {number} rawUsd
 */
function roundKpiGmvUsd(rawUsd) {
  const n = Number(rawUsd);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Number(n.toFixed(2));
}

/**
 * @param {string} lineCurrency
 * @param {string} [market]
 */
function resolveDashboardCurrency(lineCurrency, market) {
  return (
    normalizeCurrency(String(lineCurrency || '').trim()) ||
    getCurrencyByMarket(String(market || '')) ||
    'USD'
  );
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {(row: Record<string, unknown>) => string} pickCurrency
 */
async function preloadRatesForCurrencyRows(rows, pickCurrency) {
  const set = new Set();
  for (const row of rows) {
    const cur = pickCurrency(row);
    if (cur) set.add(cur);
  }
  const list = [...set];
  try {
    return await preloadUsdRates(list.length ? list : DEFAULT_CURRENCIES);
  } catch (e) {
    if (e?.code !== 'MISSING_EXCHANGE_RATE') throw e;
    return preloadUsdRates(list.length ? list : DEFAULT_CURRENCIES, false, { lenient: true });
  }
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, number>} rates
 * @param {(row: Record<string, unknown>) => number} pickNative
 * @param {(row: Record<string, unknown>) => string} pickCurrency
 */
function sumNativeGroupsToUsdRaw(rows, rates, pickNative, pickCurrency) {
  let total = 0;
  for (const row of rows) {
    const cur = pickCurrency(row);
    const native = Number(pickNative(row)) || 0;
    total += convertToUSDSync(native, cur, rates[cur]);
  }
  return total;
}

function sumNativeGroupsToUsd(rows, rates, pickNative, pickCurrency) {
  return roundKpiGmvUsd(sumNativeGroupsToUsdRaw(rows, rates, pickNative, pickCurrency));
}

/**
 * @param {number} nativeAmount
 * @param {string} currency
 * @param {Record<string, number>} rates
 */
function nativeAmountToUsd(nativeAmount, currency, rates) {
  const cur = normalizeCurrency(currency) || 'USD';
  return convertToUSDSync(Number(nativeAmount) || 0, cur, rates[cur]);
}

const pickGmvRowNative = (row) => Number(row.gmv_native) || 0;
const pickGmvRowCurrency = (row) =>
  resolveDashboardCurrency(row.line_currency, row.market);

/**
 * 租户级 KPI GMV：ROUND(SUM(raw_usd))，与 trend kpi_totals 同口径（禁止 SUM(ROUND(shop))）。
 * @param {Record<string, unknown>[]} gmvRows
 */
async function rollupKpiGmvFromGmvRows(gmvRows) {
  const list = Array.isArray(gmvRows) ? gmvRows : [];
  const rates = await preloadRatesForCurrencyRows(list, pickGmvRowCurrency);
  const gmv_usd_raw_sum = sumNativeGroupsToUsdRaw(list, rates, pickGmvRowNative, pickGmvRowCurrency);
  const gmv_usd = roundKpiGmvUsd(gmv_usd_raw_sum);
  return {
    gmv_usd,
    gmv_usd_raw_sum,
    gmv_rounding_contract: KPI_GMV_ROUNDING_CONTRACT,
  };
}

module.exports = {
  KPI_GMV_ROUNDING_CONTRACT,
  DEFAULT_CURRENCIES,
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  sumNativeGroupsToUsdRaw,
  sumNativeGroupsToUsd,
  roundKpiGmvUsd,
  rollupKpiGmvFromGmvRows,
  nativeAmountToUsd,
};
