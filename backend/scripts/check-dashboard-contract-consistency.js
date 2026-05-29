#!/usr/bin/env node
'use strict';

/**
 * 校验 dashboard 契约：同一筛选下 summary.gmv 与 gmv-compare.summary.todayTotal 一致。
 *
 * 用法:
 *   cd backend && node scripts/check-dashboard-contract-consistency.js
 *   DASHBOARD_TENANT_ID=1 node scripts/check-dashboard-contract-consistency.js
 *
 * 可选 HTTP 模式（需 Bearer）:
 *   API_BASE=http://127.0.0.1:3081 API_TOKEN=<jwt> node scripts/check-dashboard-contract-consistency.js
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

/** @type {{ timeRange: string, orderFilter: string }[]} */
const CASES = [
  { timeRange: 'today', orderFilter: 'all' },
  { timeRange: 'today', orderFilter: 'valid' },
  { timeRange: 'today', orderFilter: 'unpaid' },
  { timeRange: 'today', orderFilter: 'sample' },
  { timeRange: 'yesterday', orderFilter: 'all' },
  { timeRange: 'yesterday', orderFilter: 'valid' },
  { timeRange: 'yesterday', orderFilter: 'unpaid' },
  { timeRange: 'yesterday', orderFilter: 'sample' },
];

function caseLabel(c) {
  return `${c.timeRange}/${c.orderFilter}`;
}

function buildQuery(c) {
  return {
    timeRange: c.timeRange,
    orderFilter: c.orderFilter,
    shopId: 'all',
    market: 'ALL',
    groupBy: 'hour',
  };
}

function nearEqual(a, b, tol = TOLERANCE) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

function httpGetJson(urlStr, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: 60000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let data = null;
          try {
            data = body ? JSON.parse(body) : null;
          } catch (e) {
            reject(new Error(`invalid JSON ${res.statusCode}: ${e.message}`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = data?.message || data?.error || body.slice(0, 200);
            reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
            return;
          }
          resolve(data);
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

function toQueryString(q) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v != null && String(v) !== '') p.set(k, String(v));
  }
  return p.toString();
}

async function fetchViaHttp(c) {
  if (!API_TOKEN) {
    throw new Error('HTTP mode requires API_TOKEN or DASHBOARD_API_TOKEN');
  }
  const q = buildQuery(c);
  const qs = toQueryString(q);
  const summary = await httpGetJson(`${API_BASE}/api/dashboard/summary?${qs}`, API_TOKEN);
  const compare = await httpGetJson(`${API_BASE}/api/dashboard/gmv-compare?${qs}`, API_TOKEN);
  return {
    summaryGmv: Number(summary?.gmv ?? summary?.data?.gmv) || 0,
    todayTotal: Number(compare?.summary?.todayTotal ?? compare?.data?.summary?.todayTotal) || 0,
    summaryOrders: Number(summary?.orders ?? summary?.data?.orders) || 0,
    compareOrders: Number(compare?.meta?.todayOrders ?? compare?.data?.meta?.todayOrders) || 0,
  };
}

async function fetchViaModules(c) {
  const { getMysqlPool } = require(path.join(__dirname, '..', 'db', 'mysqlPool'));
  const svc = require(path.join(__dirname, '..', 'modules', 'dashboard', 'service'));

  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }

  const q = buildQuery(c);
  const auth = {
    scope: 'tenant',
    role: 'admin',
    user_id: 1,
    tenant_id: TENANT_ID,
  };

  const summary = await svc.getSummary(TENANT_ID, q, auth);
  const compare = await svc.getGmvCompare(TENANT_ID, q);

  return {
    summaryGmv: Number(summary?.gmv) || 0,
    todayTotal: Number(compare?.summary?.todayTotal) || 0,
    summaryOrders: Number(summary?.orders) || 0,
    compareOrders: Number(compare?.meta?.todayOrders) || 0,
  };
}

async function main() {
  if (!Number.isFinite(TENANT_ID) || TENANT_ID <= 0) {
    console.error('Invalid DASHBOARD_TENANT_ID / DEFAULT_TENANT_ID');
    process.exit(1);
  }

  console.log('dashboard contract consistency check');
  console.log('mode=', USE_HTTP ? 'http' : 'direct');
  if (USE_HTTP) console.log('API_BASE=', API_BASE);
  else console.log('tenantId=', TENANT_ID);
  console.log('tolerance=', TOLERANCE);
  console.log('');

  let failures = 0;

  for (const c of CASES) {
    const label = caseLabel(c);
    try {
      const { summaryGmv, todayTotal, summaryOrders, compareOrders } = USE_HTTP
        ? await fetchViaHttp(c)
        : await fetchViaModules(c);

      const ok = nearEqual(summaryGmv, todayTotal);
      const diff = Number((summaryGmv - todayTotal).toFixed(4));

      if (ok) {
        console.log(
          `OK   ${label}  summary.gmv=${summaryGmv}  gmv-compare.todayTotal=${todayTotal}  orders=${summaryOrders}/${compareOrders}`,
        );
      } else {
        failures += 1;
        console.error(
          `FAIL ${label}  summary.gmv=${summaryGmv}  gmv-compare.todayTotal=${todayTotal}  diff=${diff}  orders=${summaryOrders}/${compareOrders}`,
        );
      }
    } catch (e) {
      failures += 1;
      console.error(`FAIL ${label}  error=${e?.message || e}`);
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`FAILED: ${failures}/${CASES.length} case(s) inconsistent or errored`);
    process.exit(1);
  }
  console.log(`PASSED: all ${CASES.length} cases within ±${TOLERANCE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
