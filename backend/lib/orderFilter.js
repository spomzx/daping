/**
 * 订单筛选：与 GMV 大屏 / mock 数据源共用
 * orderFilter: all | valid | unpaid | sample | cancelled
 *
 * MySQL `orders`：`order_status`、`raw_json` 用于入库时计算 `analytics_status`；
 * Analytics 查询仅按 `analytics_status` 列筛选（见 `analyticsFilter.buildAnalyticsFilter`）。
 * 历史 `mysqlOrdersFilterClause` 仍保留供非 Analytics 场景或调试参考。
 */

const { toCanonicalOrderStatus, ORDER_STATUS_MAP, KNOWN_ZH } = require('./orderStatusZh');

/** 未付款筛选：含待付款类 */
const UNPAID_CANON = new Set(['unpaid', 'awaiting_payment', 'pending_payment']);

/**
 * 不计入「有效订单」：已取消、挂起、退款、已退款、未付款（不含「待付款」类）
 * 与产品需求一致；样品订单单独 sample 筛选
 */
const EXCLUDED_FROM_VALID_CANON = new Set([
  'cancelled',
  'canceled',
  'buyer_cancel',
  'seller_cancel',
  'on_hold',
  'refund',
  'refunded',
  'unpaid',
  'unknown',
]);

/** 有效订单：履约/完成/在途/待付款（不含未付款 UNPAID） */
const VALID_CANON = new Set([
  'awaiting_shipment',
  'awaiting_collection',
  'partially_shipping',
  'in_transit',
  'delivered',
  'completed',
  'paid',
  'pending_payment',
  'awaiting_payment',
  'returned',
  'shipped',
  'ready_to_ship',
  'partially_shipped',
  'awaiting_package',
  'to_ship',
]);

/** @param {unknown} v */
function jsonScalarTruthy(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'number' && v !== 0 && Number.isFinite(v)) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
  }
  return false;
}

/** @param {Record<string, unknown>|null|undefined} node */
function sampleSignalsFromObject(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.isSample === true) return true;
  if (node.is_sample_order === true) return true;
  if (jsonScalarTruthy(node.is_sample_order)) return true;
  if (node.is_sample === true) return true;
  if (jsonScalarTruthy(node.is_sample)) return true;
  if (node.sample_order === true) return true;
  if (jsonScalarTruthy(node.sample_order)) return true;
  const ot = String(node.order_type ?? node.orderType ?? '')
    .trim()
    .toLowerCase();
  if (ot === 'sample') return true;
  /** TikTok Shop：SELLER_FUND_FREE_SAMPLE 等（避免宽泛的 includes('sample') 误伤 not_sample 等） */
  if (ot.includes('free_sample') || ot.includes('seller_fund_free_sample')) return true;
  if (ot.includes('affiliate') && ot.includes('sample')) return true;
  if (ot.includes('sample_order')) return true;
  return false;
}

/**
 * raw_json 文本级兜底（非法 JSON 或字段未在固定 path 上时）
 * @param {string} sj
 */
