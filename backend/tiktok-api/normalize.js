const dayjs = require('dayjs');
const { getConversionRate, safeAmount } = require('../lib/rates');

async function convertAmount(value, fromCurrency, toCurrency) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (!from || !to) return 0;
  const conv = await getConversionRate(from, to, false);
  const rate = Number(conv.rate);
  if (!(rate > 0)) return 0;
  return safeAmount(Number(value || 0) * rate, 2, 0);
}

function hourKey(tsLike) {
  const d = dayjs(tsLike);
  if (!d.isValid()) return '';
  return d.format('HH:00');
}

async function buildGmvPayload({ allOrders, baseCurrency, targetCurrency }) {
  const updatedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const byShop = new Map();
  const byProduct = new Map();
  const trend = new Map();
  let totalOrders = 0;
  let totalGmvBase = 0;
  let totalGmvTarget = 0;
  let itemSoldCount = 0;
  let skuOrderCount = 0;

  const recent = [...allOrders]
    .sort((a, b) => dayjs(b.createTime).valueOf() - dayjs(a.createTime).valueOf())
    .slice(0, 200);

  for (const o of allOrders) {
    totalOrders += 1;
    const gmvBase = await convertAmount(o.totalAmount, o.currency, baseCurrency);
    const gmvTarget = await convertAmount(o.totalAmount, o.currency, targetCurrency);
    totalGmvBase += gmvBase;
    totalGmvTarget += gmvTarget;
    const s = byShop.get(o.shopId) || {
      shopId: o.shopId,
      shopName: o.shopName,
      region: o.region,
      currency: o.currency,
      todayOrders: 0,
      todayGmvBase: 0,
      todayGmvTarget: 0,
      status: 'normal',
    };
    s.todayOrders += 1;
    s.todayGmvBase = safeAmount(s.todayGmvBase + gmvBase, 2, 0);
    s.todayGmvTarget = safeAmount(s.todayGmvTarget + gmvTarget, 2, 0);
    byShop.set(o.shopId, s);

    const hk = hourKey(o.paymentTime || o.createTime);
    if (hk) {
      const t = trend.get(hk) || { time: hk, gmvBase: 0, gmvTarget: 0, orders: 0 };
      t.gmvBase = safeAmount(t.gmvBase + gmvBase, 2, 0);
      t.gmvTarget = safeAmount(t.gmvTarget + gmvTarget, 2, 0);
      t.orders += 1;
      trend.set(hk, t);
    }

    const orderItems = Array.isArray(o.items) && o.items.length > 0 ? o.items : o.productItems || [];
    for (const it of orderItems) {
      const qty = Number(it?.quantity ?? it?.quantity_sold ?? it?.count ?? 0);
      const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 0;
      itemSoldCount += safeQty;
      skuOrderCount += 1;
      const productName = it.product_name || it.productName || it.sku_name || it.skuName || 'Unknown Product';
      const productId = it.product_id || it.productId || it.sku_id || it.skuId || productName;
      const key = `${o.shopId}__${productId}`;
      const p = byProduct.get(key) || {
        productId: productId || key,
        productName,
        soldQuantity: 0,
        salesAmountBase: 0,
        salesAmountTarget: 0,
        salesAmountOriginal: 0,
        salesAmountOriginalFormatted: '',
        shopId: o.shopId,
        currency: o.currency,
      };
      let amtSrc = Number(it.itemTotalAmount || 0);
      if (!amtSrc) {
        const price = Number(it.sale_price || it.itemPrice || 0);
        amtSrc = safeAmount(price * safeQty, 2, 0);
      }
      p.soldQuantity += safeQty;
      p.salesAmountOriginal = safeAmount(p.salesAmountOriginal + amtSrc, 2, 0);
      p.salesAmountBase = safeAmount(p.salesAmountBase + (await convertAmount(amtSrc, o.currency, baseCurrency)), 2, 0);
      p.salesAmountTarget = safeAmount(
        p.salesAmountTarget + (await convertAmount(amtSrc, o.currency, targetCurrency)),
        2,
        0,
      );
      p.salesAmountOriginalFormatted = `${o.currency} ${safeAmount(p.salesAmountOriginal, 2, 0)}`;
      byProduct.set(key, p);
    }
  }

  const n = Math.max(totalOrders, 0);
  const shops = [...byShop.values()].sort((a, b) => b.todayOrders - a.todayOrders);
  const productRankings = [...byProduct.values()]
    .filter((p) => Number(p.soldQuantity || 0) > 0)
    .sort((a, b) => b.salesAmountTarget - a.salesAmountTarget)
    .slice(0, 100)
    .map((p, i) => ({
      rank: i + 1,
      productId: p.productId,
      productName: p.productName,
      soldQuantity: p.soldQuantity,
      salesAmountBase: p.salesAmountBase,
      salesAmountTarget: p.salesAmountTarget,
      salesAmountOriginal: p.salesAmountOriginal,
      salesAmountOriginalFormatted: p.salesAmountOriginalFormatted,
      conversionRate: 0,
      productStatus: 'Active',
      targetCurrency,
      shopId: p.shopId,
      currency: p.currency,
    }));

  const ordersOut = [];
  for (const o of recent) {
    ordersOut.push({
      id: o.orderId,
      shopId: o.shopId,
      shopName: o.shopName,
      orderStatus: o.orderStatus,
      platform: 'TikTok',
      region: o.region,
      customerName: '***',
      orderAmountBase: safeAmount(o.totalAmount, 2, 0),
      orderAmountTarget: safeAmount(await convertAmount(o.totalAmount, o.currency, targetCurrency), 2, 0),
      orderTime: o.createTime || '',
    });
  }

  return {
    selectedShopId: 'all',
    baseCurrency,
    targetCurrency,
    exchangeRate: (await getConversionRate(baseCurrency, targetCurrency, false)).rate,
    summary: {
      todayOrders: totalOrders,
      todayGmvBase: safeAmount(totalGmvBase, 2, 0),
      todayGmvTarget: safeAmount(totalGmvTarget, 2, 0),
      avgOrderValueBase: safeAmount(n > 0 ? totalGmvBase / n : 0, 2, 0),
      avgOrderValueTarget: safeAmount(n > 0 ? totalGmvTarget / n : 0, 2, 0),
      itemSoldCount,
      skuOrderCount,
      status: 'normal',
      updatedAt,
    },
    shops,
    orders: ordersOut,
    productRankings,
    trend: [...trend.values()].sort((a, b) => a.time.localeCompare(b.time)),
  };
}

module.exports = {
  buildGmvPayload,
};

