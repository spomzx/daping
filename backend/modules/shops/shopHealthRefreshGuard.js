'use strict';

/** 进程内单例：防止健康刷新并发/连点风暴 */

let shopHealthRefreshLock = false;
let shopHealthRefreshStartedAt = 0;
let shopHealthRefreshCooldownUntil = 0;

const COOLDOWN_MS = Number(process.env.SHOP_HEALTH_REFRESH_COOLDOWN_MS || 30000);
const LOCK_STALE_MS = Number(process.env.SHOP_HEALTH_REFRESH_LOCK_STALE_MS || 300000);

function cooldownRemainingMs(now = Date.now()) {
  return Math.max(0, shopHealthRefreshCooldownUntil - now);
}

/**
 * @returns {{ ok: true } | { ok: false, error: string, retryAfterMs?: number, status: number }}
 */
function tryAcquireShopHealthRefreshLock() {
  const now = Date.now();
  const remain = cooldownRemainingMs(now);
  if (remain > 0) {
    return { ok: false, error: 'refresh_cooldown', retryAfterMs: remain, status: 429 };
  }

  if (shopHealthRefreshLock) {
    const heldMs = now - shopHealthRefreshStartedAt;
    if (heldMs <= LOCK_STALE_MS) {
      return { ok: false, error: 'refresh_in_progress', status: 409 };
    }
    console.warn('[shop-health] refresh lock stale, taking over', { heldMs });
  }

  shopHealthRefreshLock = true;
  shopHealthRefreshStartedAt = now;
  return { ok: true };
}

/**
 * @param {{ setCooldown?: boolean }} [opts]
 */
function releaseShopHealthRefreshLock(opts = {}) {
  const setCooldown = opts.setCooldown !== false;
  shopHealthRefreshLock = false;
  if (setCooldown) {
    shopHealthRefreshCooldownUntil = Date.now() + COOLDOWN_MS;
  }
}

function getShopHealthRefreshGuardState() {
  return {
    locked: shopHealthRefreshLock,
    startedAt: shopHealthRefreshStartedAt,
    cooldownUntil: shopHealthRefreshCooldownUntil,
    cooldownRemainingMs: cooldownRemainingMs(),
  };
}

module.exports = {
  COOLDOWN_MS,
  tryAcquireShopHealthRefreshLock,
  releaseShopHealthRefreshLock,
  getShopHealthRefreshGuardState,
};
