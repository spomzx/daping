'use strict';

/** 手动同步 / Sync API：禁止 raw code 直出前端 */
const CODE_MESSAGES = {
  shop_not_found_or_not_eligible: '店铺不存在或未启用同步',
  shop_not_found: '店铺不存在或未启用同步',
  shop_forbidden: '无权限操作该店铺',
  sync_forbidden: '无手动同步权限',
  rate_limited: '同步频率过高，请稍后重试',
  storage_lock_timeout: '同步任务正在执行中，请稍后查看',
  storage_lock: '同步任务正在执行中，请稍后查看',
  missing_token: '缺少授权 Token',
  missing_access_token: '缺少授权 Token',
  token_missing: '缺少授权 Token',
  token_expired: '授权已过期',
  missing_shop_cipher: '缺少店铺授权信息',
  shop_cipher_missing: '缺少店铺授权信息',
  sync_disabled: '店铺未开启订单同步',
  shop_disabled: '店铺未启用',
  shop_hidden: '店铺已隐藏',
  missing_market: '店铺市场未配置',
  forbidden: '无操作权限',
};

/**
 * @param {string} [code]
 * @param {string} [message]
 */
function mapSyncApiMessage(code, message) {
  const c = String(code || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (CODE_MESSAGES[c]) return CODE_MESSAGES[c];
  const m = String(message || '').trim();
  const mk = m.toLowerCase().replace(/\s+/g, '_');
  if (CODE_MESSAGES[mk]) return CODE_MESSAGES[mk];
  if (/rate.?limit/i.test(m)) return CODE_MESSAGES.rate_limited;
  if (/storage_lock/i.test(m)) return CODE_MESSAGES.storage_lock_timeout;
  if (/shop_not_found|not_eligible/i.test(m)) return CODE_MESSAGES.shop_not_found_or_not_eligible;
  if (/^[a-z][a-z0-9_]*$/i.test(m) && m.includes('_')) {
    return '同步失败，请稍后重试';
  }
  return m || '同步失败，请稍后重试';
}

module.exports = { mapSyncApiMessage, CODE_MESSAGES };
