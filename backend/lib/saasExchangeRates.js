'use strict';

const { normalizeBaseCurrency, normalizeTargetCurrency, getConversionRate, getFallbackRate } = require('./rates');
const { buildDashboardCurrencyRates } = require('./currency');

/**
 * 从 exchange_rates 表取最新汇率（SaaS 主路径，不读 gmv-cache.json）
 * @param {import('mysql2/promise').Pool|null} pool
 * @param {string} base
 * @param {string} target
 */
async function getLatestRateFromMysql(pool, base, target) {
  const b = normalizeBaseCurrency(base);
  const t = normalizeTargetCurrency(target);
  if (b === t) return 1;
  if (!pool) return 0;
  try {
    const [rows] = await pool.query(
      `SELECT rate FROM exchange_rates
       WHERE base_currency = ? AND target_currency = ?
       ORDER BY effective_at DESC, id DESC
       LIMIT 1`,
      [b, t],
    );
    const rate = Number(rows?.[0]?.rate);
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  } catch (e) {
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || String(e.message || '').includes('exchange_rates'))) {
      return 0;
    }
    throw e;
  }
}

/**
 * SaaS 分析/对比用汇率上下文（MySQL → 实时 API → 内置 fallback，不读 gmv-cache）
 * @param {import('mysql2/promise').Pool|null} pool
 * @param {{ baseCurrency?: string, targetCurrency?: string }} q
 */
async function buildSaaSFxContext(pool, q = {}) {
  const baseCurrency = normalizeBaseCurrency(q.baseCurrency);
  const targetCurrency = normalizeTargetCurrency(q.targetCurrency);
  const currencySet = new Set([baseCurrency, targetCurrency]);

  let exchangeRate = 0;
  if (baseCurrency === targetCurrency) {
    exchangeRate = 1;
  } else {
    exchangeRate = await getLatestRateFromMysql(pool, baseCurrency, targetCurrency);
    if (!exchangeRate) {
      const ratePayload = await getConversionRate(baseCurrency, targetCurrency, false);
      const liveRate = Number(ratePayload?.rate || 0);
      if (Number.isFinite(liveRate) && liveRate > 0) {
        exchangeRate = liveRate;
      }
    }
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      exchangeRate = Number(getFallbackRate(baseCurrency, targetCurrency) || 0);
    }
    if (baseCurrency !== targetCurrency && (!Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
      exchangeRate = Number(getFallbackRate(baseCurrency, targetCurrency) || 0.198);
    }
  }

  const currencyRates = await buildDashboardCurrencyRates(currencySet, baseCurrency, targetCurrency);
  return {
    baseCurrency,
    targetCurrency,
    exchangeRate,
    currencyRates,
    rateSource: exchangeRate === 1 ? 'fixed' : 'mysql_or_live',
  };
}

module.exports = { getLatestRateFromMysql, buildSaaSFxContext };
