'use strict';

/**
 * 同参数短时 in-flight 复用（orders 等实时接口，不缓存结果）。
 * @type {Map<string, { promise: Promise<unknown>, at: number }>}
 */
const inFlight = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} loader
 * @param {number} [ttlMs]
 * @returns {Promise<T>}
 */
async function withInFlightDedupe(key, loader, ttlMs = 3000) {
  const k = String(key || '').trim();
  if (!k) return loader();

  const now = Date.now();
  const existing = inFlight.get(k);
  if (existing && now - existing.at < ttlMs) {
    return /** @type {Promise<T>} */ (existing.promise);
  }

  const promise = Promise.resolve()
    .then(loader)
    .finally(() => {
      setTimeout(() => {
        const cur = inFlight.get(k);
        if (cur && cur.promise === promise) inFlight.delete(k);
      }, ttlMs);
    });

  inFlight.set(k, { promise, at: now });
  return promise;
}

function buildOrdersDedupeKey(tenantId, contract, limit) {
  const tenant = Number.isFinite(Number(tenantId)) ? String(Math.floor(Number(tenantId))) : 'none';
  const shop = String(contract?.shopId ?? 'all');
  const market = String(contract?.market ?? 'ALL');
  const orderFilter = String(contract?.orderFilter ?? 'all');
  const timeRange = String(contract?.timeRange ?? 'today');
  const start = String(contract?.startDate ?? '');
  const end = String(contract?.endDate ?? '');
  const lim = String(Math.min(50, Math.max(1, Number(limit) || 50)));
  return `orders:${tenant}:${shop}:${market}:${orderFilter}:${timeRange}:${start}:${end}:${lim}`;
}

module.exports = { withInFlightDedupe, buildOrdersDedupeKey };
