'use strict';

const { buildAnalyticsFilter } = require('../../lib/analyticsFilter');
const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');

function afOpts(_auth) {
  return strictAnalyticsFilterOpts();
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {{ hours?: number, market?: string, shop_id?: string, status?: string }} q
 * @param {unknown} auth
 */
async function querySummary(pool, tenantId, q, auth) {
  const { normalizeRange, getTimeRangeBounds } = require('../../lib/dashboardTimeRange');
  const rangeNorm = normalizeRange(q.range || 'today');
  const tb = getTimeRangeBounds(rangeNorm, q.startDate, q.endDate);
  const af = await buildAnalyticsFilter(
    pool,
    tenantId,
    {
      ...q,
      range: rangeNorm,
      analytics_time_from_epoch_sec: tb.startSec,
      analytics_time_until_epoch_sec: tb.endSec,
    },
    afOpts(auth),
  );
  if (af.invalidShop) {
    return { orders: 0, gmv: 0, shop_count: 0, hours };
  }
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) AS orders,
            COALESCE(SUM(o.total_amount), 0) AS gmv,
            COUNT(DISTINCT o.shop_id) AS shop_count
     FROM orders o
     WHERE 1=1${af.sql}`,
    af.params,
  );
  const row = rows && rows[0] ? rows[0] : {};
  return {
    orders: Number(row.orders) || 0,
    gmv: Number(row.gmv) || 0,
    shop_count: Number(row.shop_count) || 0,
    range: rangeNorm,
    hours: Math.min(720, Math.max(1, Number(q.hours) || 24)),
    source: 'mysql',
  };
}

module.exports = { querySummary, afOpts };
