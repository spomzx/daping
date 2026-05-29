const dayjs = require('dayjs');
const { requestShopApi } = require('./client');
const { inferOrderCurrency } = require('../lib/currency');

const ORDER_API_VERSION = process.env.TIKTOK_ORDER_API_VERSION || '202309';
const ORDER_SEARCH_PATH =
  process.env.TIKTOK_ORDER_SEARCH_PATH || `/order/${ORDER_API_VERSION}/orders/search`;

/** TH=UTC+7；MY/PH/SG/VN/ID 等默认 UTC+8 */
function getMarketOffsetHours(region) {
  const r = String(region || '')
    .trim()
    .toUpperCase();
  if (r === 'TH' || r.includes('THAILAND')) return 7;
  return 8;
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

/** 市场本地自然日 → UTC epoch（与 OpenAPI create_time_ge/lt 一致） */
function getCalendarDayRangeByOffsetHours(dateYmd, offsetHours) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateYmd || '').trim());
  if (!m) throw new Error('invalid_date_yyyy_mm_dd');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const startUtcMs = Date.UTC(y, mo - 1, d, 0, 0, 0) - offsetHours * 3600 * 1000;
  const endUtcMs = Date.UTC(y, mo - 1, d + 1, 0, 0, 0) - offsetHours * 3600 * 1000;
  return {
    startEpochSec: Math.floor(startUtcMs / 1000),
    /** TikTok create_time_lt 为开区间上界 → 次日 00:00 市场本地 */
    endEpochSec: Math.floor(endUtcMs / 1000),
  };
}

