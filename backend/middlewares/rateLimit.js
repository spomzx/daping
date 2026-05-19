'use strict';

/**
 * 进程内滑动窗口限流（单实例有效；多实例需网关层限流）。
 */
function createRateLimiter(opts) {
  const windowMs = Math.max(1000, Number(opts.windowMs || 60_000));
  const max = Math.max(1, Number(opts.max || 10));
  const keyFn =
    opts.keyFn ||
    ((req) => {
      const uid = req.auth?.user_id ?? req.auth?.id ?? 'anon';
      return String(uid);
    });
  const buckets = new Map();

  function prune(now) {
    for (const [k, arr] of buckets) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length === 0) buckets.delete(k);
      else buckets.set(k, kept);
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    prune(now);
    const key = `${opts.name || 'rl'}:${keyFn(req)}`;
    const arr = buckets.get(key) || [];
    if (arr.length >= max) {
      return res.status(429).json({
        error: 'rate_limited',
        retryAfterMs: windowMs,
        limit: max,
        windowMs,
      });
    }
    arr.push(now);
    buckets.set(key, arr);
    next();
  };
}

/** import-cache：每用户每分钟最多 3 次 */
const importCacheLimiter = createRateLimiter({
  name: 'import-cache',
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_IMPORT_CACHE_PER_MIN || 3),
  keyFn: (req) => String(req.auth?.user_id ?? '0'),
});

/** refresh-health：每用户每分钟 2 次；scope=all 额外全局锁在 controller */
const refreshHealthLimiter = createRateLimiter({
  name: 'refresh-health',
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_REFRESH_HEALTH_PER_MIN || 2),
  keyFn: (req) => {
    const scope = String(req.query.scope || '').toLowerCase();
    const uid = String(req.auth?.user_id ?? '0');
    return scope === 'all' ? `all:${uid}` : uid;
  },
});

/** operation log 写入：每 tenant+user 每分钟 60 条 */
const operationLogWriteLimiter = createRateLimiter({
  name: 'oplog-write',
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_OPERATION_LOG_PER_MIN || 60),
  keyFn: (req) => {
    if (req && req.auth) {
      return `${req.auth.tenant_id ?? 0}:${req.auth.user_id ?? 0}`;
    }
    return 'internal';
  },
});

/** OpenAPI collect-now：每用户每 2 分钟 1 次 */
const collectNowLimiter = createRateLimiter({
  name: 'collect-now',
  windowMs: 120_000,
  max: Number(process.env.RATE_LIMIT_COLLECT_NOW_PER_2MIN || 1),
  keyFn: (req) => String(req.auth?.user_id ?? '0'),
});

/** 全平台 refresh-health 全局：每 5 分钟 1 次 */
const refreshHealthGlobalLimiter = createRateLimiter({
  name: 'refresh-health-global',
  windowMs: 300_000,
  max: 1,
  keyFn: () => 'platform',
});

const oplogBuckets = new Map();
const OPLOG_WINDOW_MS = 60_000;
const OPLOG_MAX = Number(process.env.RATE_LIMIT_OPERATION_LOG_PER_MIN || 60);

let lastPlatformImportAt = 0;
let lastPlatformRefreshAt = 0;
const PLATFORM_OP_WINDOW_MS = 300_000;

function assertPlatformImportAllowed() {
  const now = Date.now();
  if (now - lastPlatformImportAt < PLATFORM_OP_WINDOW_MS) {
    const err = new Error('platform_import_rate_limited');
    err.code = 'RATE_LIMITED';
    throw err;
  }
  lastPlatformImportAt = now;
}

function assertPlatformRefreshAllowed() {
  const now = Date.now();
  if (now - lastPlatformRefreshAt < PLATFORM_OP_WINDOW_MS) {
    const err = new Error('platform_refresh_rate_limited');
    err.code = 'RATE_LIMITED';
    throw err;
  }
  lastPlatformRefreshAt = now;
}

function checkOperationLogWrite(tenantId, userId) {
  const now = Date.now();
  const key = `${tenantId ?? 0}:${userId ?? 0}`;
  const arr = (oplogBuckets.get(key) || []).filter((t) => now - t < OPLOG_WINDOW_MS);
  if (arr.length >= OPLOG_MAX) return false;
  arr.push(now);
  oplogBuckets.set(key, arr);
  return true;
}

module.exports = {
  createRateLimiter,
  importCacheLimiter,
  refreshHealthLimiter,
  refreshHealthGlobalLimiter,
  operationLogWriteLimiter,
  collectNowLimiter,
  checkOperationLogWrite,
  assertPlatformImportAllowed,
  assertPlatformRefreshAllowed,
};
