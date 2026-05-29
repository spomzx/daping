'use strict';

/**
 * 趋势行展示归一化（纯函数，无 dashboard/analytics service 依赖，避免循环 require）。
 */

function formatTrendHourLabel(timeStr) {
  const s = String(timeStr || '').trim();
  const m = /\s(\d{2}):00:00$/.exec(s) || /^(\d{2}):00/.exec(s);
  if (m) return `${m[1]}:00`;
  if (s.length >= 16) return s.slice(11, 16);
  return s || '00:00';
}

function normalizeTrendRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    hour: formatTrendHourLabel(r.time),
    gmv_usd: Number(Number(r.gmv || 0).toFixed(2)),
    order_count: Number(r.orders) || 0,
    time: r.time,
    orders: r.orders,
    gmv: r.gmv,
    gmv_currency: r.gmv_currency || 'USD',
    items: r.items,
  }));
}

module.exports = {
  formatTrendHourLabel,
  normalizeTrendRows,
};
