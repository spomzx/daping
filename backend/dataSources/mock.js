const dayjs = require('dayjs');
const {
  safeAmount,
  normalizeBaseCurrency,
  normalizeTargetCurrency,
  getConversionRate,
  getFallbackRate,
} = require('../lib/rates');
const {
  orderMatchesOrderFilter,
  normalizeOrderFilter: normalizeOrderFilterLib,
  orderFilterExcludesGmv,
} = require('../lib/orderFilter');

const SHOP_DEFS = [
  { shopId: 'th', shopName: 'CQ Chic Thailand', region: 'Thailand', weight: 0.3 },
  { shopId: 'vn', shopName: 'CQ Chic Vietnam', region: 'Vietnam', weight: 0.24 },
  { shopId: 'my', shopName: 'CQ Chic Malaysia', region: 'Malaysia', weight: 0.2 },
  { shopId: 'ph', shopName: 'CQ Chic Philippines', region: 'Philippines', weight: 0.14 },
  { shopId: 'sg', shopName: 'CQ Chic Singapore', region: 'Singapore', weight: 0.12 },
];

const SHOP_ID_SET = new Set(['all', ...SHOP_DEFS.map((s) => s.shopId)]);
const SHOP_ID_TO_MARKET = { th: 'TH', vn: 'VN', my: 'MY', ph: 'PH', sg: 'SG' };
const CUSTOMER_POOL = ['K***A', 'M***N', 'T***Y', 'S***R', 'L***E', 'P***K', 'R***A', 'N***G'];

let lastDebugSnapshot = null;

const store = {
  todayGmvThb: 12500.88,
  todayOrders: 321,
  status: 'normal',
  collectMode: 'mock',
  refreshInterval: 30,
  trend: [
    { time: '09:00', gmvThb: 1200, orders: 30 },
    { time: '10:00', gmvThb: 2500, orders: 65 },
  ],
};

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeShopId(value) {
  const s = String(value || 'all').toLowerCase();
  return SHOP_ID_SET.has(s) ? s : 'all';
}

function normalizeOrderFilter(value) {
  return normalizeOrderFilterLib(value);
}

function orderMatchesFilter(order, filter) {
  return orderMatchesOrderFilter(order, filter);
}

function resolveDataStatus(todayOrders, ordersLen) {
  if (todayOrders > 0 || ordersLen > 0) return 'normal';
  return store.status;
}

function buildSummaryFromShops(shopsPayload, selectedShopId, updatedAt) {
  let agg = { todayOrders: 0, todayGmvBase: 0, todayGmvTarget: 0 };
  if (selectedShopId === 'all') {
    agg = shopsPayload.reduce(
      (a, s) => ({
        todayOrders: a.todayOrders + s.todayOrders,
        todayGmvBase: a.todayGmvBase + s.todayGmvBase,
        todayGmvTarget: a.todayGmvTarget + s.todayGmvTarget,
      }),
      { todayOrders: 0, todayGmvBase: 0, todayGmvTarget: 0 },
    );
  } else {
    const one = shopsPayload.find((s) => s.shopId === selectedShopId);
    if (one) {
      agg = {
        todayOrders: one.todayOrders,
        todayGmvBase: one.todayGmvBase,
        todayGmvTarget: one.todayGmvTarget,
      };
    }
  }

  const n = Math.max(agg.todayOrders, 0);
  return {
    todayOrders: agg.todayOrders,
    todayGmvBase: safeAmount(agg.todayGmvBase, 2, 0),
    todayGmvTarget: safeAmount(agg.todayGmvTarget, 2, 0),
    avgOrderValueBase: safeAmount(n > 0 ? agg.todayGmvBase / n : 0, 2, 0),
    avgOrderValueTarget: safeAmount(n > 0 ? agg.todayGmvTarget / n : 0, 2, 0),
    status: resolveDataStatus(agg.todayOrders, 0),
    updatedAt,
  };
}

function splitIntegerByWeights(total, defs) {
  const n = defs.length;
  if (n === 0) return [];
  const raw = defs.map((d) => Math.floor(total * d.weight));
  let diff = total - raw.reduce((a, b) => a + b, 0);
  let i = 0;
  while (diff > 0) {
    raw[i % n] += 1;
    diff -= 1;
    i += 1;
  }
  return raw.map((v) => Math.max(0, v));
}

