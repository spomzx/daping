#!/usr/bin/env node
'use strict';

/**
 * Field Registry v2 漂移诊断（只读）
 *
 *   node scripts/diagnose-field-registry.js
 *
 * 规则：docs/field-registry.md, source-of-truth.md, deprecated-fields.md,
 *       field-governance-rules.md
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../..');
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'backend'),
  path.join(REPO_ROOT, 'frontend', 'src'),
];

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.vite']);

const SKIP_SCAN_FILE_RE = [
  /diagnose-field-registry\.js$/,
  /diagnose-field-governance\.js$/,
];

const ALLOWED_ALIAS_FILE_RE = [
  /[\\/]scripts[\\/]diagnose-/,
  /[\\/]scripts[\\/]acceptanceEvidence\.js$/,
  /[\\/]orderPersistenceService\.js$/,
  /[\\/]orderRepository\.js$/,
  /[\\/]orderReconcileService\.js$/,
  /[\\/]tiktok-api[\\/]/,
  /[\\/]shopHealthService\.js$/,
  /[\\/]mysqlDashboardOrdersService\.js$/,
  /[\\/]server\.js$/,
  /[\\/]scheduler\.js$/,
  /[\\/]readSyncShops\.js$/,
  /[\\/]shopCipherBackfill\.js$/,
  /[\\/]docs[\\/]/,
  /[\\/]migrate.*\.js$/,
  /[\\/]sqliteOrdersInit\.js$/,
  /orderFilter\.js$/,
  /filterBuilder\.js$/,
  /filterContract\.js$/,
  /normalizeGmvCompareResponse\.js$/,
  /dashboardSummaryKpi\.js$/,
];

/** docs/dto-contracts.md 已登�?*/
const REGISTERED_DTO_NAMES = new Set([
  'ShopListApiRow',
  'ShopsListApiResponse',
  'ShopListHealthDebug',
  'OrdersListItem',
  'OrdersListApiResponse',
  'OrderRealtimeDto',
  'OrderLevel',
  'DashboardSummaryKpi',
  'DashboardDataSourceDebug',
  'WarRoomGmvCompareNormalized',
  'GmvChartPoint',
  'WarRoomShopMetric',
  'SyncShopRow',
  'AnalyticsShopOption',
  'TopShopRow',
  'TopProductRow',
  'SearchSkuRow',
  'GmvCompareSeriesPayload',
  'GmvPayload',
  'GmvMeta',
  'DashboardFilterContract',
  'DashboardFilterState',
  'DashboardLoadOpts',
  'HealthPatchRow',
  'LogRow',
  'ReconcilePayload',
  'RealtimeOrderRow',
  'ShopMgmtPanelProps',
  'ShopsSummaryResponse',
  'ExchangeRatePayload',
  'TrendPoint',
]);

