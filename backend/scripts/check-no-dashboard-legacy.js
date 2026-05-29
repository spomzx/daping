#!/usr/bin/env node
'use strict';

/**
 * 禁止 dashboard 主链路与实时大屏混用 legacy analytics / cache KPI。
 *
 * 用法:
 *   cd backend && npm run check:no-dashboard-legacy
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function walkJs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      walkJs(p, acc);
    } else if (/\.(js|ts|tsx)$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

/** @type {{ id: string, file: string, patterns: RegExp[], allow?: RegExp[] }[]} */
const RULES = [
  {
    id: 'dashboard-no-analytics-svc',
    file: 'backend/modules/dashboard',
    patterns: [/analyticsSvc/i, /require\(['"].*analytics\/service/],
  },
  {
    id: 'dashboard-no-cache-json',
    file: 'backend/modules/dashboard',
    patterns: [/orders-cache\.json/i, /gmv-cache\.json/i, /shops\.json/i, /dashboard\.db/i],
  },
  {
    id: 'war-room-no-analytics-gmv-compare',
    file: 'frontend/src/GmvCompareTrendPanel.tsx',
    patterns: [/\/api\/analytics\/gmv-compare/i, /compareApi\s*=\s*['"]analytics/i, /trendFallback/],
  },
  {
    id: 'war-room-no-compare-kpi',
    file: 'frontend/src/GmvCompareTrendPanel.tsx',
    patterns: [
      /summaryForDisplay\.todayTotal/,
      /gmvCompare\.summary/,
      /trendFallback\s*\|\|\s*gmvCompare/,
      /\.summary\?\.todayTotal/,
      /\.summary\?\.yesterdayTotal/,
    ],
  },
  {
    id: 'legacy-page-no-analytics-orders',
    file: 'frontend/src/legacy/LegacyDashboardPage.tsx',
    patterns: [/\/api\/analytics\/recent-orders/i, /\/api\/analytics\/gmv-compare/i, /compareApi=/],
  },
  {
    id: 'legacy-page-no-legacy-dashboard-aggregate',
    file: 'frontend/src/legacy/LegacyDashboardPage.tsx',
    patterns: [
      /\/api\/dashboard\?/i,
      /\/api\/dashboard\`/i,
      /['"]\/api\/dashboard['"]/,
      /buildDashboardQueryParams\s*\(/,
      /\{\s*legacy\s*:\s*true\s*\}/,
    ],
  },
  {
    id: 'frontend-war-room-no-analytics-apis',
    file: 'frontend/src',
    patterns: [/\/api\/analytics\/gmv-compare/i, /\/api\/analytics\/recent-orders/i],
  },
  {
    id: 'backend-no-dashboard-time-filter-log',
    file: 'backend',
    patterns: [/console\.log\('\[dashboard-time-filter\]'/],
  },
  {
    id: 'realtime-orders-dashboard-only',
    file: 'frontend/src/components/RealtimeOrdersPanel.tsx',
    patterns: [/\/api\/analytics\/recent-orders/i],
  },
];

/** 允许 analytics 专区的路径片段 */
const ANALYTICS_ALLOW_PATH = [
  `${path.sep}frontend${path.sep}src${path.sep}analytics${path.sep}`,
  `${path.sep}frontend${path.sep}src${path.sep}AnalyticsPage.tsx`,
  `${path.sep}legacy-quarantine${path.sep}frontend${path.sep}`,
  `${path.sep}backend${path.sep}scripts${path.sep}check-saas-routes.js`,
  `${path.sep}backend${path.sep}modules${path.sep}analytics${path.sep}`,
];

function isAnalyticsOnlyFile(absPath) {
  const norm = absPath.split(path.sep).join(path.sep);
  return ANALYTICS_ALLOW_PATH.some((frag) => norm.includes(frag.replace(/\//g, path.sep)));
}

function scanDir(relDir, patterns, allow = [], ruleId = '') {
  const dir = path.join(ROOT, relDir);
  const hits = [];
  for (const file of walkJs(dir)) {
    if (ruleId === 'frontend-war-room-no-analytics-apis' && isAnalyticsOnlyFile(file)) continue;
    if (isAnalyticsOnlyFile(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const re of patterns) {
      if (!re.test(text)) continue;
      if (allow.some((a) => a.test(text) && a.source.length > 0)) continue;
      hits.push({ file: path.relative(ROOT, file), pattern: re.source });
      break;
    }
  }
  return hits;
}

function scanFile(relFile, patterns) {
  const text = read(relFile);
  if (text == null) return [];
  const hits = [];
  for (const re of patterns) {
    if (re.test(text)) hits.push({ file: relFile, pattern: re.source });
  }
  return hits;
}

function main() {
  console.log('check-no-dashboard-legacy');
  console.log('ROOT=', ROOT);
  let fail = 0;

  for (const rule of RULES) {
    const hits =
      rule.file.endsWith('.tsx') || rule.file.endsWith('.ts') || rule.file.endsWith('.js')
        ? scanFile(rule.file, rule.patterns)
        : scanDir(rule.file, rule.patterns, rule.allow || [], rule.id);
    if (hits.length) {
      fail += hits.length;
      console.error(`\n[FAIL] ${rule.id}`);
      for (const h of hits) {
        console.error(`  ${h.file}  ~/${h.pattern}/`);
      }
    } else {
      console.log(`[OK] ${rule.id}`);
    }
  }

  const removedGone = read('backend/routes/removedLegacyGone.js') || '';
  if (!removedGone.includes('legacy_removed')) {
    fail += 1;
    console.error('\n[FAIL] removedLegacyGone.js must return 410 legacy_removed');
  } else {
    console.log('[OK] removed-legacy-gone-410');
  }

  const register = read('backend/routes/registerApiRoutes.js') || '';
  if (/registerDeprecatedOpsAliases/i.test(register)) {
    fail += 1;
    console.error('\n[FAIL] registerApiRoutes must not mount deprecatedOpsAliases');
  }
  if (/\[dashboard-filter\]/i.test(register)) {
    fail += 1;
    console.error('\n[FAIL] registerApiRoutes must not log [dashboard-filter]');
  }

  const legacyDoc = read('docs/audit/dashboard-filter-shop-id-fix.md') || '';
  if (legacyDoc.includes('[dashboard-filter]') && !legacyDoc.includes('禁止')) {
    console.log('[WARN] docs still mention [dashboard-filter] (historical audit doc)');
  }

  console.log('');
  if (fail > 0) {
    console.error(`FAILED: ${fail} violation(s)`);
    process.exit(1);
  }
  console.log('PASSED: no dashboard legacy violations in guarded paths');
}

main();
