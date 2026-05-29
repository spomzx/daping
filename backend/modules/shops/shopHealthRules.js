'use strict';

/** 计入「异常店铺」：授权/API/任务失败（不含同步停滞、今日无单） */
const ABNORMAL_HEALTH = new Set(['auth_error', 'permission_error', 'region_error', 'sync_failed']);

/** 同步停滞：授权仍有效，但超过阈值无成功 OpenAPI */
const SYNC_STALE_HEALTH = new Set(['sync_stale']);

function isAbnormalHealthStatus(status) {
  return ABNORMAL_HEALTH.has(String(status || ''));
}

function isSyncStaleHealthStatus(status) {
  return SYNC_STALE_HEALTH.has(String(status || ''));
}

/**
 * @param {string} errMsg
 * @returns {'auth_error'|'permission_error'|'region_error'|'sync_failed'|'sync_stale'}
 */
function classifySyncError(errMsg) {
  const e = String(errMsg || '').toLowerCase();
  if (!e) return 'sync_stale';
  if (e.includes('timeout') || e.includes('timed out') || e.includes('etimedout') || e.includes('deadline')) {
    return 'sync_failed';
  }
  if (e.includes('region')) return 'region_error';
  if (e.includes('permission') || e.includes('scope') || e.includes('forbidden')) {
    return 'permission_error';
  }
  if (
    e.includes('token') ||
    e.includes('expired') ||
    e.includes('refresh') ||
    e.includes('unauthorized') ||
    e.includes('access_denied') ||
    e.includes('invalid access')
  ) {
    return 'auth_error';
  }
  return 'sync_failed';
}

function isAuthClassStatus(status) {
  const s = String(status || '');
  return s === 'auth_error' || s === 'permission_error' || s === 'region_error';
}

function toHealthReportRow(row) {
  return {
    shopId: row.id,
    shopName: row.shop_name,
    market: row.market,
    healthStatus: row.health_status,
    reason: row.health_reason,
    lastSyncAt: row.latest_sync_attempt_at || row.last_sync_at || null,
    lastOrderAt: row.latest_order_at || row.last_order_seen_at || null,
    lastApiSuccessAt: row.latest_sync_success_at || null,
    todayOrders: Number(row.today_orders) || 0,
    healthRule: row.health_rule || null,
    isAbnormal: isAbnormalHealthStatus(row.health_status),
  };
}

module.exports = {
  ABNORMAL_HEALTH,
  SYNC_STALE_HEALTH,
  isAbnormalHealthStatus,
  isSyncStaleHealthStatus,
  classifySyncError,
  isAuthClassStatus,
  toHealthReportRow,
};
