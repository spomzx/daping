#!/usr/bin/env node
'use strict';

/**
 * Deploy 后 SaaS 路由冒烟检查（无需 JWT；404=未挂载，401/403=路由存在）
 *
 * 用法:
 *   node scripts/check-saas-routes.js
 *   API_BASE=http://127.0.0.1:3081 node scripts/check-saas-routes.js
 */

const http = require('http');
const https = require('https');

const BASE = String(process.env.API_BASE || 'http://127.0.0.1:3081').replace(/\/$/, '');

const ROUTES = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/tenants/ping' },
  { method: 'GET', path: '/api/users/ping' },
  { method: 'GET', path: '/api/sync/ping' },
  { method: 'GET', path: '/api/dashboard/ping' },
  { method: 'GET', path: '/api/analytics/top-products?limit=5' },
  { method: 'GET', path: '/api/analytics/top-shops?limit=5' },
  { method: 'GET', path: '/api/analytics/recent-orders?limit=5' },
  { method: 'GET', path: '/api/analytics/gmv-compare?hours=24' },
  { method: 'GET', path: '/api/tenants?page=1&page_size=5' },
  { method: 'GET', path: '/api/users?page=1&page_size=5' },
  { method: 'GET', path: '/api/sync/status' },
  { method: 'GET', path: '/api/shops?page=1&page_size=5' },
  { method: 'GET', path: '/api/operation-logs/ping' },
  { method: 'GET', path: '/api/operation-logs/stats' },
  { method: 'GET', path: '/api/operation-logs?page=1&pageSize=5' },
];

function classifyStatus(code) {
  if (code === 404) return '404';
  if (code >= 500) return '500';
  return 'OK';
}

function requestOnce(method, urlStr) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        timeout: 15000,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout' });
    });
    req.on('error', (e) => {
      resolve({ status: 0, error: e.message });
    });
    req.end();
  });
}

async function main() {
  console.log('SaaS route check');
  console.log('BASE=', BASE);
  console.log('');

  let fail = 0;
  const rows = [];

  for (const r of ROUTES) {
    const url = `${BASE}${r.path}`;
    const { status, error } = await requestOnce(r.method, url);
    const label = classifyStatus(status);
    if (label === '404' || label === '500' || status === 0) fail += 1;
    const line = `${label.padEnd(4)} ${status || 'ERR'} ${r.method} ${r.path}${error ? ` (${error})` : ''}`;
    rows.push(line);
    console.log(line);
  }

  console.log('');
  if (fail > 0) {
    console.error(`FAILED: ${fail} route(s) returned 404/500 or connection error`);
    process.exit(1);
  }
  console.log('ALL OK (no 404/500; 401/403 acceptable for protected routes)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
