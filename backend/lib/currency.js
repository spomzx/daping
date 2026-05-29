'use strict';

const exchangeRateService = require('../modules/exchangeRateService');

/** TikTok 市场代码 → ISO 4217 */
const MARKET_TO_CURRENCY = Object.freeze({
  TH: 'THB',
  MY: 'MYR',
  PH: 'PHP',
  VN: 'VND',
  SG: 'SGD',
});

const ISO_SET = new Set(exchangeRateService.SUPPORTED_CURRENCIES);

function getCurrencyByMarket(market) {
  const m = String(market || '')
    .trim()
    .toUpperCase();
  if (!m) return null;
  if (MARKET_TO_CURRENCY[m]) return MARKET_TO_CURRENCY[m];
  if (m.length >= 2) {
    const two = m.slice(0, 2);
    if (MARKET_TO_CURRENCY[two]) return MARKET_TO_CURRENCY[two];
  }
  return null;
}

function normalizeCurrency(code) {
  const raw = String(code || '')
    .trim()
    .toUpperCase();
  if (!raw) return null;
  if (ISO_SET.has(raw)) return raw;
  if (MARKET_TO_CURRENCY[raw]) return MARKET_TO_CURRENCY[raw];
  if (raw.length >= 2) {
    const two = raw.slice(0, 2);
    if (MARKET_TO_CURRENCY[two]) return MARKET_TO_CURRENCY[two];
  }
  return null;
}

function inferOrderCurrency(order) {
  if (!order || typeof order !== 'object') return null;
  const pay = order.payment || order.payment_info || {};
  const line0 = Array.isArray(order.line_items)
    ? order.line_items[0]
    : Array.isArray(order.order_line_list)
      ? order.order_line_list[0]
      : null;
  const fromFields = normalizeCurrency(
    order.currency || order.currency_code || pay.currency || line0?.currency || line0?.currency_code,
  );
  if (fromFields) return fromFields;
  const mk = getCurrencyByMarket(order.market || order.region || order.shopRegion || order.shop?.market || order.shop?.region);
  return mk || null;
}

/**
 * 1 USD = rate units of `currency`（与 exchange_rates 表 USD→X 一致）
 */
async function getUsdRate(currency, forceRefresh = false) {
  const cur = normalizeCurrency(currency);
  if (!cur) {
    throw new exchangeRateService.MissingExchangeRateError(String(currency || 'UNKNOWN'));
  }
  if (forceRefresh) await exchangeRateService.refreshRatesFromDb();
  return exchangeRateService.getUsdUnitsPerDollar(cur);
}

function getUsdRateSync(currency) {
  const cur = normalizeCurrency(currency);
  if (!cur) return 0;
  const r = exchangeRateService.getUsdUnitsPerDollarSync(cur);
  return r > 0 ? r : 0;
}

async function convertToUSD(amount, currency, opts = {}) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return 0;
  const rate = opts.usdRate != null && opts.usdRate > 0 ? opts.usdRate : await getUsdRate(currency);
  if (!(rate > 0)) {
    throw new exchangeRateService.MissingExchangeRateError(normalizeCurrency(currency) || String(currency));
  }
  return a / rate;
}

function convertToUSDSync(amount, currency, usdRate) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return 0;
  const rate = usdRate != null && usdRate > 0 ? usdRate : getUsdRateSync(currency);
  if (!(rate > 0)) return 0;
  return a / rate;
}

async function convertToCNY(amount, currency) {
  const usd = await convertToUSD(amount, currency);
  const cnyPerUsd = await getUsdRate('CNY');
  if (!(cnyPerUsd > 0)) {
    throw new exchangeRateService.MissingExchangeRateError('CNY');
  }
  return usd * cnyPerUsd;
}