function buildMockOrdersForShop(shop, orderCountHint, avgOrderValueThb, thbToBaseRate, baseToTargetRate) {
  const count = Math.min(12, Math.max(4, Math.floor(orderCountHint / 35) + 4));
  const statusPool = ['paid', 'completed', 'unpaid', 'cancelled', 'buyer_cancel', 'seller_cancel'];
  return Array.from({ length: count }).map((_, index) => {
    const factor = 0.7 + Math.random() * 0.9;
    const orderAmountThb = safeAmount(avgOrderValueThb * factor, 2, 1);
    const orderAmountBase = safeAmount(orderAmountThb * thbToBaseRate, 2, 1);
    const orderAmountTarget = safeAmount(orderAmountBase * baseToTargetRate, 2, 0.01);
    const isSample = index % 4 === 0;
    return {
      id: `${shop.shopId}-${store.todayOrders}-${index}`,
      shopId: shop.shopId,
      shopName: shop.shopName,
      orderStatus: statusPool[randomInt(0, statusPool.length - 1)],
      platform: 'TikTok',
      region: shop.region,
      customerName: CUSTOMER_POOL[Math.floor(Math.random() * CUSTOMER_POOL.length)],
      orderAmountBase,
      orderAmountTarget,
      orderTime: `${Math.floor(Math.random() * 59) + 1}分钟前`,
      isSample,
      ...(isSample ? { _raw: { is_sample_order: true } } : {}),
    };
  });
}

function buildProductCatalogForShop(shop) {
  const seed = shop.shopId.charCodeAt(0) + shop.shopId.charCodeAt(1);
  const products = [
    { productId: `${shop.shopId}-1729384756`, productName: 'Blossom Code Bracelet', soldQuantity: randomInt(40, 90) + (seed % 8), conversionRate: 3.8, productStatus: 'Active', priceBase: 41.6 },
    { productId: `${shop.shopId}-1923847561`, productName: 'Luna Pearl Hair Clip', soldQuantity: randomInt(35, 80) + (seed % 6), conversionRate: 3.2, productStatus: 'Low Stock', priceBase: 36.4 },
    { productId: `${shop.shopId}-1638475629`, productName: 'Sakura Charm Necklace', soldQuantity: randomInt(25, 70) + (seed % 5), conversionRate: 2.9, productStatus: 'Active', priceBase: 52.9 },
    { productId: `${shop.shopId}-1529384657`, productName: 'Ocean Wave Ring Set', soldQuantity: randomInt(20, 60) + (seed % 5), conversionRate: 2.5, productStatus: 'Active', priceBase: 47.3 },
    { productId: `${shop.shopId}-1429384021`, productName: 'Velvet Bow Earrings', soldQuantity: randomInt(15, 50) + (seed % 4), conversionRate: 2.1, productStatus: 'Out of Stock', priceBase: 33.8 },
    { productId: `${shop.shopId}-1329384993`, productName: 'Aurora Layer Chain', soldQuantity: randomInt(12, 45) + (seed % 4), conversionRate: 1.9, productStatus: 'Low Stock', priceBase: 58.2 },
  ];
  return products;
}

function buildProductRankingsForShop(shop, thbToBaseRate, exchangeRate, targetCurrency) {
  const catalog = buildProductCatalogForShop(shop);
  return catalog
    .map((item) => {
      const salesAmountThb = safeAmount(item.soldQuantity * item.priceBase, 2, 1);
      const salesAmountBase = safeAmount(salesAmountThb * thbToBaseRate, 2, 1);
      const salesAmountTarget = safeAmount(salesAmountBase * exchangeRate, 2, 0.01);
      return {
        rank: 0,
        productId: item.productId,
        productName: item.productName,
        soldQuantity: item.soldQuantity,
        salesAmountBase,
        salesAmountTarget,
        conversionRate: item.conversionRate,
        productStatus: item.productStatus,
        targetCurrency,
        shopId: shop.shopId,
      };
    })
    .sort((a, b) => {
      if (b.soldQuantity !== a.soldQuantity) return b.soldQuantity - a.soldQuantity;
      return b.salesAmountTarget - a.salesAmountTarget;
    })
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function mergeProductRankings(perShopRankings, targetCurrency) {
  const map = new Map();
  for (const list of perShopRankings) {
    for (const row of list) {
      const key = row.productName;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, { ...row, productId: `agg-${key}`, shopId: 'all' });
      } else {
        prev.soldQuantity += row.soldQuantity;
        prev.salesAmountBase = safeAmount(prev.salesAmountBase + row.salesAmountBase, 2, 0);
        prev.salesAmountTarget = safeAmount(prev.salesAmountTarget + row.salesAmountTarget, 2, 0);
        prev.conversionRate = safeAmount((prev.conversionRate + row.conversionRate) / 2, 1, 0);
      }
    }
  }
  return Array.from(map.values())
    .sort((a, b) => {
      if (b.soldQuantity !== a.soldQuantity) return b.soldQuantity - a.soldQuantity;
      return b.salesAmountTarget - a.salesAmountTarget;
    })
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      targetCurrency,
    }));
}

