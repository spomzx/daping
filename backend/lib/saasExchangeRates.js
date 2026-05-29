'use strict';

const {
  normalizeBaseCurrency,
  normalizeTargetCurrency,
  getPairRate,
  refreshRatesFromDb,
  MissingExchangeRateError,
} = require('../modules/exchangeRateService');
const { buildDashboardCurrencyRates } = require('./currency');

/**
 * 从 exchange_rates 表取最新汇率（唯一来源）
 * @param {import('mysql2/promise').Pool|null} pool
 * @param {string} base
 * @param {string} target
 */
async function getLatestRateFromMysql(pool, base, target) {
  const b = normalizeBaseCurrency(base);
  const t = normalizeTargetCurrency(target);
  if (b === t) return 1;
  if (pool) await refreshRatesFromDb(pool);
  return getPairRate(b, t);
}

/**
 * SaaS 分析/对比用汇率上下文（仅 MySQL exchange_rates）
 * @param {import('mysql2/promise').Pool|null} pool
 * @param {{ baseCurrency?: string, targetCurrency?: string }} q
 */
async function buildSaaSFxContext(pool, q = {}) {
  const baseCurrency = normalizeBaseCurrency(q.baseCurrency);
  const targetCurrency = normalizeTargetCurrency(q.targetCurrency);
  const currencySet = new Set([baseCurrency, targetCurrency]);

  if (pool) await refreshRatesFromDb(pool);

  let exchangeRate = 1;
  if (baseCurrency !== targetCurrency) {
    exchangeRate = await getLatestRateFromMysql(pool, baseCurrency, targetCurrency);
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      throw new MissingExchangeRateError([baseCurrency, targetCurrency].join('->'));
    }
  }

  const currencyRates = await buildDashboardCurrencyRates(currencySet, baseCurrency, targetCurrency);
  return {
    baseCurrency,
    targetCurrency,
    exchangeRate,
    currencyRates,
    rateSource: 'mysql',
  };
}

module.exports = { getLatestRateFromMysql, buildSaaSFxContext };
