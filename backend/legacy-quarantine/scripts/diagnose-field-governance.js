#!/usr/bin/env node
'use strict';

/**
 * 字段治理漂移诊断（只读扫描，不改文件�? *
 *   node scripts/diagnose-field-governance.js
 *   node scripts/diagnose-field-governance.js --json-only
 *
 * 规则�?docs/field-governance.md
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../..');
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'backend'),
  path.join(REPO_ROOT, 'frontend', 'src'),
];

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.vite',
]);

const SKIP_FILE_RE = [
  /[\\/]dist[\\/]/,
  /\.min\.js$/,
  /package-lock\.json$/,
];

/** 兼容 alias：平�?JSON / �?cache 读取，须映射�?canonical �?*/
const SKIP_SCAN_FILE_RE = [/diagnose-field-governance\.js$/];

const ALLOWED_ALIAS_FILE_RE = [
  /[\\/]scripts[\\/]diagnose-/,
  /[\\/]db[\\/]orderRepository\.js$/,
  /[\\/]orderReconcileService\.js$/,
  /[\\/]orderPersistenceService\.js$/,
  /[\\/]tiktok-api[\\/]/,
  /[\\/]shopHealthService\.js$/,
  /[\\/]mysqlDashboardOrdersService\.js$/,
  /[\\/]server\.js$/,
  /[\\/]scheduler\.js$/,
  /[\\/]docs[\\/]/,
  /field-governance\.md$/,
  /field-contract-map\.md$/,
  /[\\/]migrate.*\.js$/,
  /[\\/]sqliteOrdersInit\.js$/,
  /orderFilter\.js$/, // 文档�?paid 语义
  /filterBuilder\.js$/,
  /filterContract\.js$/,
];

