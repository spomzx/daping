'use strict';

const { getMysqlPool } = require('../db/mysqlPool');

const BASE_CURRENCY = 'USD';
const SUPPORTED_CURRENCIES = ['USD', 'THB', 'MYR', 'PHP', 'VND', 'SGD', 'CNY', 'IDR'];
const REQUIRED_USD_PAIRS = ['THB', 'MYR', 'PHP', 'VND', 'SGD'];

/** @type {Map<string, { rate: number, source: string|null, effective_at: Date|null, updated_at: Date|null }>} */
let pairCache = new Map();
let cacheLoadedAt = 0;

class MissingExchangeRateError extends Error {
  /**
   * @param {string|string[]} currency
   */
  constructor(currency) {
    const list = Array.isArray(currency) ? currency : [currency];
    const label = list.filter(Boolean).join(', ') || 'UNKNOWN';
    super(`缺少 ${label} 汇率，请先维护 exchange_rates 表`);
    this.name = 'MissingExchangeRateError';
    this.code = 'MISSING_EXCHANGE_RATE';
    this.currency = list.length === 1 ? list[0] : label;
    this.missingCurrencies = list;
  }
}

function normalizeCurrency(code) {
  const raw = String(code || '')
    .trim()
    .toUpperCase();
  if (!raw) return null;
  if (SUPPORTED_CURRENCIES.includes(raw)) return raw;
  const marketMap = { TH: 'THB', MY: 'MYR', PH: 'PHP', VN: 'VND', SG: 'SGD' };
  if (marketMap[raw]) return marketMap[raw];
  return null;
}

function normalizeBaseCurrency(value) {
  const base = normalizeCurrency(value) || BASE_CURRENCY;
  return base === BASE_CURRENCY ? base : BASE_CURRENCY;
}

function normalizeTargetCurrency(value) {
  const target = normalizeCurrency(value) || BASE_CURRENCY;
  return SUPPORTED_CURRENCIES.includes(target) ? target : BASE_CURRENCY;
}

function pairKey(base, target) {
  return `${String(base).toUpperCase()}_${String(target).toUpperCase()}`;
}

/**
 * @param {import('mysql2/promise').Pool|null} [pool]
 */
async function refreshRatesFromDb(pool = null) {
  const p = pool || getMysqlPool();
  if (!p) {
    pairCache = new Map();
    cacheLoadedAt = Date.now();
    return [];
  }
  const [rows] = await p.query(
    `SELECT r.base_currency, r.target_currency, r.rate, r.source, r.effective_at, r.updated_at
     FROM exchange_rates r
     INNER JOIN (
       SELECT base_currency, target_currency, MAX(id) AS max_id
       FROM exchange_rates
       GROUP BY base_currency, target_currency
     ) latest ON r.id = latest.max_id`,
  );
  const next = new Map();
  for (const row of rows || []) {
    const base = String(row.base_currency || '').toUpperCase();
    const target = String(row.target_currency || '').toUpperCase();
    const rate = Number(row.rate);
    if (!base || !target || !(rate > 0)) continue;
    next.set(pairKey(base, target), {
      rate,
      source: row.source != null ? String(row.source) : null,
      effective_at: row.effective_at || null,
      updated_at: row.updated_at || null,
    });
  }
  pairCache = next;
  cacheLoadedAt = Date.now();
  return listRates();
}

async function listRates() {
  if (!pairCache.size) {
    await refreshRatesFromDb();
  }
  return [...pairCache.entries()].map(([key, v]) => {
    const [base_currency, target_currency] = key.split('_');
    return {
      base_currency,
      target_currency,
      rate: v.rate,
      source: v.source,
      effective_at: v.effective_at,
      updated_at: v.updated_at,
    };
  });
}

/**
 * 1 base = rate target（与表内 rate 字段一致）
 * @param {string} baseCurrency
 * @param {string} targetCurrency
 */
async function getPairRate(baseCurrency, targetCurrency) {
  const base = normalizeCurrency(baseCurrency) || BASE_CURRENCY;
  const target = normalizeCurrency(targetCurrency);
  if (!target) throw new MissingExchangeRateError(String(targetCurrency || 'UNKNOWN'));
  if (base === target) return 1;
  if (!pairCache.size) await refreshRatesFromDb();
  const hit = pairCache.get(pairKey(base, target));
  if (!hit || !(hit.rate > 0)) {
    throw new MissingExchangeRateError(target);
  }
  return hit.rate;
}

/**
 * 1 USD = N 单位外币（用于 amount_usd = amount_foreign / N）
 * @param {string} currency
 */
async function getUsdUnitsPerDollar(currency) {
  const cur = normalizeCurrency(currency);
  if (!cur) throw new MissingExchangeRateError(String(currency || 'UNKNOWN'));
  if (cur === 'USD') return 1;
  return getPairRate(BASE_CURRENCY, cur);
}

