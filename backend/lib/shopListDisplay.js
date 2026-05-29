'use strict';

/**
 * GET /api/shops 列表展示契约：display / health_label / sync_label + 覆盖陈旧 token 字段
 */

const { applyAuthContractDisplay } = require('./shopAuthContract');
const { looksLikeStaleAuthState } = require('./staleAuthHealthRepair');

const HEALTH_LABELS = {
  normal: '正常',
  no_orders_today: '今日无单',
  auth_error: '授权异常',
  permission_error: '权限异常',
  sync_stale: '同步停滞',
  sync_failed: '同步异常',
  sync_off: '同步已关闭',
  disabled: '已禁用',
  hidden: '已隐藏',
  order_cache_pending: '订单待同步',
};

const SYNC_LABELS = {
  idle: 'idle',
  success: 'success',
  partial_success: 'partial',
  syncing: 'syncing',
  failed: 'failed',
  retry_wait: 'retry',
  token_expired: 'token_expired',
  disabled: 'disabled',
};

/**
 * @param {Record<string, unknown>} row
 */
function deriveShopDisplay(row) {
  const health = String(row.health_status || row.last_health_status || '').toLowerCase();
  const orders = Number(row.today_orders ?? row.last_order_count ?? 0) || 0;

  if (health === 'no_orders_today') return 'today_no_orders';
  if (health === 'normal') return orders > 0 ? 'ok' : 'today_no_orders';
  if (health === 'auth_error' || health === 'permission_error') return 'auth_error';
  if (health === 'sync_failed' || health === 'sync_stale') return 'sync_error';
  if (health === 'sync_off') return 'sync_off';
  if (health === 'disabled') return 'disabled';
  if (health === 'hidden') return 'hidden';
  return health || 'unknown';
}

/**
 * @param {Record<string, unknown>} row
 */
function deriveSyncLabel(row) {
  const display = String(row.display || '').toLowerCase();
  if (display === 'today_no_orders' || display === 'ok') {
    const orders = Number(row.today_orders ?? 0) || 0;
    return orders > 0 ? SYNC_LABELS.success : SYNC_LABELS.idle;
  }
  const st = String(row.sync_status || '').toLowerCase();
  return SYNC_LABELS[st] || st || 'idle';
}

/**
 * @param {Record<string, unknown>} row
 */
function applyShopListDisplayContract(row) {
  let next = applyAuthContractDisplay({ ...row });

  const health = String(next.health_status || next.last_health_status || '').toLowerCase();
  if (health === 'no_orders_today' || health === 'normal') {
    next = {
      ...next,
      sync_status:
        Number(next.today_orders ?? 0) > 0
          ? 'success'
          : looksLikeStaleAuthState(next.sync_status, next.last_error, next.is_token_valid)
            ? 'idle'
            : next.sync_status || 'idle',
      is_token_valid: 1,
      last_error: null,
      last_error_full: null,
      last_error_code: null,
      queue_sync_status:
        Number(next.today_orders ?? 0) > 0 ? 'success' : 'idle',
    };
  }

  const display = deriveShopDisplay(next);
  const health_label = HEALTH_LABELS[health] || HEALTH_LABELS[String(next.health_status || '')] || health;
  const sync_label = deriveSyncLabel({ ...next, display });

  return {
    ...next,
    display,
    health_label,
    sync_label,
    /** 前端优先用 display，禁止用 last_error 覆盖 */
    display_priority: 'health_status_after',
  };
}

module.exports = {
  HEALTH_LABELS,
  deriveShopDisplay,
  deriveSyncLabel,
  applyShopListDisplayContract,
};
