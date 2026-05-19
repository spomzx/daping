/**
 * 从 orders-cache.json 中的 Open API 订单结构聚合大屏 payload
 */
const dayjs = require('dayjs');
const {
  orderMatchesOrderFilter,
  normalizeOrderFilter,
  orderFilterExcludesGmv,
  orderIsSampleOrder,
  orderIsCancelledStatus,
} = require('../lib/orderFilter');
const { orderStatusToZh } = require('../lib/orderStatusZh');
const { getTimeRangeBounds, normalizeRange } = require('../lib/dashboardTimeRange');
const {
  inferOrderCurrency,
  normalizeCurrency,
  convertToUSDSync,
  convertToCNYSync,
} = require('../lib/currency');

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getTodayRangeByOffsetHours(offsetHours) {
  const nowUtcMs = Date.now();
  const shiftedNow = new Date(nowUtcMs + offsetHours * 3600 * 1000);
  const y = shiftedNow.getUTCFullYear();
  const m = shiftedNow.getUTCMonth();
  const d = shiftedNow.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0) - offsetHours * 3600 * 1000;
  return {
    startEpochSec: Math.floor(startUtcMs / 1000),
    endEpochSec: Math.floor(nowUtcMs / 1000),
  };
}

function regionToOffsetHours(region) {
  const r = String(region || '').trim().toUpperCase();
  if (r === 'TH' || r.includes('THAILAND')) return 7;
  return 8;
}

