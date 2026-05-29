'use strict';

/** 大屏 / Analytics 统一市场色（与前端不写死约定：由接口下发） */
const MARKET_COLOR_HEX = {
  TH: '#00E5FF',
  MY: '#4DFFB8',
  PH: '#FFD54F',
  VN: '#FF8A65',
  SG: '#B388FF',
};

/**
 * @param {string} market
 * @returns {string}
 */
function marketColorHex(market) {
  const m = String(market || '')
    .trim()
    .toUpperCase();
  return MARKET_COLOR_HEX[m] || '#90A4AE';
}

/**
 * @param {number} usd
 * @returns {'small'|'medium'|'large'|'super'}
 */
function orderLevelFromUsd(usd) {
  const u = Number(usd);
  if (!Number.isFinite(u)) return 'small';
  if (u >= 100) return 'super';
  if (u >= 30) return 'large';
  if (u >= 10) return 'medium';
  return 'small';
}

/**
 * @param {number} usd
 * @returns {boolean}
 */
function isLargeOrderUsd(usd) {
  const u = Number(usd);
  return Number.isFinite(u) && u >= 30;
}

/**
 * @param {number} items
 * @returns {boolean}
 */
function isMultiItem(items) {
  return Number(items) > 1;
}

module.exports = {
  marketColorHex,
  orderLevelFromUsd,
  isLargeOrderUsd,
  isMultiItem,
};