const DEPRECATED_PATTERNS = [
  { keyword: 'createTime', re: /\bcreateTime\b/, replacement: 'created_at_platform' },
  { keyword: 'createdTime', re: /\bcreatedTime\b/, replacement: 'created_at_platform' },
  { keyword: 'order_create_time', re: /\border_create_time\b/i, replacement: 'created_at_platform' },
  { keyword: 'pay_time', re: /\bpay_time\b/i, replacement: 'paid_at' },
  { keyword: 'payment_time', re: /\bpayment_time\b/i, replacement: 'paid_at' },
  { keyword: 'auth_token', re: /\bauth_token\b/i, replacement: 'access_token' },
  { keyword: 'todayGmv', re: /\btodayGmv\b/, replacement: 'today_gmv (API snake_case)' },
  { keyword: 'totalGmv', re: /\btotalGmv\b/, replacement: 'today_gmv / ranking_total_gmv' },
  {
    keyword: 'amount_db_write',
    re: /INSERT\s+INTO\s+[`']?orders[`']?[^;]*\bamount\b/i,
    replacement: 'total_amount',
  },
];

const HIGH_RISK_PATTERNS = [
  {
    keyword: "analytics_status='paid'",
    re: /analytics_status\s*=\s*['"]paid['"]/i,
    risk_level: 'critical',
    suggestion: 'Use orderFilter=paid SQL only (orderFilter.js)',
  },
  {
    keyword: 'analytics_status IN paid',
    re: /analytics_status\s+IN\s*\([^)]*['"]paid['"]/i,
    risk_level: 'critical',
    suggestion: 'Remove paid from analytics_status IN',
  },
  {
    keyword: 'last_sync_error DB DDL',
    re: /ADD\s+COLUMN\s+[`']?last_sync_error[`']?|CREATE\s+TABLE[^;]*\blast_sync_error\b/i,
    risk_level: 'critical',
    suggestion: 'last_sync_error is DTO only',
  },
  {
    keyword: 'created_at dashboard WHERE',
    re: /WHERE[^;\n]*\bo\.created_at\b(?!_platform)/i,
    scopeRe: /[\\/]modules[\\/]dashboard[\\/]/,
    risk_level: 'critical',
    suggestion: 'Use created_at_platform for dashboard time window',
  },
  {
    keyword: 'ORDER BY created_at only',
    re: /ORDER\s+BY\s+o\.created_at\b(?!_platform)/i,
    scopeRe: /[\\/]modules[\\/]dashboard[\\/]/,
    risk_level: 'critical',
    suggestion: 'ORDER BY COALESCE(created_at_platform, created_at) or platform only',
  },
  {
    keyword: 'SUM(ROUND dashboard',
    re: /\bSUM\s*\(\s*ROUND\s*\(/i,
    scopeRe: /[\\/]modules[\\/]dashboard[\\/]/,
    risk_level: 'warn',
    suggestion: 'Use dashboardGmvNativeSumExpr',
  },
  {
    keyword: 'points.reduce dashboard',
    re: /\bpoints\.reduce\s*\(/,
    scopeRe: /[\\/]modules[\\/]dashboard[\\/]/,
    risk_level: 'warn',
    suggestion: 'SQL aggregation preferred',
  },
];

const MULTIPLE_TRUTH_PATTERNS = [
  {
    keyword: 'createTime+created_at_platform',
    test: (content, rel) => {
      if (isAllowedAliasFile(rel)) return false;
      return /\bcreateTime\b/.test(content) && /\bcreated_at_platform\b/.test(content);
    },
    suggestion: 'Map createTime only at ingest; use created_at_platform elsewhere',
  },
  {
    keyword: 'pay_time+paid_at',
    test: (content, rel) => {
      if (isAllowedAliasFile(rel)) return false;
      return /\bpay_time\b/i.test(content) && /\bpaid_at\b/.test(content);
    },
    suggestion: 'Consolidate on paid_at',
  },
];

const SELECT_STAR_RE = /\bSELECT\s+\*\s+FROM\s+(\w+)/gi;

const FRONTEND_TOKEN_DERIVE_RE = [
  { keyword: 'token missing heuristic', re: /token\s*missing|missing\s*token/i },
  { keyword: 'empty access_token check', re: /!\s*\w*\.access_token|access_token\s*===\s*['"]\s*['"]/ },
];

function isAllowedAliasFile(rel) {
  const norm = rel.replace(/\\/g, '/');
  return ALLOWED_ALIAS_FILE_RE.some((re) => re.test(norm));
}

function isDiagnoseScript(rel) {
  return /[\\/]scripts[\\/]diagnose-/.test(rel.replace(/\\/g, '/'));
}

function shouldSkipDir(name) {
  return SKIP_DIR_NAMES.has(name);
}

function shouldSkipFile(rel) {
  const norm = rel.replace(/\\/g, '/');
  if (SKIP_SCAN_FILE_RE.some((re) => re.test(norm))) return true;
  return !/\.(js|ts|tsx|sql|md)$/.test(norm);
}

function walkFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      walkFiles(full, out);
      continue;
    }
    if (shouldSkipFile(rel)) continue;
    out.push({ full, rel });
  }
}

function hit(file, line, lineNo, extra) {
  return {
    file: file.rel,
    line: lineNo,
    snippet: line.trim().slice(0, 160),
    ...extra,
  };
}

function scanFile(file) {
  const content = fs.readFileSync(file.full, 'utf8');
  const lines = content.split(/\r?\n/);
  const allowed = isAllowedAliasFile(file.rel);
  const isFrontend = file.rel.startsWith('frontend/');
  const isDashboard = /[\\/]modules[\\/]dashboard[\\/]/.test(file.rel);

  const deprecated_hits = [];
  const high_risk_hits = [];
  const multiple_truth_hits = [];
  const unregistered_dto_hits = [];
  const select_star_hits = [];

  if (!allowed) {
    for (const p of MULTIPLE_TRUTH_PATTERNS) {
      if (p.test(content, file.rel)) {
        multiple_truth_hits.push(
          hit(file, '(file scope)', 0, {
            keyword: p.keyword,
            risk_level: 'warn',
            suggestion: p.suggestion,
          }),
        );
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    for (const p of DEPRECATED_PATTERNS) {
      if (!p.re.test(line)) continue;
      p.re.lastIndex = 0;
      if (allowed) continue;
      deprecated_hits.push(
        hit(file, line, lineNo, {
          keyword: p.keyword,
          risk_level: 'deprecated',
          suggestion: `Use ${p.replacement}`,
        }),
      );
    }

    for (const p of HIGH_RISK_PATTERNS) {
      if (isDiagnoseScript(file.rel)) continue;
      if (p.scopeRe && !p.scopeRe.test(file.rel)) continue;
      if (!p.re.test(line)) continue;
      p.re.lastIndex = 0;
      high_risk_hits.push(
        hit(file, line, lineNo, {
          keyword: p.keyword,
          risk_level: p.risk_level,
          suggestion: p.suggestion,
        }),
      );
    }

    if (isFrontend && !/i18n[\\/]|syncLabels|shopMgmtLabels|types[\\/]/.test(file.rel)) {
      for (const p of FRONTEND_TOKEN_DERIVE_RE) {
        if (!p.re.test(line)) continue;
        p.re.lastIndex = 0;
        if (/source-of-truth|deprecated-fields|field-registry/.test(line)) continue;
        high_risk_hits.push(
          hit(file, line, lineNo, {
            keyword: p.keyword,
            risk_level: 'warn',
            suggestion: 'Use API health_status / is_token_valid (source-of-truth.md)',
          }),
        );
      }
    }

    if (isDashboard && /order_status/.test(line) && /KPI|GMV|dashboardOrderCount|buildDashboardWhere/.test(line)) {
      if (!/analytics_status/.test(line) && !isDiagnoseScript(file.rel)) {
        high_risk_hits.push(
          hit(file, line, lineNo, {
            keyword: 'order_status as KPI',
            risk_level: 'info',
            suggestion: 'Confirm analytics_status is primary filter field',
          }),
        );
      }
    }

    const dtoMatch = line.match(/^\s*type\s+([A-Z][A-Za-z0-9]+(?:Row|Dto|DTO|Payload|Kpi))\s*=/);
    if (dtoMatch && isFrontend) {
      const name = dtoMatch[1];
      if (!REGISTERED_DTO_NAMES.has(name) && !file.rel.includes('/types/')) {
        unregistered_dto_hits.push(
          hit(file, line, lineNo, {
            keyword: `unregistered DTO ${name}`,
            risk_level: 'info',
            suggestion: 'Register in docs/dto-contracts.md + types/',
          }),
        );
      }
    }

    if (/:\s*Record<string,\s*unknown>/.test(line) && /ShopRow|OrderRow|shops\.ts/.test(file.rel + line)) {
      unregistered_dto_hits.push(
        hit(file, line, lineNo, {
          keyword: 'Record<string, unknown> shop/order',
          risk_level: 'warn',
          suggestion: 'Use ShopListApiRow / OrdersListItem',
        }),
      );
    }

    let m;
    SELECT_STAR_RE.lastIndex = 0;
    while ((m = SELECT_STAR_RE.exec(line)) !== null) {
      if (isDiagnoseScript(file.rel)) continue;
      const table = m[1];
      const risk =
        isDashboard || table === 'orders' || table === 'shops' ? 'warn' : 'info';
      select_star_hits.push(
        hit(file, line, lineNo, {
          keyword: `SELECT * FROM ${table}`,
          risk_level: risk,
          suggestion: 'Explicit column list (field-governance-rules §1)',
        }),
      );
    }
  }

  return {
    deprecated_hits,
    high_risk_hits,
    multiple_truth_hits,
    unregistered_dto_hits,
    select_star_hits,
  };
}

function main() {
  const files = [];
  for (const root of SCAN_ROOTS) walkFiles(root, files);

  const deprecated_hits = [];
  const high_risk_hits = [];
  const multiple_truth_hits = [];
  const unregistered_dto_hits = [];
  const select_star_hits = [];

  for (const f of files) {
    const r = scanFile(f);
    deprecated_hits.push(...r.deprecated_hits);
    high_risk_hits.push(...r.high_risk_hits);
    multiple_truth_hits.push(...r.multiple_truth_hits);
    unregistered_dto_hits.push(...r.unregistered_dto_hits);
    select_star_hits.push(...r.select_star_hits);
  }

  const critical = high_risk_hits.filter((h) => h.risk_level === 'critical');
  const ok = critical.length === 0;

  const report = {
    ok,
    deprecated_hits,
    multiple_truth_hits,
    high_risk_hits,
    unregistered_dto_hits,
    select_star_hits,
    notes: [
      'Field Registry v2 �?docs/field-registry.md',
      'ok=false when high_risk_hits contains risk_level=critical',
      'deprecated_hits: new code using deprecated aliases outside ingest paths',
      'multiple_truth_hits: same file mixes canonical + deprecated semantics',
      'unregistered_dto_hits: frontend local *Row/*Dto not in REGISTERED_DTO_NAMES',
      'Legacy v1: node scripts/diagnose-field-governance.js',
    ],
    summary: {
      files_scanned: files.length,
      deprecated_count: deprecated_hits.length,
      multiple_truth_count: multiple_truth_hits.length,
      high_risk_count: high_risk_hits.length,
      critical_count: critical.length,
      unregistered_dto_count: unregistered_dto_hits.length,
      select_star_count: select_star_hits.length,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
