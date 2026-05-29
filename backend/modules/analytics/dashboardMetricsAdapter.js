'use strict';

/**
 * Analytics 侧统一 KPI 编排入口（实现见 lib/metricsAuthority.js）。
 * dashboard 模块请 require lib/metricsAuthority，勿 require 本文件，避免 analytics↔dashboard 环。
 */
module.exports = require('../../lib/metricsAuthority');