function updateStore() {
  const gmvGrowth = randomInt(50, 500);
  const orderGrowth = randomInt(1, 10);

  store.todayGmvThb = safeAmount(store.todayGmvThb + gmvGrowth, 2);
  store.todayOrders += orderGrowth;

  const now = dayjs();
  const point = {
    time: now.format('HH:mm:ss'),
    gmvThb: safeAmount(store.todayGmvThb, 2),
    orders: store.todayOrders,
  };

  const lastPoint = store.trend[store.trend.length - 1];
  if (!lastPoint || lastPoint.time !== point.time) {
    store.trend.push(point);
  } else {
    store.trend[store.trend.length - 1] = point;
  }

  if (store.trend.length > 30) {
    store.trend = store.trend.slice(-30);
  }
}

function computeShopSlices() {
  const orderParts = splitIntegerByWeights(Math.max(SHOP_DEFS.length, store.todayOrders), SHOP_DEFS);
  const gmvShares = SHOP_DEFS.map((d) => store.todayGmvThb * d.weight);
  const sumShare = gmvShares.reduce((a, b) => a + b, 0) || 1;
  const scale = store.todayGmvThb / sumShare;
  const gmvs = gmvShares.map((g) => safeAmount(g * scale, 2, 0.01));
  return SHOP_DEFS.map((def, i) => ({
    ...def,
    sliceOrders: Math.max(1, orderParts[i]),
    sliceGmvThb: Math.max(0.01, gmvs[i]),
  }));
}

function buildTrendForScope(selectedShopId, thbToBaseRate, exchangeRate, ratioFiltered) {
  const wMap = Object.fromEntries(SHOP_DEFS.map((s) => [s.shopId, s.weight]));
  const r = Number.isFinite(ratioFiltered) && ratioFiltered >= 0 ? ratioFiltered : 1;
  return store.trend.map((pt) => {
    let gmvThb = pt.gmvThb;
    let orders = pt.orders;
    if (selectedShopId !== 'all') {
      const w = wMap[selectedShopId] || 0.2;
      gmvThb = safeAmount(pt.gmvThb * w, 2, 0);
      orders = Math.max(1, Math.round(pt.orders * w));
    }
    return {
      time: pt.time,
      gmvBase: safeAmount(gmvThb * thbToBaseRate * r, 2, 0),
      gmvTarget: safeAmount(gmvThb * thbToBaseRate * exchangeRate * r, 2, 0),
      orders: Math.max(0, Math.round(orders * r)),
    };
  });
}

function summarizeOrders(orders) {
  const base = orders.reduce((s, o) => s + o.orderAmountBase, 0);
  const target = orders.reduce((s, o) => s + o.orderAmountTarget, 0);
  const n = orders.length;
  return {
    todayOrders: n,
    todayGmvBase: safeAmount(base, 2, 0),
    todayGmvTarget: safeAmount(target, 2, 0),
    avgOrderValueBase: safeAmount(n > 0 ? base / n : 0, 2, 0),
    avgOrderValueTarget: safeAmount(n > 0 ? target / n : 0, 2, 0),
  };
}

/**
 * @param {{ selectedShopId?: string, orderFilter?: string, baseCurrency?: string, targetCurrency?: string, metaOverride?: Record<string, unknown> }} query
 */
