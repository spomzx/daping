'use strict';

const RETRY_DELAYS_SEC = [60, 300, 900, 1800];
const MAX_ATTEMPTS = 5;

/**
 * @param {number} attemptCount 已完成失败次数（1-based 下一次为 attemptCount+1）
 */
function retryDelayMs(attemptCount) {
  const idx = Math.max(0, Math.min(RETRY_DELAYS_SEC.length - 1, Number(attemptCount) - 1));
  return RETRY_DELAYS_SEC[idx] * 1000;
}

function shouldDisableAfterFailures(attemptCount) {
  return Number(attemptCount) >= MAX_ATTEMPTS;
}

function maxAttempts() {
  return MAX_ATTEMPTS;
}

module.exports = {
  RETRY_DELAYS_SEC,
  MAX_ATTEMPTS,
  retryDelayMs,
  shouldDisableAfterFailures,
  maxAttempts,
};
