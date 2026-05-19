const dayjs = require('dayjs');

const BASE_CURRENCY = 'USD';
const CACHE_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_CURRENCIES = ['CNY', 'USD', 'THB', 'SGD', 'MYR', 'PHP', 'VND'];
const THB_USD = 0.0275;
const USD_THB = 1 / THB_USD;
const FALLBACK_RATES = {
  THB_CNY: 0.198,
  THB_USD: THB_USD,
  THB_SGD: 0.0368,
  THB_MYR: 0.129,
  THB_PHP: 1.55,
  THB_VND: 705,
  THB_THB: 1,
  USD_USD: 1,
  USD_THB: USD_THB,
  USD_CNY: USD_THB * 0.198,
  USD_SGD: USD_THB * 0.0368,
  USD_MYR: USD_THB * 0.129,
  USD_PHP: USD_THB * 1.55,
  USD_VND: USD_THB * 705,
};

const exchangeRateCache = new Map();

function safeAmount(value, digits = 2, defaultValue = 0) {
  if (!Number.isFinite(value)) return defaultValue;
  return Number(value.toFixed(digits));
}

function normalizeTargetCurrency(value) {
  const target = (value || 'USD').toUpperCase();
  return SUPPORTED_CURRENCIES.includes(target) ? target : 'USD';
}

function normalizeBaseCurrency(value) {
  const base = (value || BASE_CURRENCY).toUpperCase();
  return SUPPORTED_CURRENCIES.includes(base) ? base : BASE_CURRENCY;
}

async function fetchFrankfurterRate(base, target) {
  const url = `https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${target}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Frankfurter HTTP ${response.status}`);
    }
    const payload = await response.json();
    const rate = payload?.rates?.[target];
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('Invalid rate payload');
    }
    return rate;
  } finally {
    clearTimeout(timer);
  }
}

async function getEffectiveRate(base, target, forceRefresh = false) {
  const key = `${base}_${target}`;
  const now = Date.now();
  const cached = exchangeRateCache.get(key);

  if (base === target) {
    const fixed = {
      baseCurrency: base,
      targetCurrency: target,
      rate: 1,
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      source: 'fixed',
      status: 'normal',
      fetchedAt: now,
      successRate: 1,
    };
    exchangeRateCache.set(key, fixed);
    return fixed;
  }

  if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      baseCurrency: base,
      targetCurrency: target,
      rate: cached.rate,
      updatedAt: cached.updatedAt,
      source: cached.source,
      status: cached.status,
      fetchedAt: cached.fetchedAt,
      successRate: cached.successRate ?? cached.rate,
    };
  }

  try {
    const rate = await fetchFrankfurterRate(base, target);
    const nextRate = safeAmount(rate, 4, FALLBACK_RATES[key] ?? 0.198);
    const next = {
      baseCurrency: base,
      targetCurrency: target,
      rate: nextRate > 0 ? nextRate : FALLBACK_RATES[key] ?? 0.198,
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      source: 'frankfurter',
      status: 'normal',
      fetchedAt: now,
      successRate: nextRate > 0 ? nextRate : FALLBACK_RATES[key] ?? 0.198,
    };
    exchangeRateCache.set(key, next);
    return next;
  } catch (error) {
    const fallbackRate = cached?.successRate ?? FALLBACK_RATES[key] ?? 0.198;
    const fallback = {
      baseCurrency: base,
      targetCurrency: target,
      rate: safeAmount(fallbackRate, 4, 0.198) || 0.198,
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      source: 'fallback',
      status: 'warning',
      fetchedAt: now,
      successRate: cached?.successRate ?? FALLBACK_RATES[key] ?? 0.198,
    };
    exchangeRateCache.set(key, fallback);
    return fallback;
  }
}

function getFallbackRate(base, target) {
  if (base === target) return 1;
  const directKey = `${base}_${target}`;
  if (Number.isFinite(FALLBACK_RATES[directKey]) && FALLBACK_RATES[directKey] > 0) {
    return FALLBACK_RATES[directKey];
  }

  const baseRate =
    base === BASE_CURRENCY ? 1 : Number(FALLBACK_RATES[`${BASE_CURRENCY}_${base}`] || 0);
  const targetRate =
    target === BASE_CURRENCY ? 1 : Number(FALLBACK_RATES[`${BASE_CURRENCY}_${target}`] || 0);

  if (baseRate > 0 && targetRate > 0) {
    return targetRate / baseRate;
  }
  return 0.198;
}

async function getConversionRate(base, target, forceRefresh = false) {
  if (base === target) {
    return {
      baseCurrency: base,
      targetCurrency: target,
      rate: 1,
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      source: 'fixed',
      status: 'normal',
    };
  }

  const direct = await getEffectiveRate(base, target, forceRefresh);
  if (direct.status === 'normal' && direct.rate > 0) return direct;

  const thbToBase = await getEffectiveRate(BASE_CURRENCY, base, forceRefresh);
  const thbToTarget = await getEffectiveRate(BASE_CURRENCY, target, forceRefresh);
  if (thbToBase.rate > 0 && thbToTarget.rate > 0) {
    return {
      baseCurrency: base,
      targetCurrency: target,
      rate: safeAmount(thbToTarget.rate / thbToBase.rate, 4, getFallbackRate(base, target)),
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      source: 'derived',
      status: thbToBase.status === 'normal' && thbToTarget.status === 'normal' ? 'normal' : 'warning',
    };
  }

  return {
    baseCurrency: base,
    targetCurrency: target,
    rate: safeAmount(getFallbackRate(base, target), 4, 0.198),
    updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    source: 'fallback',
    status: 'warning',
  };
}

module.exports = {
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
  safeAmount,
  normalizeBaseCurrency,
  normalizeTargetCurrency,
  getConversionRate,
  getFallbackRate,
};