function convertToCNYSync(amount, currency, usdRate, cnyPerUsd) {
  const usd = convertToUSDSync(amount, currency, usdRate);
  const c = cnyPerUsd != null && cnyPerUsd > 0 ? cnyPerUsd : getUsdRateSync('CNY');
  if (!(c > 0)) return 0;
  return usd * c;
}

async function normalizeOrderMoney(order, opts = {}) {
  const rawAmount = Number(
    order?.total_amount ??
      order?.amount ??
      order?.orderAmountBase ??
      order?.payment_amount ??
      order?.totalAmount ??
      order?.payment?.total_amount ??
      0,
  );
  let currency = inferOrderCurrency(order);
  if (!currency) {
    currency = 'USD';
  }
  const usdR = opts.usdRates?.[currency] ?? (await getUsdRate(currency));
  const usdAmount = usdR > 0 ? rawAmount / usdR : 0;
  const cnyP = opts.cnyPerUsd ?? (await getUsdRate('CNY'));
  const cnyAmount = cnyP > 0 ? usdAmount * cnyP : 0;
  return {
    rawAmount: Number.isFinite(rawAmount) ? rawAmount : 0,
    currency,
    usdAmount: Number.isFinite(usdAmount) ? usdAmount : 0,
    cnyAmount: Number.isFinite(cnyAmount) ? cnyAmount : 0,
  };
}

function normalizeOrderMoneySync(order, usdRates, cnyPerUsd) {
  const rawAmount = Number(
    order?.total_amount ??
      order?.amount ??
      order?.orderAmountBase ??
      order?.payment_amount ??
      order?.totalAmount ??
      order?.payment?.total_amount ??
      0,
  );
  let currency = inferOrderCurrency(order);
  if (!currency) {
    currency = 'USD';
  }
  const usdR = usdRates?.[currency] ?? getUsdRateSync(currency);
  const usdAmount = usdR > 0 ? rawAmount / usdR : 0;
  const cP = cnyPerUsd != null && cnyPerUsd > 0 ? cnyPerUsd : getUsdRateSync('CNY');
  const cnyAmount = cP > 0 ? usdAmount * cP : 0;
  return {
    rawAmount: Number.isFinite(rawAmount) ? rawAmount : 0,
    currency,
    usdAmount: Number.isFinite(usdAmount) ? usdAmount : 0,
    cnyAmount: Number.isFinite(cnyAmount) ? cnyAmount : 0,
  };
}

async function preloadUsdRates(currencies, forceRefresh = false, options = {}) {
  if (forceRefresh) await exchangeRateService.refreshRatesFromDb();
  return exchangeRateService.preloadUsdRates(currencies, options);
}

async function buildDashboardCurrencyRates(currencies, baseCurrency, targetCurrency) {
  const b = String(baseCurrency || 'USD').toUpperCase();
  const t = String(targetCurrency || 'USD').toUpperCase();
  const set = new Set([...currencies].map((x) => String(x || '').toUpperCase()).filter(Boolean));
  set.add(b);
  set.add(t);
  const out = {};
  await Promise.all(
    [...set].map(async (cur) => {
      const toBaseP = await exchangeRateService.getConversionRate(cur, b);
      const toTargetP = await exchangeRateService.getConversionRate(cur, t);
      const toBase = Number(toBaseP?.rate || 0);
      const toTarget = Number(toTargetP?.rate || 0);
      if (!(toBase > 0) || !(toTarget > 0)) {
        throw new exchangeRateService.MissingExchangeRateError(cur);
      }
      out[cur] = { toBase, toTarget };
    }),
  );
  return out;
}

module.exports = {
  MARKET_TO_CURRENCY,
  getCurrencyByMarket,
  normalizeCurrency,
  inferOrderCurrency,
  getUsdRate,
  getUsdRateSync,
  convertToUSD,
  convertToUSDSync,
  convertToCNY,
  convertToCNYSync,
  normalizeOrderMoney,
  normalizeOrderMoneySync,
  preloadUsdRates,
  buildDashboardCurrencyRates,
};
