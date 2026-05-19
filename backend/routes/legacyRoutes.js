'use strict';

/**
 * Legacy API 集中注册（war-room 大屏等）。
 * SaaS / Ops 页面禁止调用；仅 /legacy 与回滚兼容。
 */

const { registerLegacyWarRoomDashboard } = require('./legacyDashboardRoutes');

function registerLegacyRoutes(app, options = {}) {
  const storageDir = options.storageDir;
  if (!storageDir) {
    throw new Error('registerLegacyRoutes requires storageDir');
  }
  registerLegacyWarRoomDashboard(app, storageDir);
}

module.exports = { registerLegacyRoutes };