async function getGmvPayload(query = {}) {
  updateStore();

  const selectedShopId = normalizeShopId(query.selectedShopId);
  const orderFilter = normalizeOrderFilter(query.orderFilter);
  const baseCurrency = normalizeBaseCurrency(query.baseCurrency);
  const targetCurrency = normalizeTargetCurrency(query.targetCurrency);

  /** Mock 订单内部仍以 THB 为锚做换算，与全局 BASE_CURRENCY（USD）解耦 */
  const MOCK_PIVOT = 'THB';
  const thbToBasePayload = await getConversionRate(MOCK_PIVOT, baseCurrency, false);
  const baseToTargetPayload = await getConversionRate(baseCurrency, targetCurrency, false);

  const thbToBaseRate = safeAmount(
    thbToBasePayload.rate > 0 ? thbToBasePayload.rate : getFallbackRate(MOCK_PIVOT, baseCurrency),
    4,
    getFallbackRate(MOCK_PIVOT, baseCurrency),
  );
  const exchangeRate = safeAmount(
    baseToTargetPayload.rate > 0 ? baseToTargetPayload.rate : getFallbackRate(baseCurrency, targetCurrency),
    4,
    getFallbackRate(baseCurrency, targetCurrency),
  );

  const shopSlices = computeShopSlices();

  const allOrdersUnfiltered = [];
  const perShopUnfiltered = [];

  for (const shop of shopSlices) {
    const avgThb = safeAmount(shop.sliceGmvThb / Math.max(shop.sliceOrders, 1), 2, 1);
    const raw = buildMockOrdersForShop(shop, shop.sliceOrders, avgThb, thbToBaseRate, exchangeRate);
    perShopUnfiltered.push({ shop, orders: raw });
    if (selectedShopId === 'all' || shop.shopId === selectedShopId) {
      allOrdersUnfiltered.push(...raw);
    }
  }

  const poolForRatio = selectedShopId === 'all' ? allOrdersUnfiltered : perShopUnfiltered.find((p) => p.shop.shopId === selectedShopId)?.orders ?? [];
  const ordersOut = poolForRatio.filter((o) => orderMatchesFilter(o, orderFilter));
  const nAll = poolForRatio.length;
  const nFilt = ordersOut.length;
  const ratioFiltered = nAll > 0 ? safeAmount(nFilt / nAll, 4, 1) : 1;
  const gmvExcluded = orderFilterExcludesGmv(orderFilter);

  const updatedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');

  const shopsPayload = [];
  for (const { shop, orders } of perShopUnfiltered) {
    const allC = orders.length;
    const validC = orders.filter((o) => orderMatchesFilter(o, 'valid')).length;
    const unpaidC = orders.filter((o) => orderMatchesFilter(o, 'unpaid')).length;
    const filteredForKpi = orders.filter((o) => orderMatchesFilter(o, orderFilter));
    let smKpi = summarizeOrders(filteredForKpi);
    if (gmvExcluded) {
      smKpi = {
        ...smKpi,
        todayGmvBase: 0,
        todayGmvTarget: 0,
        avgOrderValueBase: 0,
        avgOrderValueTarget: 0,
      };
    }
    shopsPayload.push({
      shopId: shop.shopId,
      shopName: shop.shopName,
      shop_name: shop.shopName,
      region: shop.region,
      market: SHOP_ID_TO_MARKET[shop.shopId] || String(shop.shopId || '').toUpperCase(),
      todayOrders: smKpi.todayOrders,
      todayGmvBase: smKpi.todayGmvBase,
      todayGmvTarget: smKpi.todayGmvTarget,
      shop_gmv: smKpi.todayGmvTarget,
      gmv: smKpi.todayGmvTarget,
      status: resolveDataStatus(smKpi.todayOrders, smKpi.todayOrders > 0 ? 1 : 0),
      ordersAll: allC,
      ordersValid: validC,
      ordersUnpaid: unpaidC,
    });
  }

  shopsPayload.sort((a, b) => {
    if (b.todayOrders !== a.todayOrders) return b.todayOrders - a.todayOrders;
    return a.shopName.localeCompare(b.shopName, 'en');
  });

  const summary = buildSummaryFromShops(shopsPayload, selectedShopId, updatedAt);

  const perShopRankings = shopSlices.map((shop) =>
    buildProductRankingsForShop(shop, thbToBaseRate, exchangeRate, targetCurrency),
  );
  let productRankings;
  if (selectedShopId === 'all') {
    productRankings = mergeProductRankings(perShopRankings, targetCurrency);
  } else {
    productRankings = perShopRankings.find((_, i) => shopSlices[i].shopId === selectedShopId) ?? [];
  }
  if (gmvExcluded) {
    productRankings = productRankings.map((p) => ({
      ...p,
      salesAmountBase: 0,
      salesAmountTarget: 0,
    }));
  }

  let trend = buildTrendForScope(selectedShopId, thbToBaseRate, exchangeRate, ratioFiltered);
  if (gmvExcluded) {
    trend = trend.map((t) => ({ ...t, gmvBase: 0, gmvTarget: 0 }));
  }

  const allOrdersRaw = [];
  for (const { orders } of perShopUnfiltered) {
    for (const o of orders) allOrdersRaw.push(o);
  }

  lastDebugSnapshot = {
    shopsRaw: JSON.parse(JSON.stringify(shopsPayload)),
    ordersRaw: JSON.parse(JSON.stringify(allOrdersRaw)),
    productsRaw: JSON.parse(JSON.stringify(perShopRankings)),
    trendRaw: JSON.parse(JSON.stringify(store.trend)),
    lastGeneratedAt: updatedAt,
    lastQuery: {
      shopId: selectedShopId,
      orderFilter,
      baseCurrency,
      targetCurrency,
    },
  };

  const meta = {
    dataSource: 'mock',
    updatedAt,
    refreshInterval: store.refreshInterval,
    ...(query.metaOverride && typeof query.metaOverride === 'object' ? query.metaOverride : {}),
  };

  return {
    selectedShopId,
    baseCurrency,
    targetCurrency,
    exchangeRate,
    summary,
    shops: shopsPayload,
    orders: ordersOut,
    productRankings,
    trend,
    meta,
  };
}

function getLastDebugSnapshot() {
  return lastDebugSnapshot;
}

module.exports = {
  getGmvPayload,
  getLastDebugSnapshot,
  SHOP_DEFS,
  normalizeShopId,
  normalizeOrderFilter,
  orderMatchesFilter,
  buildSummaryFromShops,
  summarizeOrders,
};
