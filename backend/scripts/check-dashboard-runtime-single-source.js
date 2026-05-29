#!/usr/bin/env node
'use strict';

/**
 * 运行时单源：契约子接口一致，旧 /api/dashboard 聚合已 410。
 *
 *   cd backend && DASHBOARD_TENANT_ID=6 npm run check:dashboard-runtime-single-source
 *
 * HTTP:
 *   DASHBOARD_CHECK_HTTP=1 API_BASE=... API_TOKEN=... npm run check:dashboard-runtime-single-source
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');
const https = require('https');
const path = require('path');

const TOLERANCE = 0.01;
const TENANT_ID = Number(process.env.DASHBOARD_TENANT_ID || process.env.DEFAULT_TENANT_ID || 1);
const USE_HTTP = String(process.env.DASHBOARD_CHECK_HTTP || '').trim() === '1';
const API_BASE = String(process.env.API_BASE || 'http://127.0.0.1:3081').replace(/\/$/, '');
const API_TOKEN = String(process.env.API_TOKEN || process.env.DASHBOARD_API_TOKEN || '').trim();

const CASES = [
  { timeRange: 'today', orderFilter: 'all' },
  { timeRange: 'today', orderFilter: 'valid' },
  { timeRange: 'yesterday', orderFilter: 'all' },
  { timeRange: 'yesterday', orderFilter: 'valid' },
];

const CONTRACT_PATHS = ['summary', 'gmv-compare', 'ranking', 'product-ranking', 'order-volume', 'orders'];

function caseLabel(c) {
  return `${c.timeRange}/${c.orderFilter}`;
}

function buildQuery(c, extra = {}) {
  return {
    timeRange: c.timeRange,
    orderFilter: c.orderFilter,
    shopId: 'all',
    market: 'ALL',
    groupBy: 'hour',
    limit: '20',
    ...extra,
  };
}

function toQueryString(q) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v != null && String(v) !== '') p.set(k, String(v));
  }
  return p.toString();
}

function nearEqual(a, b, tol = TOLERANCE) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

function httpRequest(method, urlStr, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: 90000,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (e) {
            reject(new Error(`invalid JSON ${res.statusCode}: ${e.message}`));
            return;
          }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGetJson(urlStr, token) {
  return httpRequest('GET', urlStr, token).then(({ status, data }) => {
    if (status < 200 || status >= 300) {
      const msg = data?.message || data?.error || JSON.stringify(data).slice(0, 200);
      throw new Error(`HTTP ${status}: ${msg}`);
    }
    return data;
  });
}

function extractSummaryCompareKpi(endpoint, body) {
  if (!body || typeof body !== 'object') return { orders: 0, gmv: 0 };
  if (endpoint === 'summary') {
    return {
      orders: Number(body.orders ?? body.data?.orders) || 0,
      gmv: Number(body.gmv ?? body.data?.gmv) || 0,
    };
  }
  return {
    orders: Number(body.meta?.todayOrders ?? body.data?.meta?.todayOrders) || 0,
    gmv: Number(body.summary?.todayTotal ?? body.data?.summary?.todayTotal) || 0,
  };
}

async function fetchContractBundleHttp(c) {
  const qs = toQueryString(buildQuery(c));
  const out = {};
  for (const ep of CONTRACT_PATHS) {
    out[ep] = await httpGetJson(`${API_BASE}/api/dashboard/${ep}?${qs}`, API_TOKEN);
  }
  return out;
}

async function fetchContractBundleDirect(c) {
  const svc = require(path.join(__dirname, '..', 'modules', 'dashboard', 'service'));
  const { getWarRoomRealtimeOrders } = require(path.join(
    __dirname,
    '..',
    'modules',
    'dashboard',
    'warRoomOrders',
  ));
  const q = buildQuery(c);
  const auth = {
    scope: 'tenant',
    role: 'admin',
    user_id: 1,
    tenant_id: TENANT_ID,
  };
  const [summary, gmvCompare, ranking, productRanking, orderVolume, orders] = await Promise.all([
    svc.getSummary(TENANT_ID, q, auth),
    svc.getGmvCompare(TENANT_ID, q),
    svc.getRanking(TENANT_ID, q),
    svc.getProductRanking(TENANT_ID, q),
    svc.getOrderVolume(TENANT_ID, q, auth),
    getWarRoomRealtimeOrders(TENANT_ID, q, auth),
  ]);
  return {
    summary,
    'gmv-compare': gmvCompare,
    ranking,
    'product-ranking': productRanking,
    'order-volume': orderVolume,
    orders,
  };
}

async function assertLegacyAggregateGone() {
  const qs = toQueryString(buildQuery(CASES[0]));
  const { status, data } = await httpRequest('GET', `${API_BASE}/api/dashboard?${qs}`, API_TOKEN);
  if (status !== 410) throw new Error(`expected 410 for GET /api/dashboard, got ${status}`);
  if (data?.error !== 'legacy_dashboard_removed') {
    throw new Error(`unexpected 410 body: ${JSON.stringify(data).slice(0, 120)}`);
  }
}

async function main() {
  if (!Number.isFinite(TENANT_ID) || TENANT_ID <= 0) {
    console.error('Invalid DASHBOARD_TENANT_ID');
    process.exit(1);
  }

  console.log('check-dashboard-runtime-single-source');
  console.log('mode=', USE_HTTP ? 'http' : 'direct');
  if (USE_HTTP) console.log('API_BASE=', API_BASE);
  else console.log('tenantId=', TENANT_ID);
  console.log('');

  let failures = 0;

  if (USE_HTTP) {
    if (!API_TOKEN) {
      console.error('HTTP mode requires API_TOKEN');
      process.exit(1);
    }
    try {
      await assertLegacyAggregateGone();
      console.log('[OK] GET /api/dashboard returns 410 legacy_dashboard_removed');
    } catch (e) {
      failures += 1;
      console.error('[FAIL] legacy aggregate gate:', e.message || e);
    }
  } else {
    console.log('[SKIP] legacy 410 (set DASHBOARD_CHECK_HTTP=1 for HTTP gate)');
  }

  for (const c of CASES) {
    const label = caseLabel(c);
    try {
      const bundle = USE_HTTP ? await fetchContractBundleHttp(c) : await fetchContractBundleDirect(c);
      const summaryKpi = extractSummaryCompareKpi('summary', bundle.summary);
      const compareKpi = extractSummaryCompareKpi('gmv-compare', bundle['gmv-compare']);
      const gmvOk = nearEqual(summaryKpi.gmv, compareKpi.gmv);
      const ordersOk = summaryKpi.orders === compareKpi.orders;

      if (gmvOk && ordersOk) {
        console.log(`OK   ${label}  orders=${summaryKpi.orders}  gmv=${summaryKpi.gmv}`);
      } else {
        failures += 1;
        console.error(
          `FAIL ${label}  summary orders=${summaryKpi.orders} gmv=${summaryKpi.gmv}  compare orders=${compareKpi.orders} gmv=${compareKpi.gmv}`,
        );
      }
    } catch (e) {
      failures += 1;
      console.error(`FAIL ${label}  error=${e?.message || e}`);
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`FAILED: ${failures} issue(s)`);
    process.exit(1);
  }
  console.log(`PASSED: ${CASES.length} case(s), contract single-source`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
