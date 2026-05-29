'use strict';

/**
 * Dashboard 预计算 / table / snapshot TTL（毫秒）
 * @param {string} endpoint
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} [contract]
 */
function precomputeTtlMs(endpoint, contract) {
  const tr = String(contract?.timeRange || 'today').trim().toLowerCase();
  const ep = String(endpoint || '').trim();

  if (tr === 'yesterday') return 86_400_000;

  if (tr === 'last7') return 600_000;
  if (tr === 'last30') return 1_800_000;
  if (tr === 'custom') return 600_000;

  if (tr === 'today') {
    if (ep === 'summary') return 60_000;
    if (ep === 'ranking') return 90_000;
    if (ep === 'product-ranking') return 120_000;
    if (ep === 'gmv-compare' || ep === 'order-volume' || ep === 'trend') return 90_000;
    return 90_000;
  }

  if (ep === 'summary') return 600_000;
  if (ep === 'product-ranking') return 600_000;
  return 600_000;
}

module.exports = { precomputeTtlMs };
