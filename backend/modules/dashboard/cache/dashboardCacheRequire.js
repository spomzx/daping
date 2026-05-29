'use strict';

/**
 * 延迟加载 lib/dashboardCache，打断 metricService ↔ orderMetricsService ↔ dashboardCache 环。
 */

/** @type {typeof import('../../../lib/dashboardCache').withDashboardCache | null} */
let withDashboardCacheFn = null;

function getWithDashboardCache() {
  if (!withDashboardCacheFn) {
    withDashboardCacheFn = require('../../../lib/dashboardCache').withDashboardCache;
  }
  return withDashboardCacheFn;
}

module.exports = { getWithDashboardCache };