function rawJsonStringSuggestsSample(sj) {
  const s = String(sj || '');
  if (!s) return false;
  const low = s.toLowerCase();
  if (s.includes('样品订单')) return true;
  if (s.includes('样品') && (low.includes('sample') || low.includes('is_sample') || low.includes('sample_order'))) return true;
  /** 嵌套任意层级：宽松匹配 JSON 片段（与 SQL docRegexOr 互补） */
  if (/["']is_sample_order["']\s*:\s*(true|1)\b/i.test(s)) return true;
  if (/["']is_sample["']\s*:\s*(true|1)\b/i.test(s)) return true;
  if (/["']sample_order["']\s*:\s*(true|1)\b/i.test(s)) return true;
  if (/["']isSample["']\s*:\s*true\b/i.test(s)) return true;
  const needles = [
    '"is_sample_order":true',
    '"is_sample_order": true',
    '"is_sample_order":1',
    '"is_sample_order": 1',
    '"is_sample":true',
    '"is_sample": true',
    '"is_sample":1',
    '"sample_order":true',
    '"sample_order": true',
    '"sample_order":1',
    '"order_type":"sample',
    '"order_type": "sample',
    'order_type":"sample',
    'seller_fund_free_sample',
    'free_sample',
  ];
  for (const p of needles) {
    if (low.includes(p)) return true;
  }
  return false;
}

/** @param {unknown} statusRaw */
function orderStatusSuggestsSample(statusRaw) {
  const t = String(statusRaw ?? '').trim();
  if (!t) return false;
  if (t.includes('样品')) return true;
  return /sample/i.test(t);
}

/**
 * 与 `sqlSamplePredicate` 同口径：大屏 ordersDashboardFromCache、Analytics rowMatches、GMV 二次过滤共用。
 * @param {Record<string, unknown>} order
 */
function orderIsSampleOrder(order) {
  if (!order || typeof order !== 'object') return false;
  if (order.isSample === true) return true;
  if (order.is_sample_order === true) return true;
  const rawTop = order._raw;
  if (rawTop && typeof rawTop === 'object') {
    if (sampleSignalsFromObject(rawTop)) return true;
  }
  if (sampleSignalsFromObject(order)) return true;
  if (order.raw_json != null && rawJsonStringSuggestsSample(String(order.raw_json))) return true;
  if (orderStatusSuggestsSample(order.orderStatus ?? order.order_status ?? order.status)) return true;
  try {
    if (rawJsonStringSuggestsSample(JSON.stringify(order))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 取消订单：与需求列出的状态一致（含包含 cancel 的 snake_case）
 * @param {unknown} statusRaw
 */
function orderIsCancelledStatus(statusRaw) {
  const raw = String(statusRaw ?? '').trim();
  if (!raw) return false;
  if (raw === '已取消' || raw === '买家取消' || raw === '卖家取消') return true;
  const lower = raw.toLowerCase();
  const exact = new Set(['cancelled', 'canceled', 'buyer_cancel', 'seller_cancel', 'cancel']);
  if (exact.has(lower)) return true;
  if (lower.includes('cancel')) return true;
  const upper = raw.toUpperCase();
  if (upper === 'CANCELLED' || upper === 'CANCELED') return true;
  return false;
}

/**
 * @param {unknown} statusRaw - orderStatus / status
 * @param {string} orderFilter - all | valid | unpaid
 */
function orderMatchesFilterStatus(statusRaw, orderFilter) {
  const f = String(orderFilter || 'all').toLowerCase();
  const raw = String(statusRaw ?? '').trim();
  if (!raw) {
    if (f === 'all') return true;
    return false;
  }
  if (f === 'all') return true;

  const canon = toCanonicalOrderStatus(statusRaw);

  if (f === 'unpaid') {
    return UNPAID_CANON.has(canon);
  }

  if (f === 'valid') {
    if (!canon) return false;
    if (EXCLUDED_FROM_VALID_CANON.has(canon)) return false;
    return VALID_CANON.has(canon);
  }

  return true;
}

/**
 * @param {Record<string, unknown>} order - 原始或缓存订单对象
 * @param {string} orderFilter
 */
function orderMatchesOrderFilter(order, orderFilter) {
  const f = normalizeOrderFilter(orderFilter);
  if (f === 'all') return true;
  if (f === 'sample') return orderIsSampleOrder(order);
  if (f === 'cancelled') return orderIsCancelledStatus(order?.orderStatus ?? order?.status);
  return orderMatchesFilterStatus(order?.orderStatus ?? order?.status, f);
}

/**
 * 入库 / 迁移用：互斥归类到 `orders.analytics_status`（与历史 SQL valid 口径一致：样品 > 取消 > 未付 > 有效）。
 * 不在 Analytics 查询中解析 raw_json；此处仅在写入或一次性回填时调用。
 * @param {Record<string, unknown>} order
 * @returns {'valid'|'unpaid'|'sample'|'cancelled'|'other'}
 */
function deriveAnalyticsStatusFromOrder(order) {
  if (!order || typeof order !== 'object') return 'other';
  if (orderIsSampleOrder(order)) return 'sample';
  const statusField = order.orderStatus ?? order.order_status ?? order.status;
  if (orderIsCancelledStatus(statusField)) return 'cancelled';
  const canon = toCanonicalOrderStatus(statusField);
  if (UNPAID_CANON.has(canon)) return 'unpaid';
  const osTrim = String(statusField ?? '').trim();
  if (!osTrim) return 'other';
  if (EXCLUDED_FROM_VALID_CANON.has(canon)) return 'other';
  if (VALID_CANON.has(canon)) return 'valid';
  return 'other';
}

/**
 * @param {{ order_status?: unknown, raw_json?: unknown }} row
 * @returns {'valid'|'unpaid'|'sample'|'cancelled'|'other'}
 */
function deriveAnalyticsStatusFromMysqlRow(row) {
  const statusStr = String(row?.order_status ?? '').trim();
  let parsed = {};
  try {
    if (row?.raw_json != null && String(row.raw_json).trim() !== '') {
      parsed = JSON.parse(String(row.raw_json));
    }
  } catch (_) {
    parsed = {};
  }
  const rawTop = parsed && typeof parsed === 'object' ? parsed : {};
  const innerRaw = rawTop._raw && typeof rawTop._raw === 'object' ? rawTop._raw : rawTop;
  const order = {
    ...rawTop,
    orderStatus: statusStr,
    order_status: statusStr,
    status: statusStr,
    raw_json: row?.raw_json,
    _raw: innerRaw,
  };
  return deriveAnalyticsStatusFromOrder(order);
}

function normalizeOrderFilter(value) {
  const s = String(value || 'all').toLowerCase();
  if (s === 'all' || s === 'unpaid' || s === 'valid' || s === 'sample' || s === 'cancelled') return s;
  return 'all';
}

/** 样品/取消视图下大屏 GMV 不计入（与需求一致） */
function orderFilterExcludesGmv(orderFilter) {
  const f = normalizeOrderFilter(orderFilter);
  return f === 'sample' || f === 'cancelled';
}

/** @param {(canon: string) => boolean} predicate */
function collectRawOrderStatusesForCanonPredicate(predicate) {
  const out = new Set();
  for (const raw of Object.keys(ORDER_STATUS_MAP)) {
    const c = toCanonicalOrderStatus(raw);
    if (!predicate(c)) continue;
    const s = String(raw).trim();
    if (s) out.add(s);
  }
  for (const raw of KNOWN_ZH) {
    const c = toCanonicalOrderStatus(raw);
    if (!predicate(c)) continue;
    const s = String(raw).trim();
    if (s) out.add(s);
  }
  for (const c of VALID_CANON) {
    if (predicate(c)) out.add(c);
  }
  for (const c of UNPAID_CANON) {
    if (predicate(c)) out.add(c);
  }
  return [...out].filter((s) => s != null && String(s).trim() !== '');
}

function sqlCancelledPredicate(alias) {
  const a = alias;
  return `(TRIM(${a}.order_status) IN ('已取消','买家取消','卖家取消') OR LOWER(TRIM(${a}.order_status)) IN ('cancelled','canceled','buyer_cancel','seller_cancel','cancel') OR LOWER(TRIM(${a}.order_status)) LIKE '%cancel%' OR UPPER(TRIM(${a}.order_status)) IN ('CANCELLED','CANCELED'))`;
}

/**
 * MySQL WHERE 内联条件（不含外层括号）；与 orderIsSampleOrder 对齐。
 * 含根字段与 `raw_json.$._raw`（双写整单 JSON 时 TikTok 源字段常见于此）。
 * @param {string} alias
 */
function sqlSamplePredicate(alias) {
  const a = alias;
  const rj = `${a}.raw_json`;
  const os = `TRIM(COALESCE(${a}.order_status,''))`;

  /** @param {string} jsonPath */
  function jBool(jsonPath) {
    return `LOWER(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(${rj}, '${jsonPath}')), 'false')) IN ('true','1','yes')`;
  }
  /** order_type：精确 sample + TikTok 常见枚举（不用裸 LIKE '%sample%'，避免 not_sample 误命中） */
  function jOrderTypeSampleLike(jsonPath) {
    const ex = `LOWER(TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(${rj}, '${jsonPath}')), '')))`;
    return `(
      (${ex} = 'sample')
      OR (${ex} LIKE '%seller_fund_free_sample%')
      OR (${ex} LIKE '%free_sample%')
      OR (${ex} LIKE '%sample_order%')
      OR ((${ex} LIKE '%affiliate%') AND (${ex} LIKE '%sample%'))
    )`;
  }

  const statusOr = `(${os} LIKE '%样品%' OR LOWER(${os}) LIKE '%sample%' OR LOWER(${os}) LIKE '%free_sample%')`;

  const jsonOr = [
    jBool('$.is_sample_order'),
    jBool('$.is_sample'),
    jBool('$.sample_order'),
    jBool('$.isSample'),
    jOrderTypeSampleLike('$.order_type'),
    jOrderTypeSampleLike('$.orderType'),
    jBool('$._raw.is_sample_order'),
    jBool('$._raw.is_sample'),
    jBool('$._raw.sample_order'),
    jBool('$._raw.isSample'),
    jOrderTypeSampleLike('$._raw.order_type'),
    jOrderTypeSampleLike('$._raw.orderType'),
  ].join(' OR ');

  const likeOr = [
    `IFNULL(${rj},'') LIKE '%样品订单%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"is_sample_order":true%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"is_sample_order": true%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"is_sample_order":1%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"is_sample_order": 1%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"is_sample":true%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"is_sample": true%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"is_sample":1%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"sample_order":true%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"sample_order": true%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"sample_order":1%'`,
    `IFNULL(${rj},'') LIKE '%"isSample":true%'`,
    `IFNULL(${rj},'') LIKE '%"isSample": true%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"order_type":"sample%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"order_type": "sample%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%order_type":"sample%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"ordertype":"sample%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%"ordertype": "sample%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%seller_fund_free_sample%'`,
    `LOWER(IFNULL(${rj},'')) LIKE '%free_sample%'`,
  ]
    .map((x) => `(${x})`)
    .join(' OR ');

  /**
   * CASE：先判 order_status（廉价），再 JSON_EXTRACT，最后 LIKE 兜底；避免对命中状态列的行全表扫 raw_json / REGEXP。
   * WHERE 仍由调用方保证 tenant / 时间窗 / market / shop 在前（见 analytics SQL）。
   */
  return `(CASE WHEN (${statusOr}) THEN 1 WHEN (${jsonOr}) THEN 1 WHEN (${likeOr}) THEN 1 ELSE 0 END = 1)`;
}

/**
 * @param {string} alias
 * @param {string[]} uniq
 */
function sqlTrimOrderStatusIn(alias, uniq) {
  const list = [...new Set(uniq.map((v) => String(v).trim()).filter(Boolean))];
  if (list.length === 0) return { sql: '1=0', params: [] };
  const ph = list.map(() => '?').join(',');
  return { sql: `TRIM(${alias}.order_status) IN (${ph})`, params: list };
}

/**
 * MySQL WHERE 片段（含前导 AND），与 orderMatchesOrderFilter 对齐（orders.order_status + raw_json）。
 * @param {string} alias - orders 表别名，如 o
 * @param {unknown} qStatus - 请求参数 status（或兼容 orderFilter）
 */
function mysqlOrdersFilterClause(alias, qStatus) {
  const f = normalizeOrderFilter(qStatus);
  if (f === 'all') return { sql: '', params: [] };

  const a = alias;

  if (f === 'cancelled') {
    return { sql: ` AND (${sqlCancelledPredicate(a)})`, params: [] };
  }

  if (f === 'sample') {
    return { sql: ` AND (${sqlSamplePredicate(a)})`, params: [] };
  }

  if (f === 'unpaid') {
    const vals = collectRawOrderStatusesForCanonPredicate((c) => UNPAID_CANON.has(c));
    const { sql: inSql, params } = sqlTrimOrderStatusIn(a, vals);
    return { sql: ` AND (${inSql})`, params };
  }

  if (f === 'valid') {
    const vals = collectRawOrderStatusesForCanonPredicate((c) => {
      if (!c) return false;
      if (EXCLUDED_FROM_VALID_CANON.has(c)) return false;
      return VALID_CANON.has(c);
    });
    const { sql: inSql, params: inParams } = sqlTrimOrderStatusIn(a, vals);
    return {
      sql: ` AND NOT (${sqlCancelledPredicate(a)}) AND NOT (${sqlSamplePredicate(a)}) AND (${inSql}) AND TRIM(COALESCE(${a}.order_status,'')) <> ''`,
      params: [...inParams],
    };
  }

  return { sql: '', params: [] };
}

module.exports = {
  orderMatchesFilterStatus,
  orderMatchesOrderFilter,
  normalizeOrderFilter,
  orderIsSampleOrder,
  orderIsCancelledStatus,
  orderFilterExcludesGmv,
  mysqlOrdersFilterClause,
  sqlSamplePredicate,
  deriveAnalyticsStatusFromOrder,
  deriveAnalyticsStatusFromMysqlRow,
};