/**
 * 外币 → USD 乘数（amount_usd = amount * getRateToUsd）
 * @param {string} currency
 */
async function getRateToUsd(currency) {
  const units = await getUsdUnitsPerDollar(currency);
  return 1 / units;
}

/**
 * amount_target = amount_base * rate
 * @param {string} from
 * @param {string} to
 */
async function getConversionRate(from, to) {
  const baseCur = normalizeCurrency(from);
  const targetCur = normalizeCurrency(to);
  if (!baseCur || !targetCur) {
    throw new MissingExchangeRateError([from, to].filter(Boolean).join('->'));
  }
  if (baseCur === targetCur) {
    return {
      baseCurrency: baseCur,
      targetCurrency: targetCur,
      rate: 1,
      updatedAt: new Date().toISOString(),
      source: 'mysql',
      status: 'normal',
    };
  }
  const fromPerUsd = await getUsdUnitsPerDollar(baseCur);
  const toPerUsd = await getUsdUnitsPerDollar(targetCur);
  const rate = toPerUsd / fromPerUsd;
  if (!(rate > 0)) throw new MissingExchangeRateError(targetCur);
  const row = pairCache.get(pairKey(BASE_CURRENCY, targetCur)) || pairCache.get(pairKey(BASE_CURRENCY, baseCur));
  return {
    baseCurrency: baseCur,
    targetCurrency: targetCur,
    rate,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    source: 'mysql',
    status: 'normal',
  };
}

/**
 * @param {Iterable<string>} currencies
 * @returns {Promise<Record<string, number>>} 1 USD = rates[cur] units of cur
 */
/**
 * @param {Iterable<string>} currencies
 * @param {{ lenient?: boolean }} [options]
 */
async function preloadUsdRates(currencies, options = {}) {
  const lenient = options.lenient === true;
  if (!pairCache.size) await refreshRatesFromDb();
  const set = new Set();
  for (const c of currencies) {
    const n = normalizeCurrency(c);
    if (n) set.add(n);
  }
  set.add('USD');
  const out = {};
  const missing = [];
  for (const cur of set) {
    if (cur === 'USD') {
      out[cur] = 1;
      continue;
    }
    try {
      out[cur] = await getUsdUnitsPerDollar(cur);
    } catch {
      const sync = getUsdUnitsPerDollarSync(cur);
      if (sync > 0) {
        out[cur] = sync;
        continue;
      }
      missing.push(cur);
    }
  }
  if (missing.length && !lenient) {
    throw new MissingExchangeRateError(missing);
  }
  return out;
}

function getUsdUnitsPerDollarSync(currency) {
  const cur = normalizeCurrency(currency);
  if (!cur) return 0;
  if (cur === 'USD') return 1;
  const hit = pairCache.get(pairKey(BASE_CURRENCY, cur));
  return hit && hit.rate > 0 ? hit.rate : 0;
}

async function getHealth(pool = null) {
  const rates = await refreshRatesFromDb(pool);
  const supported = new Set(['USD']);
  let lastUpdated = null;
  for (const r of rates) {
    if (r.base_currency === BASE_CURRENCY && r.target_currency) {
      supported.add(r.target_currency);
    }
    const ts = r.updated_at || r.effective_at;
    if (ts && (!lastUpdated || new Date(ts) > new Date(lastUpdated))) {
      lastUpdated = ts;
    }
  }
  const missing_currencies = REQUIRED_USD_PAIRS.filter((c) => !supported.has(c));
  return {
    rates_count: rates.length,
    supported_currencies: [...supported].sort(),
    missing_currencies,
    last_updated_at: lastUpdated ? new Date(lastUpdated).toISOString() : null,
    source: 'mysql',
    cache_loaded_at: cacheLoadedAt ? new Date(cacheLoadedAt).toISOString() : null,
  };
}

/**
 * @param {import('express').Response} res
 * @param {unknown} e
 */
function mapExchangeRateHttpError(res, e) {
  if (e instanceof MissingExchangeRateError || e?.code === 'MISSING_EXCHANGE_RATE') {
    return res.status(503).json({
      error: 'MISSING_EXCHANGE_RATE',
      message: e.message || '缺少汇率，请先维护 exchange_rates 表',
      currency: e.currency,
      missing_currencies: e.missingCurrencies || [],
    });
  }
  return null;
}

module.exports = {
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
  REQUIRED_USD_PAIRS,
  MissingExchangeRateError,
  normalizeCurrency,
  normalizeBaseCurrency,
  normalizeTargetCurrency,
  refreshRatesFromDb,
  listRates,
  getPairRate,
  getUsdUnitsPerDollar,
  getUsdUnitsPerDollarSync,
  getRateToUsd,
  getConversionRate,
  preloadUsdRates,
  getHealth,
  mapExchangeRateHttpError,
};