const DEPRECATED_PATTERNS = [
  { keyword: 'createTime', re: /\bcreateTime\b/, suggestion: 'Map to created_at_platform at persist boundary only' },
  { keyword: 'createdTime', re: /\bcreatedTime\b/, suggestion: 'Use created_at_platform' },
  { keyword: 'order_create_time', re: /\border_create_time\b/i, suggestion: 'Use created_at_platform' },
  { keyword: 'pay_time', re: /\bpay_time\b/i, suggestion: 'Use paid_at' },
  { keyword: 'payment_time', re: /\bpayment_time\b/i, suggestion: 'Use paid_at' },
  {
    keyword: 'amount_as_db',
    re: /INSERT\s+INTO\s+[`']?orders[`']?[^;]*\bamount\b/i,
    suggestion: 'Use total_amount for orders table writes',
  },
  {
    keyword: 'gmv_db_column',
    re: /ADD\s+COLUMN\s+[`']?gmv[`']?/i,
    suggestion: 'gmv is not an orders/shops canonical DB column',
  },
];

const HIGH_RISK_PATTERNS = [
  {
    keyword: "analytics_status='paid'",
    re: /analytics_status\s*=\s*['"]paid['"]/i,
    risk_level: 'critical',
    suggestion: 'paid is orderFilter SQL only; analytics_status must not be paid',
  },
  {
    keyword: 'analytics_status IN paid',
    re: /analytics_status\s+IN\s*\([^)]*['"]paid['"]/i,
    risk_level: 'critical',
    suggestion: 'Remove paid from analytics_status IN lists',
  },
  {
    keyword: 'SELECT o.* orders',
    re: /SELECT\s+o\.\*\s+FROM\s+orders\b/i,
    risk_level: 'warn',
    suggestion: 'Deprecated: prefer explicit column list (field-governance §8)',
  },
  {
    keyword: 'last_sync_error DB column',
    re: /ADD\s+COLUMN\s+[`']?last_sync_error[`']?|CREATE\s+TABLE[^;]*\blast_sync_error\b/i,
    risk_level: 'critical',
    suggestion: 'last_sync_error is API/DTO only, not a MySQL column',
  },
  {
    keyword: 'SUM(ROUND dashboard',
    re: /\bSUM\s*\(\s*ROUND\s*\(/i,
    scopeRe: /[\\/]modules[\\/]dashboard[\\/]|[\\/]lib[\\/]dashboard/,
    risk_level: 'warn',
    suggestion: 'Avoid non-standard GMV rollup; use dashboardGmvNativeSumExpr / total_amount',
  },
  {
    keyword: 'points.reduce dashboard',
    re: /\bpoints\.reduce\s*\(/,
    scopeRe: /[\\/]modules[\\/]dashboard[\\/]/,
    risk_level: 'warn',
    suggestion: 'Prefer SQL aggregation over JS points.reduce for KPI',
  },
  {
    keyword: 'order_status KPI only',
    re: /(?:GMV|KPI|dashboard).{0,80}order_status(?![\w])/i,
    risk_level: 'info',
    suggestion: 'Confirm filter uses analytics_status, not order_status alone',
  },
];

function isAllowedAliasFile(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return ALLOWED_ALIAS_FILE_RE.some((re) => re.test(norm));
}

function shouldSkipDir(name) {
  return SKIP_DIR_NAMES.has(name);
}

function shouldSkipFile(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (SKIP_SCAN_FILE_RE.some((re) => re.test(norm))) return true;
  if (!/\.(js|ts|tsx|sql|md)$/.test(norm)) return true;
  return SKIP_FILE_RE.some((re) => re.test(norm));
}

function isDiagnoseScript(relPath) {
  return /[\\/]scripts[\\/]diagnose-/.test(relPath.replace(/\\/g, '/'));
}

function walkFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(REPO_ROOT, full);
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      walkFiles(full, out);
      continue;
    }
    if (shouldSkipFile(rel)) continue;
    out.push({ full, rel: rel.replace(/\\/g, '/') });
  }
}

function scanFile(file) {
  const content = fs.readFileSync(file.full, 'utf8');
  const lines = content.split(/\r?\n/);
  const allowed = isAllowedAliasFile(file.rel);
  const hits = { deprecated: [], high: [], alias: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    for (const p of DEPRECATED_PATTERNS) {
      if (!p.re.test(line)) continue;
      p.re.lastIndex = 0;
      const hit = {
        file: file.rel,
        line: lineNo,
        keyword: p.keyword,
        risk_level: 'deprecated',
        suggestion: p.suggestion,
        snippet: line.trim().slice(0, 160),
      };
      if (allowed) hits.alias.push(hit);
      else hits.deprecated.push(hit);
    }

    for (const p of HIGH_RISK_PATTERNS) {
      if (isDiagnoseScript(file.rel)) continue;
      if (p.scopeRe && !p.scopeRe.test(file.rel)) continue;
      if (!p.re.test(line)) continue;
      p.re.lastIndex = 0;
      hits.high.push({
        file: file.rel,
        line: lineNo,
        keyword: p.keyword,
        risk_level: p.risk_level,
        suggestion: p.suggestion,
        snippet: line.trim().slice(0, 160),
      });
    }
  }

  return hits;
}

function main() {
  const files = [];
  for (const root of SCAN_ROOTS) walkFiles(root, files);

  const deprecated_field_hits = [];
  const high_risk_hits = [];
  const allowed_alias_hits = [];
  const notes = [
    'Scan roots: backend/, frontend/src/',
    'Rules: docs/field-governance.md',
    'allowed_alias_hits = deprecated patterns in ingest/legacy/diagnose paths',
    'ok=false when high_risk_hits contains risk_level=critical',
  ];

  for (const f of files) {
    const { deprecated, high, alias } = scanFile(f);
    deprecated_field_hits.push(...deprecated);
    high_risk_hits.push(...high);
    allowed_alias_hits.push(...alias);
  }

  const critical = high_risk_hits.filter((h) => h.risk_level === 'critical');
  const ok = critical.length === 0;

  const report = {
    ok,
    deprecated_field_hits,
    high_risk_hits,
    allowed_alias_hits,
    notes,
    summary: {
      files_scanned: files.length,
      deprecated_count: deprecated_field_hits.length,
      high_risk_count: high_risk_hits.length,
      critical_count: critical.length,
      allowed_alias_count: allowed_alias_hits.length,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(1);
}

main();
