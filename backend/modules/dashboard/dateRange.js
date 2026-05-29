'use strict';

/**
 * 大屏统一时间窗（与 lib/dashboardTimeRange.js、前端 dashboardBounds 对齐）
 */
const { normalizeRange, getTimeRangeBounds } = require('../../lib/dashboardTimeRange');

/**
 * @param {Record<string, unknown>} [q]
 * @returns {{
 *   range: string,
 *   startDate: string,
 *   endDate: string,
 *   startSec: number,
 *   endSec: number,
 *   customInvalid?: boolean,
 * }}
 */
function resolveDashboardDateRange(q = {}) {
  const raw =
    q.timeRange != null && String(q.timeRange).trim() !== ''
      ? String(q.timeRange)
      : q.range != null
        ? String(q.range)
        : 'today';
  const range = normalizeRange(raw);
  const startDate = q.startDate != null ? String(q.startDate).trim() : '';
  const endDate = q.endDate != null ? String(q.endDate).trim() : '';
  const tb = getTimeRangeBounds(range, startDate || undefined, endDate || undefined);
  return {
    range: tb.range,
    startDate: String(tb.startDate ?? startDate ?? ''),
    endDate: String(tb.endDate ?? endDate ?? ''),
    startSec: tb.startSec,
    endSec: tb.endSec,
    customInvalid: tb.customInvalid === true,
  };
}

module.exports = {
  resolveDashboardDateRange,
  normalizeRange,
  getTimeRangeBounds,
};