function parseOneTimeFieldToEpochSec(t) {
  if (t == null || t === '') return 0;
  const n = Number(t);
  if (Number.isFinite(n) && n > 0) {
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const ms = dayjs(String(t)).valueOf();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

/**
 * 订单创建时间（秒），用于时间范围过滤。优先创建时间字段，其次支付/更新时间。
 * 兼容顶层与 _raw 嵌套。
 */
function getCreateEpochSec(o) {
  if (!o || typeof o !== 'object') return 0;
  const raw = o._raw && typeof o._raw === 'object' ? o._raw : null;
  const tryKeys = (obj, keys) => {
    if (!obj) return 0;
    for (const k of keys) {
      const ep = parseOneTimeFieldToEpochSec(obj[k]);
      if (ep > 0) return ep;
    }
    return 0;
  };
  const createKeys = [
    'createTime',
    'create_time',
    'created_at',
    'order_create_time',
    'orderCreateTime',
    'create_time_epoch',
  ];
  let ep = tryKeys(o, createKeys);
  if (ep > 0) return ep;
  ep = tryKeys(raw, createKeys);
  if (ep > 0) return ep;
  const paidKeys = ['paidTime', 'paid_time', 'payment_time', 'paid_at'];
  ep = tryKeys(o, paidKeys);
  if (ep > 0) return ep;
  ep = tryKeys(raw, paidKeys);
  if (ep > 0) return ep;
  const updateKeys = ['update_time', 'updated_at', 'updateTime'];
  ep = tryKeys(o, updateKeys);
  if (ep > 0) return ep;
  ep = tryKeys(raw, updateKeys);
  return ep > 0 ? ep : 0;
}

/** 订单所属市场（与 filterOrdersByMarket 一致，兼容多字段） */
function orderMarketRegion(o) {
  if (!o || typeof o !== 'object') return '';
  const shop = o.shop;
  const fromShop = shop && typeof shop === 'object' ? shop.region || shop.market : '';
  const addr = o.recipient_address && typeof o.recipient_address === 'object' ? o.recipient_address.region_code : '';
  const raw = o.region || o.market || o.shopRegion || fromShop || addr || '';
  return String(raw || '').trim();
}

/**
 * 按市场过滤订单（全市场不过滤）
 * @param {Array} orders
 * @param {string} market - 'ALL' 或 TH/PH/MY/SG/VN 等
 */
function filterOrdersByMarket(orders, market) {
  if (!market || String(market).toUpperCase() === 'ALL') return orders;
  const m = String(market).toUpperCase();
  return orders.filter((o) => String(orderMarketRegion(o)).toUpperCase() === m);
}

/**
 * 与 dashboardShopGate / 大屏 shopId 筛选一致：从 cache 订单上取平台店铺 id（小写）。
 */
function orderCachePlatformShopId(o) {
  if (!o || typeof o !== 'object') return '';
  const candidates = [
    o.shopId,
    o.shop_id,
    o.platform_shop_id,
    o.shop && typeof o.shop === 'object' ? o.shop.shop_id : '',
    o.shop && typeof o.shop === 'object' ? o.shop.platform_shop_id : '',
    o._raw && typeof o._raw === 'object' ? o._raw.shop_id : '',
  ];
  for (const c of candidates) {
    const pid = String(c ?? '')
      .trim()
      .toLowerCase();
    if (pid) return pid;
  }
  return '';
}

function isOrderToday(o) {
  const ep = getCreateEpochSec(o);
  if (!ep) return true;
  const off = regionToOffsetHours(orderMarketRegion(o) || o?.region);
  const { startEpochSec, endEpochSec } = getTodayRangeByOffsetHours(off);
  return ep >= startEpochSec && ep <= endEpochSec;
}

function orderAmountRaw(o) {
  return safeNum(o?.totalAmount ?? o?.orderAmountBase ?? o?.order_amount ?? o?.payment?.total_amount ?? 0);
}

function orderCurrency(o) {
  return inferOrderCurrency(o) || 'USD';
}

function normalizeRate(rate) {
  const r = Number(rate);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

function convertAmount(amountBase, rate) {
  const base = safeNum(amountBase);
  const r = normalizeRate(rate);
  if (r <= 0) return 0;
  return base * r;
}

function pickRate(currencyRates, from, to) {
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  if (!f || !t || f === t) return 1;
  const entry = currencyRates && typeof currencyRates === 'object' ? currencyRates[f] : null;
  if (!entry || typeof entry !== 'object') return 0;
  if (t === String(entry.to || '').toUpperCase() && Number(entry.rate) > 0) return Number(entry.rate);
  // Supported shape from server: { CUR: { toBase, toTarget } }
  if (t && t === String(entry.baseCurrency || '').toUpperCase() && Number(entry.toBase) > 0) return Number(entry.toBase);
  if (t && t === String(entry.targetCurrency || '').toUpperCase() && Number(entry.toTarget) > 0) return Number(entry.toTarget);
  if (t && Number(entry.toBase) > 0 && t !== '' && t === '') return Number(entry.toBase);
  return 0;
}

function amountToBase(o, baseCurrency, currencyRates) {
  const cur = orderCurrency(o);
  const raw = orderAmountRaw(o);
  if (cur === String(baseCurrency || '').toUpperCase()) return raw;
  const rate = currencyRates?.[cur]?.toBase ?? 0;
  return rate > 0 ? raw * rate : 0;
}

function amountToTarget(o, targetCurrency, currencyRates) {
  const cur = orderCurrency(o);
  const raw = orderAmountRaw(o);
  if (cur === String(targetCurrency || '').toUpperCase()) return raw;
  const rate = currencyRates?.[cur]?.toTarget ?? 0;
  return rate > 0 ? raw * rate : 0;
}
function pickOrderProducts(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const products = Array.isArray(order?.products) ? order.products : [];
  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const productItems = Array.isArray(order?.productItems) ? order.productItems : [];
  if (items.length > 0) return items;
  if (products.length > 0) return products;
  if (lineItems.length > 0) return lineItems;
  if (productItems.length > 0) {
    return productItems.map((it) => ({
      product_id: it?.productId,
      product_name: it?.productName,
      sku_id: it?.skuId,
      sku_name: it?.skuName,
      seller_sku: it?.sellerSku,
      quantity: it?.quantity,
      sale_price: it?.sale_price ?? it?.itemPrice,
      currency: it?.currency,
    }));
  }
  return [];
}

function parseProductQuantity(item) {
  const raw = Number(item?.quantity ?? item?.quantity_sold ?? item?.count);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 1;
}

function parseProductAmount(item, quantity) {
  const unitPrice = safeNum(item?.sale_price ?? item?.price ?? item?.item_price ?? 0);
  if (unitPrice <= 0) return 0;
  return unitPrice * Math.max(1, safeNum(quantity));
}

function resolveOrderRegion(order) {
  const m = orderMarketRegion(order);
  if (m) return m.toUpperCase();
  return String(order?.recipient_address?.region_code || '')
    .trim()
    .toUpperCase();
}

/** 大屏订单去重键：优先 orderId，与 orders-cache 多行/多 SKU 展开无关 */
function getOrderDedupKey(o) {
  if (!o || typeof o !== 'object') return '';
  const raw = o._raw && typeof o._raw === 'object' ? o._raw : null;
  const candidates = [
    o.orderId,
    o.order_id,
    o.platform_order_id,
    o.id,
    raw?.order_id,
    raw?.id,
  ];
  for (const c of candidates) {
    const s = String(c ?? '').trim();
    if (s) return s.toLowerCase();
  }
  return '';
}

/**
 * 按 orderId 去重（保留首次出现），避免 line_items 多行导致订单数/Gmv 重复累计
 * @returns {{ orders: object[], beforeCount: number, afterCount: number }}
 */
function dedupeOrdersByOrderId(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const map = new Map();
  let anon = 0;
  for (const o of list) {
    let key = getOrderDedupKey(o);
    if (!key) {
      key = `__anon_${anon}_${getCreateEpochSec(o)}`;
      anon += 1;
    }
    if (!map.has(key)) map.set(key, o);
  }
  return {
    orders: [...map.values()],
    beforeCount: list.length,
    afterCount: map.size,
  };
}

/** 商品销量排行：兼容 items/products/line_items，按 productId > skuId > sellerSku > productName 分组 */
function buildProductRankingsFromLineItems(todayOrders, limit = 20) {
  const map = new Map();
  for (const o of todayOrders) {
    const shopId = String(o?.shopId || '').toLowerCase();
    const region = resolveOrderRegion(o);
    const shopName = String(o?.shopName || '');
    const lines = pickOrderProducts(o);
    const orderId = String(o?.orderId || o?.id || '');
    for (const it of lines) {
      const productId = String(it?.product_id ?? it?.productId ?? '').trim();
      const productName = String(
        it?.product_name ?? it?.productName ?? it?.name ?? it?.title ?? '',
      ).trim();
      const skuId = String(it?.sku_id ?? it?.skuId ?? '').trim();
      const skuName = String(it?.sku_name ?? it?.skuName ?? '').trim();
      const sellerSku = String(it?.seller_sku ?? it?.sellerSku ?? '').trim();
      const currency =
        normalizeCurrency(String(it?.currency ?? it?.currency_code ?? '').trim()) ||
        inferOrderCurrency(o) ||
        'USD';
      const quantity = parseProductQuantity(it);
      const amount = parseProductAmount(it, quantity);
      if (!productId && !productName && !skuId && !sellerSku) continue;

      const key = `${shopId}::${productId || skuId || sellerSku || `name:${productName}`}`;
      const prev = map.get(key) || {
        productId: productId || '',
        productName: productName || productId || skuId || sellerSku || 'Unknown',
        skuId: skuId || '',
        skuName: skuName || '',
        sellerSku: sellerSku || '',
        currency: currency || inferOrderCurrency(o) || 'USD',
        todayQuantity: 0,
        todayAmount: 0,
        orderIds: new Set(),
        orderCount: 0,
        todaySales: 0,
        region,
        market: region,
        shopId,
        shopName,
      };
      prev.todayQuantity += quantity;
      prev.todayAmount += amount;
      prev.todaySales += quantity;
      if (orderId) prev.orderIds.add(orderId);
      prev.orderCount = prev.orderIds.size;
      if (!prev.productName && productName) prev.productName = productName;
      if (!prev.skuName && skuName) prev.skuName = skuName;
      if (!prev.skuId && skuId) prev.skuId = skuId;
      if (!prev.sellerSku && sellerSku) prev.sellerSku = sellerSku;
      if (!prev.region && region) {
        prev.region = region;
        prev.market = region;
      }
      if (!prev.shopName && shopName) prev.shopName = shopName;
      map.set(key, prev);
    }
  }
  const rows = [...map.values()]
    .sort((a, b) => b.todayQuantity - a.todayQuantity)
    .slice(0, limit)
    .map((x, i) => ({
      rank: i + 1,
      productId: x.productId || x.skuId || x.sellerSku || `name:${x.productName}`,
      product_name: x.productName,
      productName: x.productName,
      sku: x.sellerSku || x.skuId || '',
      skuId: x.skuId,
      skuName: x.skuName,
      sellerSku: x.sellerSku,
      currency: x.currency,
      todayQuantity: Number(safeNum(x.todayQuantity).toFixed(2)),
      todayAmount: Number(safeNum(x.todayAmount).toFixed(2)),
      orderCount: Number(x.orderCount || 0),
      todaySales: Number(safeNum(x.todayQuantity).toFixed(2)),
      soldQuantity: Number(safeNum(x.todayQuantity).toFixed(2)),
      region: x.region,
      market: x.region,
      shop_name: x.shopName,
      shopName: x.shopName,
      shopId: x.shopId,
      quantity: Number(safeNum(x.todayQuantity).toFixed(2)),
      sales_amount: Number(safeNum(x.todayAmount).toFixed(2)),
      gmv: Number(safeNum(x.todayAmount).toFixed(2)),
      salesAmountBase: Number(safeNum(x.todayAmount).toFixed(2)),
      salesAmountTarget: Number(safeNum(x.todayAmount).toFixed(2)),
      conversionRate: 0,
      productStatus: 'Active',
      targetCurrency: x.currency || 'USD',
    }));
  return rows;
}

/**
 * 按订单创建时间聚合 GMV（基准币）与单量；跨度较长时用按日桶，否则按小时桶（服务器本地时区）
 */
function buildTrendFromOrders(orders, excludeGmv, startSec, endSec, baseCurrency, currencyRates) {
  const span = Math.max(0, Number(endSec) - Number(startSec));
  const useDaily = span > 36 * 3600;
  const map = new Map();
  for (const o of orders) {
    const ep = getCreateEpochSec(o);
    if (!ep) continue;
    const bucketKey = useDaily
      ? dayjs.unix(ep).format('YYYY-MM-DD')
      : dayjs.unix(ep).format('YYYY-MM-DD HH:00');
    const orderKey = getOrderDedupKey(o) || `__anon_${bucketKey}_${ep}`;
    const amtBase = excludeGmv ? 0 : amountToBase(o, baseCurrency, currencyRates);
    const prev = map.get(bucketKey) || {
      time: bucketKey,
      gmvBase: 0,
      gmvTarget: 0,
      orders: 0,
      _orderIds: new Set(),
    };
    if (!prev._orderIds.has(orderKey)) {
      prev._orderIds.add(orderKey);
      prev.orders = prev._orderIds.size;
      if (!excludeGmv) prev.gmvBase += amtBase;
    }
    map.set(bucketKey, prev);
  }
  return [...map.values()]
    .map(({ _orderIds, ...t }) => t)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function toDisplayOrder(o, idx, rate, baseCurrency, targetCurrency, currencyRates, usdRates, cnyPerUsd) {
  const one = o && typeof o === 'object' ? o : {};
  const raw = orderAmountRaw(one);
  const cur = orderCurrency(one);
  const amountBase = amountToBase(one, baseCurrency, currencyRates);
  const amountTarget =
    baseCurrency === targetCurrency
      ? amountBase
      : currencyRates
        ? amountToTarget(one, targetCurrency, currencyRates)
        : convertAmount(amountBase, rate);
  const usdR = usdRates && typeof usdRates === 'object' ? Number(usdRates[cur] || 0) : 0;
  const usdAmount = usdR > 0 ? raw / usdR : convertToUSDSync(raw, cur, usdR);
  const cnyAmount = convertToCNYSync(raw, cur, usdR, cnyPerUsd);
  const rawDecimals = cur === 'VND' ? 0 : 2;
  return {
    id: String(one.orderId ?? one.id ?? `order-${idx}`),
    orderId: String(one.orderId ?? one.id ?? ''),
    shopId: String(one.shopId ?? ''),
    shopName: String(one.shopName ?? 'TikTok Shop'),
    orderStatus: orderStatusToZh(one.orderStatus ?? one.status ?? ''),
    platform: String(one.platform ?? 'TikTok'),
    region: String(orderMarketRegion(one) || one.region || '--').toUpperCase(),
    customerName: String(one.customerName ?? '***'),
    /** 原币种金额（与 currency 一致）；勿与 summary 的基准币 GMV 混淆 */
    orderAmountBase: Number(raw.toFixed(rawDecimals)),
    orderAmountTarget: Number(amountTarget.toFixed(2)),
    usdAmount: Number(usdAmount.toFixed(2)),
    cnyAmount: Number(cnyAmount.toFixed(2)),
    currency: cur,
    orderTime: String(
      one.createTime != null && one.createTime !== ''
        ? (Number(one.createTime) > 1e12
            ? dayjs(Number(one.createTime)).format('YYYY-MM-DD HH:mm:ss')
            : Number.isFinite(Number(one.createTime)) && Number(one.createTime) > 0
              ? dayjs.unix(Number(one.createTime)).format('YYYY-MM-DD HH:mm:ss')
              : String(one.createTime))
        : '',
    ),
    paidTime: String(one.paymentTime ?? one.paidTime ?? ''),
    isSample: orderIsSampleOrder(one),
    isCancelled: orderIsCancelledStatus(one.orderStatus ?? one.status),
  };
}

function buildShopsFromOrders(todayOrders, rate, baseCurrency, targetCurrency, currencyRates, excludeGmv = false) {
  const byShop = new Map();
  for (const o of todayOrders) {
    const sid = orderCachePlatformShopId(o) || 'unknown';
    const name = String(o?.shopName || `TikTok ${sid.toUpperCase()}`);
    const region = String(orderMarketRegion(o) || sid).toUpperCase();
    const orderKey = getOrderDedupKey(o) || `__anon_${sid}_${getCreateEpochSec(o)}`;
    const cur = orderCurrency(o);
    const amtBase = amountToBase(o, baseCurrency, currencyRates);
    const amtTarget =
      baseCurrency === targetCurrency
        ? amtBase
        : currencyRates
          ? amountToTarget(o, targetCurrency, currencyRates)
          : convertAmount(amtBase, rate);
    const prev = byShop.get(sid) || {
      shopId: sid,
      shopName: name,
      region,
      currency: baseCurrency,
      todayOrders: 0,
      todayGmvBase: 0,
      todayGmvTarget: 0,
      status: 'normal',
      _orderIds: new Set(),
    };
    if (prev._orderIds.has(orderKey)) continue;
    prev._orderIds.add(orderKey);
    prev.todayOrders = prev._orderIds.size;
    if (!excludeGmv) {
      prev.todayGmvBase += amtBase;
      prev.todayGmvTarget += amtTarget;
    }
    byShop.set(sid, prev);
  }
  return [...byShop.values()].map((s) => {
    const gmvVal = Number(s.todayGmvTarget.toFixed(2));
    const { _orderIds, ...rest } = s;
    return {
      ...rest,
      shop_name: s.shopName,
      market: s.region,
      shop_gmv: gmvVal,
      gmv: gmvVal,
      todayGmvBase: Number(s.todayGmvBase.toFixed(2)),
      todayGmvTarget: gmvVal,
    };
  });
}

/**
 * 店铺排行：叠加 catalog；单市场下仅合并该市场的店铺，避免 TH/MY 混在 VN 视图
 * @param {string} [marketFilter='ALL']
 */
function mergeShopsWithCatalog(shopsFromOrders, catalogShops, baseCurrency, marketFilter = 'ALL') {
  const m = String(marketFilter || 'ALL').toUpperCase();
  const byId = new Map();
  for (const s of shopsFromOrders || []) {
    const id = String(s?.shopId || '').trim().toLowerCase();
    if (!id) continue;
    byId.set(id, { ...s, shopId: id });
  }
  for (const c of catalogShops || []) {
    const id = String(c?.shopId || '').trim().toLowerCase();
    if (!id || byId.has(id)) continue;
    const reg = String(c.region || c.market || id).toUpperCase();
    if (m !== 'ALL' && reg !== m) continue;
    byId.set(id, {
      shopId: id,
      shopName: String(c.shopName || `TikTok ${id.toUpperCase()}`),
      shop_name: String(c.shopName || `TikTok ${id.toUpperCase()}`),
      region: reg,
      market: reg,
      currency: baseCurrency,
      todayOrders: 0,
      todayGmvBase: 0,
      todayGmvTarget: 0,
      shop_gmv: 0,
      gmv: 0,
      status: 'normal',
    });
  }
  return [...byId.values()];
}

function orderStatusStats(todayOrders) {
  const m = {};
  for (const o of todayOrders) {
    const k = orderStatusToZh(o?.orderStatus ?? o?.status ?? '');
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function pad2HourIdx(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

/**
 * 与 {@link buildOrdersDashboardPayload} 中订单窗 GMV 同一套口径：
 * `getTimeRangeBounds(range)` + `getCreateEpochSec` + market/shop/orderFilter + `amountTo*` 汇率链。
 * 在同一批 `scoped` 订单上按窗起点起按小时聚合 target 币 GMV（供 gmv-compare 今日曲线复用；通常 range=today）。
 * @param {Array} rawOrders
 * @param {{ orderFilter?: string, selectedShopId?: string, marketFilter?: string, selectedRegion?: string, baseCurrency?: string, targetCurrency?: string, exchangeRate?: number, currencyRates?: Record<string, unknown>, range?: string, startDate?: string, endDate?: string }} opts
 * @returns {{
 *   bounds: object,
 *   maxHourIdx: number,
 *   hourly: Array<{ bucket: string, bucket_idx: number, gmv: number }>,
 *   todayTotalTarget: number,
 * }}
 */
function getTodayHourlyGmvForDashboard(rawOrders, opts = {}) {
  const orderFilter = normalizeOrderFilter(opts.orderFilter);
  const selectedShopId = String(opts.selectedShopId || 'all').toLowerCase();
  const marketKeyRaw = String(opts.marketFilter ?? opts.selectedRegion ?? 'ALL').trim().toUpperCase();
  const marketFilter = !marketKeyRaw || marketKeyRaw === 'ALL' ? 'ALL' : marketKeyRaw;
  const baseCurrency = String(opts.baseCurrency || 'USD').toUpperCase();
  const targetCurrency = String(opts.targetCurrency || 'USD').toUpperCase();
  const exchangeRate =
    baseCurrency === targetCurrency ? 1 : normalizeRate(opts.exchangeRate) || 0;
  const currencyRates = opts.currencyRates && typeof opts.currencyRates === 'object' ? opts.currencyRates : null;

  const list = Array.isArray(rawOrders) ? rawOrders : [];
  const range = normalizeRange(opts.range || 'today');
  const bounds = getTimeRangeBounds(range, opts.startDate || '', opts.endDate || '');
  const { startSec, endSec } = bounds;

  const timeFiltered = list.filter((o) => {
    const ep = getCreateEpochSec(o);
    if (!ep) return false;
    return ep >= startSec && ep <= endSec;
  });
  const filteredOrders = filterOrdersByMarket(timeFiltered, marketFilter);
  let scoped = filteredOrders.filter((o) => orderMatchesOrderFilter(o, orderFilter));
  if (selectedShopId !== 'all') {
    scoped = scoped.filter((o) => orderCachePlatformShopId(o) === selectedShopId);
  }
  scoped = dedupeOrdersByOrderId(scoped).orders;

  const gmvExcluded = orderFilterExcludesGmv(orderFilter);

  const todayStartMs = startSec * 1000;
  const nowBoundMs = endSec * 1000;
  const elapsedMs = Math.max(0, nowBoundMs - todayStartMs);
  const maxHourIdx = Math.min(23, Math.max(0, Math.floor(elapsedMs / 3600000)));

  const totalGmvTarget = gmvExcluded
    ? 0
    : baseCurrency === targetCurrency
      ? scoped.reduce((s, o) => s + amountToBase(o, baseCurrency, currencyRates), 0)
      : currencyRates
        ? scoped.reduce((s, o) => s + amountToTarget(o, targetCurrency, currencyRates), 0)
        : exchangeRate > 0
          ? convertAmount(
              scoped.reduce((s, o) => s + amountToBase(o, baseCurrency, currencyRates), 0),
              exchangeRate,
            )
          : 0;

  /** @type {Map<string, number>} */
  const hourlyMap = new Map();
  if (!gmvExcluded) {
    for (const o of scoped) {
      const ep = getCreateEpochSec(o);
      if (!ep) continue;
      const tsMs = ep * 1000;
      if (tsMs < todayStartMs || tsMs > nowBoundMs) continue;
      const idx = Math.floor((tsMs - todayStartMs) / 3600000);
      if (idx < 0 || idx > maxHourIdx) continue;
      const b = pad2HourIdx(idx);
      const amt =
        baseCurrency === targetCurrency
          ? amountToBase(o, baseCurrency, currencyRates)
          : currencyRates
            ? amountToTarget(o, targetCurrency, currencyRates)
            : exchangeRate > 0
              ? convertAmount(amountToBase(o, baseCurrency, currencyRates), exchangeRate)
              : 0;
      hourlyMap.set(b, (hourlyMap.get(b) || 0) + amt);
    }
  }

  const hourly = [];
  for (let i = 0; i <= maxHourIdx; i++) {
    const b = pad2HourIdx(i);
    hourly.push({
      bucket: `${b}:00`,
      bucket_idx: i,
      gmv: Number((hourlyMap.get(b) || 0).toFixed(2)),
    });
  }

  return {
    bounds,
    maxHourIdx,
    hourly,
    todayTotalTarget: Number(totalGmvTarget.toFixed(2)),
  };
}

/**
 * @param {Array} rawOrders - orders-cache.orders 原始项（Open API normalize 结构）
 * @param {{ orderFilter?: string, selectedShopId?: string, marketFilter?: string, selectedRegion?: string, baseCurrency?: string, targetCurrency?: string, ordersPackUpdatedAt?: string, range?: string, startDate?: string, endDate?: string, catalogShops?: Array<{ shopId?: string, shopName?: string, region?: string, market?: string }> }} opts
 */
function buildOrdersDashboardPayload(rawOrders, opts = {}) {
  const orderFilter = normalizeOrderFilter(opts.orderFilter);
  const selectedShopId = String(opts.selectedShopId || 'all').toLowerCase();
  const marketKeyRaw = String(opts.marketFilter ?? opts.selectedRegion ?? 'ALL').trim().toUpperCase();
  const marketFilter = !marketKeyRaw || marketKeyRaw === 'ALL' ? 'ALL' : marketKeyRaw;
  const baseCurrency = String(opts.baseCurrency || 'USD').toUpperCase();
  const targetCurrency = String(opts.targetCurrency || 'USD').toUpperCase();
  const exchangeRate =
    baseCurrency === targetCurrency ? 1 : normalizeRate(opts.exchangeRate) || 0;
  const currencyRates = opts.currencyRates && typeof opts.currencyRates === 'object' ? opts.currencyRates : null;
  const usdRates = opts.usdRates && typeof opts.usdRates === 'object' ? opts.usdRates : null;
  const cnyPerUsd = Number(opts.cnyPerUsd || usdRates?.CNY || 0) || 0;
  const list = Array.isArray(rawOrders) ? rawOrders : [];
  const bounds = getTimeRangeBounds(opts.range, opts.startDate, opts.endDate);
  const { startSec, endSec } = bounds;
  const rangeNorm = normalizeRange(bounds.range);
  const timeFiltered = list.filter((o) => {
    const ep = getCreateEpochSec(o);
    if (!ep) return false;
    return ep >= startSec && ep <= endSec;
  });

  console.log('[dashboard-time-filter]', {
    range: rangeNorm,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    before: list.length,
    after: timeFiltered.length,
  });

  const filteredOrders = filterOrdersByMarket(timeFiltered, marketFilter);

  const gmvExcluded = orderFilterExcludesGmv(orderFilter);

  let scoped = filteredOrders.filter((o) => orderMatchesOrderFilter(o, orderFilter));
  if (selectedShopId !== 'all') {
    scoped = scoped.filter((o) => orderCachePlatformShopId(o) === selectedShopId);
  }

  const deduped = dedupeOrdersByOrderId(scoped);
  scoped = deduped.orders;
  const uniqueOrderCount = deduped.afterCount;
  const ordersBeforeDedupCount = deduped.beforeCount;

  const totalGmvBase = gmvExcluded
    ? 0
    : scoped.reduce((s, o) => s + amountToBase(o, baseCurrency, currencyRates), 0);
  const totalGmvTarget =
    gmvExcluded
      ? 0
      : baseCurrency === targetCurrency
        ? totalGmvBase
        : currencyRates
          ? scoped.reduce((s, o) => s + amountToTarget(o, targetCurrency, currencyRates), 0)
          : exchangeRate > 0
            ? convertAmount(totalGmvBase, exchangeRate)
            : 0;
  const n = scoped.length;
  const updatedAt =
    opts.ordersPackUpdatedAt || dayjs().format('YYYY-MM-DD HH:mm:ss');

  const shopsAgg = buildShopsFromOrders(
    scoped,
    exchangeRate,
    baseCurrency,
    targetCurrency,
    currencyRates,
    gmvExcluded,
  );
  const shops = mergeShopsWithCatalog(shopsAgg, opts.catalogShops, baseCurrency, marketFilter);
  const shopRankingAllTodayOrders = shops.reduce((sum, s) => sum + Number(s.todayOrders || 0), 0);

  const forProductScope =
    selectedShopId === 'all'
      ? filteredOrders
      : filteredOrders.filter((o) => orderCachePlatformShopId(o) === selectedShopId);
  const forProductFinal = forProductScope.filter((o) => orderMatchesOrderFilter(o, orderFilter));

  const productRankings = buildProductRankingsFromLineItems(forProductFinal, 20);
  let productRankingsWithFx = productRankings.map((p) => {
    const salesAmountRaw = safeNum(p.salesAmountBase);
    const itemCur = String(p.currency || '').toUpperCase();
    const toBase = itemCur && itemCur !== baseCurrency ? Number(currencyRates?.[itemCur]?.toBase || 0) : 1;
    const salesAmountBase = toBase > 0 ? salesAmountRaw * toBase : 0;
    const salesAmountTarget =
      baseCurrency === targetCurrency
        ? salesAmountBase
        : itemCur && currencyRates
          ? (Number(currencyRates?.[itemCur]?.toTarget || 0) > 0 ? salesAmountRaw * Number(currencyRates[itemCur].toTarget) : 0)
          : exchangeRate > 0
            ? convertAmount(salesAmountBase, exchangeRate)
            : 0;
    return {
      ...p,
      salesAmountBase: Number(salesAmountBase.toFixed(2)),
      salesAmountTarget: Number(salesAmountTarget.toFixed(2)),
      conversionRate: exchangeRate,
      targetCurrency,
    };
  });
  if (gmvExcluded) {
    productRankingsWithFx = productRankingsWithFx.map((p) => ({
      ...p,
      salesAmountBase: 0,
      salesAmountTarget: 0,
      todayAmount: 0,
    }));
  }

  const trend = buildTrendFromOrders(scoped, gmvExcluded, startSec, endSec, baseCurrency, currencyRates).map((t) => {
    const gmvBase = safeNum(t.gmvBase);
    const gmvTarget = baseCurrency === targetCurrency ? gmvBase : exchangeRate > 0 ? convertAmount(gmvBase, exchangeRate) : 0;
    return {
      ...t,
      gmvBase: Number(gmvBase.toFixed(2)),
      gmvTarget: Number(gmvTarget.toFixed(2)),
    };
  });

  const ordersDisplay = [...scoped]
    .sort((a, b) => getCreateEpochSec(b) - getCreateEpochSec(a))
    .slice(0, 200)
    .map((o, i) =>
      toDisplayOrder(o, i, exchangeRate, baseCurrency, targetCurrency, currencyRates, usdRates, cnyPerUsd),
    );

  const statusBreakdown = orderStatusStats(scoped);

  return {
    selectedShopId: selectedShopId === 'all' ? 'all' : selectedShopId,
    selectedRegion: marketFilter === 'ALL' ? 'all' : marketFilter,
    baseCurrency,
    targetCurrency,
    exchangeRate,
    summary: {
      todayOrders: n,
      todayGmvBase: Number(totalGmvBase.toFixed(2)),
      todayGmvTarget: Number(totalGmvTarget.toFixed(2)),
      avgOrderValueBase: n > 0 ? Number((totalGmvBase / n).toFixed(2)) : 0,
      avgOrderValueTarget: n > 0 ? Number((totalGmvTarget / n).toFixed(2)) : 0,
      itemSoldCount: productRankingsWithFx.reduce((s, p) => s + safeNum(p.todaySales), 0),
      skuOrderCount: 0,
      status: n > 0 ? 'normal' : 'normal',
      updatedAt,
    },
    shops,
    orders: ordersDisplay,
    productRankings: productRankingsWithFx,
    trend,
    meta: {
      dataSource: 'tiktok_open_api_orders',
      collectMode: 'open_api_orders_cache',
      ordersLoadedCount: list.length,
      ordersTodayCount: filteredOrders.length,
      timeRange: rangeNorm,
      rangeStartEpoch: startSec,
      rangeEndEpoch: endSec,
      startDate: bounds.startDate,
      endDate: bounds.endDate,
      customInvalid: Boolean(bounds.customInvalid),
      message: 'TikTok Open API orders cache source',
      ordersMessage:
        ordersDisplay.length > 0
          ? 'Orders from orders-cache.json (Open API)'
          : 'No orders in orders-cache.json after filters',
      trendMessage:
        trend.length > 0
          ? endSec - startSec > 36 * 3600
            ? 'Daily trend from order create time (server local TZ)'
            : 'Hourly trend from order create time (server local TZ)'
          : 'No orders in selected time range for trend',
      orderStatusStats: statusBreakdown,
      updatedAt,
      refreshInterval: Number(process.env.GMV_COLLECT_INTERVAL_SECONDS || 300),
      summaryTodayOrders: n,
      shopRankingAllTodayOrders,
      uniqueOrderCount,
      ordersBeforeDedupCount,
    },
  };
}

module.exports = {
  buildOrdersDashboardPayload,
  getTodayHourlyGmvForDashboard,
  orderCachePlatformShopId,
  getOrderDedupKey,
  dedupeOrdersByOrderId,
  filterOrdersByMarket,
  orderMarketRegion,
  isOrderToday,
  getCreateEpochSec,
};
