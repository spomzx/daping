'use strict';

const { getConversionRate, getFallbackRate, BASE_CURRENCY } = require('./rates');

/** TikTok 市场代码 → ISO 4217 */
const MARKET_TO_CURRENCY = Object.freeze({
  TH: 'THB',
  MY: 'MYR',
  PH: 'PHP',
  VN: 'VND',
  SG: 'SGD',
});

const ISO_SET = new Set(['THB', 'MYR', 'PHP', 'VND', 'SGD', 'USD', 'CNY']);

function currencyLog(kind, detail, extra) {
  const rest = extra !== undefined ? ` ${JSON.stringify(extra)}` : '';
  if (kind === 'fallback') {
    if (String(process.env.CURRENCY_LOG_LEVEL || '').toLowerCase() === 'debug') {
      console.log(`[currency] ${kind}: ${detail}${rest}`);
    }
    return;
  }
  if (kind === 'invalid') {
    console.warn(`[currency] ${kind}: ${detail}${rest}`);
    return;
  }
  console.warn(`[currency] ${kind}: ${detail}${rest}`);
}

/**
 * @param {string} [market]
 * @returns {string|null}
 */
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

/**
 * @param {string} [code]
 * @returns {string|null} ISO 4217 or null
 */
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

/**
 * @param {Record<string, unknown>} order
 * @returns {string|null}
 */
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
 * 1 USD = rate units of `currency`（与 Frankfurter base=USD&symbols=X 一致）
 * @param {string} currency ISO 4217
 * @param {boolean} [forceRefresh]
 * @returns {Promise<number>}
 */
async function getUsdRate(currency, forceRefresh = false) {
  const cur = normalizeCurrency(currency);
  if (!cur) {
    currencyLog('invalid', 'getUsdRate: unknown currency', { currency });
    return 0;
  }
  if (cur === 'USD') return 1;
  const p = await getConversionRate(BASE_CURRENCY, cur, forceRefresh);
  let r = Number(p?.rate || 0);
  if (!Number.isFinite(r) || r <= 0) {
    r = Number(getFallbackRate(BASE_CURRENCY, cur) || 0);
    currencyLog('fallback', `getUsdRate(${cur})`, { rate: r });
  }
  return r > 0 ? r : 0;
}

/**
 * @param {string} currency
 * @returns {number}
 */
function getUsdRateSync(currency) {
  const cur = normalizeCurrency(currency);
  if (!cur) return 0;
  if (cur === 'USD') return 1;
  const r = Number(getFallbackRate(BASE_CURRENCY, cur) || 0);
  if (!(r > 0)) currencyLog('fallback', `getUsdRateSync(${cur})`);
  return r > 0 ? r : 0;
}

/**
 * 原币种金额 → USD（usd = amount / rate, rate 为 1 USD 兑多少原币）
 * @param {number} amount
 * @param {string} currency
 * @param {{ usdRate?: number }} [opts]
 */
async function convertToUSD(amount, currency, opts = {}) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return 0;
  const rate = opts.usdRate != null && opts.usdRate > 0 ? opts.usdRate : await getUsdRate(currency);
  if (!(rate > 0)) return 0;
  return a / rate;
}

function convertToUSDSync(amount, currency, usdRate) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return 0;
  const rate = usdRate != null && usdRate > 0 ? usdRate : getUsdRateSync(currency);
  if (!(rate > 0)) return 0;
  return a / rate;
}

/**
 * 任意币种金额 → CNY（经 USD 桥接）
 * @param {number} amount
 * @param {string} currency
 */
async function convertToCNY(amount, currency) {
  const usd = await convertToUSD(amount, currency);
  const cnyPerUsd = await getUsdRate('CNY');
  if (!(cnyPerUsd > 0)) return 0;
  return usd * cnyPerUsd;
}

function convertToCNYSync(amount, currency, usdRate, cnyPerUsd) {
  const usd = convertToUSDSync(amount, currency, usdRate);
  const c = cnyPerUsd != null && cnyPerUsd > 0 ? cnyPerUsd : getUsdRateSync('CNY');
  if (!(c > 0)) return 0;
  return usd * c;
}

/**
 * @param {Record<string, unknown>} order
 * @param {{ usdRates?: Record<string, number>, cnyPerUsd?: number }} [opts]
 * @returns {Promise<{ rawAmount: number, currency: string, usdAmount: number, cnyAmount: number }>}
 */
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
    currencyLog('invalid', 'normalizeOrderMoney: missing currency', { orderId: order?.orderId || order?.id });
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

/**
 * @param {Iterable<string>} currencies
 * @param {boolean} [forceRefresh]
 * @returns {Promise<Record<string, number>>}
 */
async function preloadUsdRates(currencies, forceRefresh = false) {
  const set = new Set();
  for (const c of currencies) {
    const n = normalizeCurrency(c);
    if (n) set.add(n);
  }
  set.add('CNY');
  const out = {};
  await Promise.all(
    [...set].map(async (cur) => {
      out[cur] = await getUsdRate(cur, forceRefresh);
    }),
  );
  return out;
}

/**
 * 大屏 / 缓存订单：各币种 → base / target 的乘数（金额_base = 原币 * toBase）
 * @param {Iterable<string>} currencies
 * @param {string} baseCurrency
 * @param {string} targetCurrency
 */
async function buildDashboardCurrencyRates(currencies, baseCurrency, targetCurrency) {
  const b = String(baseCurrency || 'USD').toUpperCase();
  const t = String(targetCurrency || 'USD').toUpperCase();
  const set = new Set([...currencies].map((x) => String(x || '').toUpperCase()).filter(Boolean));
  set.add(b);
  set.add(t);
  const out = {};
  await Promise.all(
    [...set].map(async (cur) => {
      const toBaseP = await getConversionRate(cur, b, false);
      const toTargetP = await getConversionRate(cur, t, false);
      let toBase = Number(toBaseP?.rate || 0);
      let toTarget = Number(toTargetP?.rate || 0);
      if (!(toBase > 0)) {
        toBase = Number(getFallbackRate(cur, b) || 0);
        currencyLog('fallback', `buildDashboardCurrencyRates toBase ${cur}->${b}`, { toBase });
      }
      if (!(toTarget > 0)) {
        toTarget = Number(getFallbackRate(cur, t) || 0);
        currencyLog('fallback', `buildDashboardCurrencyRates toTarget ${cur}->${t}`, { toTarget });
      }
      out[cur] = { toBase: toBase > 0 ? toBase : 1, toTarget: toTarget > 0 ? toTarget : 1 };
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
