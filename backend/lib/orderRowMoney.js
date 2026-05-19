'use strict';

const {
  normalizeCurrency,
  getCurrencyByMarket,
  convertToUSDSync,
  getUsdRateSync,
  preloadUsdRates,
} = require('./currency');

/**
 * @param {Record<string, unknown>} row
 */
function resolveOrderCurrency(row) {
  const raw = String(row.currency ?? row.currency_key ?? row.line_currency ?? '').trim();
  const cur = normalizeCurrency(raw);
  if (cur) return cur;
  return getCurrencyByMarket(String(row.market ?? '')) || 'USD';
}

/**
 * @param {Record<string, unknown>} row
 */
function pickOrderAmount(row) {
  const v =
    row.total_amount ??
    row.amount ??
    row.order_amount ??
    row.payment_amount ??
    row.original_amount ??
    row.orderAmountBase ??
    0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {number} amount
 * @param {string} currency
 * @param {Record<string, number>} [rates]
 * @returns {{ usd: number|null, usd_pending: boolean, exchange_rate: number|null }}
 */
function amountToUsdWithStatus(amount, currency, rates = {}) {
  const cur = normalizeCurrency(currency) || 'USD';
  const raw = Number(amount);
  if (!Number.isFinite(raw)) {
    return { usd: null, usd_pending: true, exchange_rate: null };
  }
  if (cur === 'USD') {
    return { usd: raw, usd_pending: false, exchange_rate: 1 };
  }
  const rate = rates[cur] > 0 ? rates[cur] : getUsdRateSync(cur);
  if (!(rate > 0)) {
    return { usd: null, usd_pending: true, exchange_rate: null };
  }
  const usd = convertToUSDSync(raw, cur, rate);
  return {
    usd: Number.isFinite(usd) ? Number(usd.toFixed(2)) : null,
    usd_pending: false,
    exchange_rate: rate,
  };
}

/** @deprecated 使用 amountToUsdWithStatus */
function amountToUsd(amount, currency, rates = {}) {
  const r = amountToUsdWithStatus(amount, currency, rates);
  return r.usd_pending ? 0 : Number(r.usd) || 0;
}

module.exports = {
  resolveOrderCurrency,
  pickOrderAmount,
  amountToUsd,
  amountToUsdWithStatus,
  preloadUsdRates,
};