/** TikTok 订单列表可能嵌套在 data.data 或单层 data 下，兼容多路径 */
function extractOrdersList(resp) {
  if (!resp || typeof resp !== 'object') return [];
  const candidates = [
    resp?.data?.orders,
    resp?.data?.order_list,
    resp?.orders,
    resp?.order_list,
    resp?.data?.data?.orders,
    resp?.data?.data?.order_list,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function extractNextPageToken(resp) {
  if (!resp || typeof resp !== 'object') return '';
  const candidates = [
    resp?.data?.data?.next_page_token,
    resp?.data?.next_page_token,
    resp?.next_page_token,
    resp?.data?.data?.page_token,
    resp?.data?.page_token,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c);
  }
  return '';
}

function resolveOrdersPagePayload(ret) {
  const expandRoots = (obj) => {
    if (!obj || typeof obj !== 'object') return [];
    const out = [obj];
    const inner = obj?.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      out.push(inner);
      const inner2 = inner?.data;
      if (inner2 && typeof inner2 === 'object' && !Array.isArray(inner2)) out.push(inner2);
    }
    return out;
  };

  const candidates = [];
  for (const top of [ret?.data, ret?.debug?.responseData].filter((x) => x && typeof x === 'object')) {
    candidates.push(...expandRoots(top));
  }

  for (const root of candidates) {
    const listRaw = extractOrdersList(root);
    const nextToken = extractNextPageToken(root);
    if (listRaw.length > 0 || nextToken) {
      const response_data_keys = root && typeof root === 'object' ? Object.keys(root) : [];
      const response_data_data_keys =
        root?.data && typeof root.data === 'object' ? Object.keys(root.data) : [];
      return { root, listRaw, nextToken, response_data_keys, response_data_data_keys };
    }
  }

  const root = candidates[0] || ret?.data || {};
  const response_data_keys = root && typeof root === 'object' ? Object.keys(root) : [];
  const response_data_data_keys =
    root?.data && typeof root.data === 'object' ? Object.keys(root.data) : [];
  return {
    root,
    listRaw: extractOrdersList(root),
    nextToken: extractNextPageToken(root),
    response_data_keys,
    response_data_data_keys,
  };
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickRawOrders(apiResponse) {
  return (
    apiResponse?.data?.orders ||
    apiResponse?.data?.order_list ||
    apiResponse?.orders ||
    apiResponse?.order_list ||
    []
  );
}

function pickTotalCount(apiResponse, rawOrders) {
  const n = Number(
    apiResponse?.data?.total_count ??
      apiResponse?.total_count ??
      apiResponse?.data?.count ??
      apiResponse?.count ??
      rawOrders.length,
  );
  return Number.isFinite(n) ? n : rawOrders.length;
}

function pickAmountAndCurrency(raw) {
  const payment = raw?.payment || raw?.payment_info || {};
  const lineItems = Array.isArray(raw?.line_items)
    ? raw.line_items
    : Array.isArray(raw?.order_line_list)
      ? raw.order_line_list
      : [];

  const totalAmount = toNum(payment?.total_amount);
  const originalTotalProductPrice = toNum(payment?.original_total_product_price);
  const subTotal = toNum(payment?.sub_total);
  const buyerServiceFee = toNum(payment?.buyer_service_fee);
  const shippingFee = toNum(payment?.shipping_fee);

  let amount = totalAmount;
  if (amount <= 0) amount = originalTotalProductPrice;
  if (amount <= 0) amount = subTotal;

  if (amount <= 0) {
    const sumSalePrice = lineItems.reduce((s, it) => s + toNum(it?.sale_price) * Math.max(1, toNum(it?.quantity || 1)), 0);
    const sumOriginalPrice = lineItems.reduce(
      (s, it) => s + toNum(it?.original_price) * Math.max(1, toNum(it?.quantity || 1)),
      0,
    );
    amount = sumSalePrice > 0 ? sumSalePrice : sumOriginalPrice;
  }

  if (amount > 0 && (buyerServiceFee > 0 || shippingFee > 0)) {
    amount = amount + buyerServiceFee + shippingFee;
  }

  const firstLine = lineItems[0] || {};
  const currency = String(
    payment?.currency || raw?.currency || firstLine?.currency || firstLine?.currency_code || '',
  ).toUpperCase();

  return {
    amount: toNum(amount),
    currency,
    payment,
    firstLineItem: firstLine,
  };
}

function shopCipherFromRecord(shop) {
  const raw = shop?.rawTokenPayload || {};
  return String(shop?.shopCipher || shop?.shop_cipher || raw.shop_cipher || '').trim();
}

function getOrderId(order) {
  return String(order?.order_id ?? order?.orderId ?? order?.id ?? order?.order_sn ?? '');
}

function getOrderCreateTime(order) {
  return Number(
    order?.create_time ??
      order?.createTime ??
      order?.create_time_sec ??
      order?.createTimeSec ??
      order?._raw?.create_time ??
      order?._raw?.createTime ??
      0,
  );
}

function normalizeOrder(shop, raw) {
  const source = raw?.order && typeof raw.order === 'object' ? raw.order : raw;
  const rawItems = Array.isArray(source?.line_items)
    ? source.line_items
    : Array.isArray(source?.order_line_list)
      ? source.order_line_list
      : Array.isArray(source?.items)
        ? source.items
        : [];
  const items = rawItems.map((it) => {
    const quantity = Number(it?.quantity ?? it?.quantity_sold ?? it?.count ?? 0);
    const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
    return {
    product_name: String(it?.product_name || it?.title || ''),
    sku_name: String(it?.sku_name || ''),
    quantity: safeQuantity,
    sale_price: Number(it?.sale_price || it?.price || it?.item_price || 0),
    original_price: Number(it?.original_price || 0),
    currency: String(it?.currency || it?.currency_code || '').toUpperCase(),
    product_id: String(it?.product_id || it?.id || ''),
    sku_id: String(it?.sku_id || ''),
    }
  });
  const parsed = pickAmountAndCurrency(source);
  const status = String(source?.status || source?.display_status || source?.order_status || '').toLowerCase();
  const region = String(source?.recipient_address?.region_code || shop?.region || '').toUpperCase();
  const currency =
    inferOrderCurrency({
      currency: parsed.currency,
      payment: parsed.payment,
      line_items: rawItems,
      market: shop?.region,
      region,
      recipient_address: source?.recipient_address,
    }) || String(parsed.currency || shop?.currency || '').trim().toUpperCase();
  const orderAmountBase = Number(
    parsed.amount || source?.payment?.total_amount || source?.payment?.sub_total || source?.total_amount || 0,
  );
  return {
    orderId: String(source?.id || getOrderId(source)),
    id: String(source?.id || getOrderId(source)),
    shopId: shop.shopId,
    shopName: shop.shopName,
    region,
    platform: 'TikTok',
    currency: String(currency || '').toUpperCase(),
    orderStatus: status || 'unknown',
    orderAmountBase,
    orderAmountTarget: orderAmountBase,
    createTime: getOrderCreateTime(source) || source?.create_at || '',
    orderTime: getOrderCreateTime(source) || source?.create_at || '',
    updateTime: source?.update_time || source?.update_at || '',
    paymentTime: source?.paid_time || source?.payment_time || '',
    paidTime: source?.paid_time || source?.payment_time || '',
    totalAmount: orderAmountBase,
    itemAmount: Number(source?.item_amount || source?.product_amount || 0),
    shippingAmount: Number(source?.shipping_amount || 0),
    customerName: String(source?.recipient_address?.name || ''),
    items,
    products: rawItems,
    // Backward compatibility for existing payload adapters.
    productItems: items.map((it) => ({
      productId: it.product_id,
      productName: it.product_name,
      skuId: it.sku_id,
      skuName: it.sku_name,
      quantity: Math.max(0, Math.round(Number(it.quantity || 0))),
      itemPrice: Number(it.sale_price || 0),
      itemTotalAmount: Number((it.sale_price || 0) * Math.max(0, Number(it.quantity || 0))),
    })),
    _raw: source,
  };
}

async function fetchOrdersInTimeRange(shop, opts = {}) {
  const hardDeadlineMs = opts.deadlineMs != null && Number.isFinite(Number(opts.deadlineMs)) ? Number(opts.deadlineMs) : null;
  const logPrefix = String(opts.logPrefix || '').trim();
  const log = (...args) => (logPrefix ? console.log(logPrefix, ...args) : console.log(...args));
  const region = String(shop?.region || shop?.market || '').trim().toUpperCase();
  const offsetHours =
    opts.offsetHours != null && Number.isFinite(Number(opts.offsetHours))
      ? Number(opts.offsetHours)
      : getMarketOffsetHours(region);

  let range;
  if (Number.isFinite(Number(opts.startEpochSec)) && Number.isFinite(Number(opts.endEpochSec))) {
    range = { startEpochSec: Number(opts.startEpochSec), endEpochSec: Number(opts.endEpochSec) };
  } else if (opts.dateYmd) {
    range = getCalendarDayRangeByOffsetHours(opts.dateYmd, offsetHours);
  } else {
    range = getTodayRangeByOffsetHours(offsetHours);
  }

  const start = range.startEpochSec;
  const end = range.endEpochSec;
  const requestBody = {
    create_time_ge: start,
    create_time_lt: end,
  };
  log('[orders][debug] endpoint:', ORDER_SEARCH_PATH);
  log(
    '[orders][debug] requestTimeRange:',
    JSON.stringify(
      {
        region,
        create_time_ge: start,
        create_time_lt: end,
        create_time_ge_readable: dayjs.unix(start).format('YYYY-MM-DD HH:mm:ss'),
        create_time_lt_readable: dayjs.unix(end).format('YYYY-MM-DD HH:mm:ss'),
      },
      null,
      2,
    ),
  );
  let pageToken = '';
  let pageSize = 100;
  const maxPages = 20;
  const out = [];
  const seenOrderIds = new Set();
  const requestPages = [];
  let missingOrderIdCount = 0;
  const cipher = shopCipherFromRecord(shop);
  if (!cipher) {
    return {
      ok: false,
      error: { type: 'shop_cipher_missing', message: 'shop_cipher_missing' },
      debug: {
        finalUrl: '',
        pathForSign: ORDER_SEARCH_PATH,
        signKeys: ['app_key', 'timestamp', 'shop_cipher'],
        bodyForSign: '',
        status: 0,
        body: 'shop_cipher_missing',
      },
    };
  }
  for (let i = 0; i < maxPages; i += 1) {
    if (hardDeadlineMs != null && Date.now() > hardDeadlineMs) {
      log('[orders] deadline reached, stop pagination');
      break;
    }
    const query = {
      shop_cipher: cipher,
      page_size: pageSize,
      ...(pageToken ? { page_token: pageToken } : {}),
    };

    const ret = await requestShopApi(shop, {
      method: 'POST',
      pathname: ORDER_SEARCH_PATH,
      query,
      body: requestBody,
      includeDebug: true,
    });

    const pagePayload = resolveOrdersPagePayload(ret);
    const rawPayload = (() => {
      try {
        return JSON.parse(String(ret?.debug?.rawBody || '{}'));
      } catch {
        return ret?.debug?.rawBody || {};
      }
    })();
    const listRawByApiResponse = pickRawOrders(rawPayload);
    const listRaw = Array.isArray(listRawByApiResponse) && listRawByApiResponse.length > 0 ? listRawByApiResponse : pagePayload.listRaw;
    const nextToken = pagePayload.nextToken;
    const orders_count_api = listRaw.length;
    const totalCount = pickTotalCount(rawPayload, listRaw);
    const firstOrder = listRaw[0] || {};
    log('[orders] api status:', Number(ret.debug?.status ?? ret.error?.httpStatus ?? 0));
    log(
      '[orders][debug] requestMeta:',
      JSON.stringify(
        {
          endpoint: ORDER_SEARCH_PATH,
          ...(ret?.debug?.requestMeta || {}),
          finalUrl: ret?.debug?.requestMeta?.safeFinalUrl || ret?.debug?.finalUrl || '',
          page: i + 1,
          page_size: pageSize,
          page_token: pageToken || '',
          request_query: query,
          request_body: requestBody,
          response_http_status: ret?.debug?.responseHttpStatus ?? ret?.debug?.status ?? ret?.error?.httpStatus ?? 0,
          response_code: ret?.debug?.responseCode ?? ret?.error?.code ?? null,
          response_message: ret?.debug?.responseMessage ?? ret?.error?.message ?? '',
          total_count: totalCount,
          raw_orders_length: orders_count_api,
          has_next_page_token: Boolean(nextToken),
          next_page_token: nextToken || '',
          has_permission_error:
            String(ret?.debug?.responseMessage || ret?.error?.message || '')
              .toLowerCase()
              .includes('permission') ||
            String(ret?.debug?.responseMessage || ret?.error?.message || '')
              .toLowerCase()
              .includes('scope'),
          has_region_error:
            String(ret?.debug?.responseMessage || ret?.error?.message || '')
              .toLowerCase()
              .includes('region'),
        },
        null,
        2,
      ),
    );
    log('[orders] total_count:', totalCount);
    log('[orders] rawOrders.length:', orders_count_api);
    log(
      '[orders][debug] firstOrderPreview:',
      JSON.stringify(
        {
          id: firstOrder?.id || firstOrder?.order_id || '',
          status: firstOrder?.status || firstOrder?.display_status || firstOrder?.order_status || '',
          total_amount: firstOrder?.payment?.total_amount ?? null,
          currency: firstOrder?.payment?.currency || firstOrder?.currency || '',
          create_time: firstOrder?.create_time || '',
          update_time: firstOrder?.update_time || '',
        },
        null,
        2,
      ),
    );

    if (!ret.ok) {
      requestPages.push({
        page: i + 1,
        page_token_used: pageToken || '',
        response_code: ret.debug?.responseCode ?? ret.error?.code ?? null,
        response_message: ret.debug?.responseMessage ?? ret.error?.message ?? '',
        orders_count: orders_count_api,
        orders_count_api,
        orders_extracted_count: 0,
        missing_order_id_count: 0,
        response_data_keys: pagePayload.response_data_keys,
        response_data_data_keys: pagePayload.response_data_data_keys,
        next_page_token: nextToken,
      });
      const errMsg = String(ret?.error?.message || ret?.debug?.responseMessage || '').toLowerCase();
      if (pageSize === 100 && (errMsg.includes('page_size') || errMsg.includes('page size'))) {
        pageSize = 50;
        pageToken = '';
        continue;
      }
      // Do not block collection when shopCipher missing; surface full debug upstream.
      return {
        ...ret,
        debug: ret.debug,
        requestPages,
        pagesFetched: requestPages.length,
        pageSize,
        requestBody,
        timeRangeUsed: {
          region,
          offset_hours: offsetHours,
          date_ymd: opts.dateYmd || null,
          create_time_ge: start,
          create_time_lt: end,
        },
        status_filter_used: 'none',
        api_path: ORDER_SEARCH_PATH,
      };
    }

    const normalized = listRaw.map((x) => normalizeOrder(shop, x));
    let orders_extracted_count = 0;
    let missing_order_id_count = 0;
    for (const row of normalized) {
      const id = getOrderId(row);
      if (!id) {
        missingOrderIdCount += 1;
        missing_order_id_count += 1;
        continue;
      }
      if (seenOrderIds.has(id)) continue;
      seenOrderIds.add(id);
      out.push(row);
      orders_extracted_count += 1;
    }
    log('[orders] fetched:', orders_count_api);
    log('[orders] saved:', out.length);
    log('[orders] nextPage:', Boolean(nextToken));

    requestPages.push({
      page: i + 1,
      page_token_used: pageToken || '',
      response_code: ret.debug?.responseCode ?? ret.error?.code ?? null,
      response_message: ret.debug?.responseMessage ?? ret.error?.message ?? '',
      orders_count: orders_count_api,
      orders_count_api,
      orders_extracted_count,
      missing_order_id_count,
      response_data_keys: pagePayload.response_data_keys,
      response_data_data_keys: pagePayload.response_data_data_keys,
      next_page_token: nextToken,
    });

    pageToken = nextToken;
    if (!pageToken || listRaw.length === 0) break;
  }
  return {
    ok: true,
    data: out,
    pagesFetched: requestPages.length,
    uniqueOrders: seenOrderIds.size,
    missingOrderIdCount,
    requestBody,
    requestPages,
    pageSize,
    timeRangeUsed: {
      region,
      offset_hours: offsetHours,
      date_ymd: opts.dateYmd || null,
      create_time_ge: start,
      create_time_lt: end,
      create_time_ge_readable: dayjs.unix(start).format('YYYY-MM-DD HH:mm:ss'),
      create_time_lt_readable: dayjs.unix(end).format('YYYY-MM-DD HH:mm:ss'),
    },
    status_filter_used: 'none（未传 order_status；含待发货/COD 等全状态）',
    api_path: ORDER_SEARCH_PATH,
  };
}

async function fetchTodayOrders(shop, opts = {}) {
  return fetchOrdersInTimeRange(shop, opts);
}

const {
  isOrderApiScopeError,
  classifyOrderSyncApiFailure,
} = require('../lib/openApiWorkerEligibility');

module.exports = {
  isOrderApiScopeError,
  classifyOrderSyncApiFailure,
  fetchTodayOrders,
  fetchOrdersInTimeRange,
  getMarketOffsetHours,
  getCalendarDayRangeByOffsetHours,
  getTodayRangeByOffsetHours,
  ORDER_SEARCH_PATH,
  pickAmountAndCurrency,
};

