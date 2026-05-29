#!/usr/bin/env node
'use strict';

/**
 * SaaS 数据中台第二阶段统一化验收脚本
 *
 * 用法:
 *   cd backend && node scripts/auditSaasUnification.js
 *   cd backend && node scripts/auditSaasUnification.js --json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND_SRC = path.join(ROOT, 'frontend', 'src');

const LEGACY_PATTERNS = [
  { id: 'orders-cache', re: /orders-cache(?:\.json)?/i },
  { id: 'gmv-cache', re: /gmv-cache(?:\.json)?/i },
  { id: 'shops-json', re: /shops\.json/i },
  { id: 'sqlite', re: /\bsqlite\b|better-sqlite3|sqlite3/i },
  { id: 'storage-json', re: /storage\/[^'"\s]+\.json/i },
  { id: 'dashboard-db', re: /dashboard\.db/i },
];

const RECOMMENDED_MODULES = [
  'auth',
  'users',
  'tenants',
  'shops',
  'orders',
  'analytics',
  'realtime',
  'currency',
  'sync',
  'logs',
];

const REQUIRED_DOCS = [
  'docs/saas-unification-map.md',
  'docs/module-boundary-map.md',
  'docs/metric-definition-map.md',
  'docs/api-permission-matrix.md',
  'docs/locked-baseline.md',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist_backup',
  'legacy-quarantine',
  'legacy',
]);

function walkFiles(dir, acc = [], extRe = /\.(js|ts|tsx|jsx|json|md)$/) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walkFiles(p, acc, extRe);
    } else if (extRe.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function readText(relPath) {
  const p = path.join(ROOT, relPath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function scanLegacyReferences() {
  const hits = [];
  const scanRoots = [
    path.join(BACKEND, 'modules'),
    path.join(BACKEND, 'routes'),
    path.join(BACKEND, 'services'),
    path.join(BACKEND, 'lib'),
    path.join(BACKEND, 'middlewares'),
    path.join(BACKEND, 'server.js'),
    FRONTEND_SRC,
  ];
  for (const root of scanRoots) {
    if (!fs.existsSync(root)) continue;
    const files = fs.statSync(root).isDirectory() ? walkFiles(root) : [root];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pat of LEGACY_PATTERNS) {
        if (!pat.re.test(text)) continue;
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (pat.re.test(line)) {
            hits.push({
              pattern: pat.id,
              file: rel(file),
              line: i + 1,
              snippet: line.trim().slice(0, 120),
            });
          }
        });
      }
    }
  }
  const dedup = [];
  const seen = new Set();
  for (const h of hits) {
    const key = `${h.file}:${h.line}:${h.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(h);
  }
  return dedup;
}

function scanServerJsBusinessRoutes() {
  const text = readText('backend/server.js') || '';
  const routes = [];
  const re = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(text))) {
    routes.push({
      method: m[1].toUpperCase(),
      path: m[2],
      file: 'backend/server.js',
      category: categorizeServerRoute(m[2]),
    });
  }
  return routes;
}

function categorizeServerRoute(p) {
  if (p === '/api/health' || p === '/api/metrics' || p === '/api/dashboard/ping') return 'infra';
  if (p.startsWith('/api/tiktok')) return 'tiktok-oauth-sync';
  if (p.startsWith('/api/exchange-rate') || p.startsWith('/api/admin/exchange-rates')) return 'currency-migrate-candidate';
  return 'other';
}

function scanDuplicateMetricCandidates() {
  const candidates = [];
  const files = [
    { file: 'backend/modules/dashboard/todayMetricsQuery.js', role: 'LOCKED today KPI' },
    { file: 'backend/modules/analytics/analyticsCompareService.js', role: 'legacy analytics gmv-compare' },
    { file: 'backend/tiktok-api/normalize.js', role: 'scheduler collect-now KPI' },
    { file: 'backend/modules/shops/shopTodayStats.js', role: 'shops today KPI wrapper' },
  ];
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f.file))) continue;
    const text = readText(f.file);
    const hasGmv =
      /today_gmv|gmv_usd|dashboardGmvNativeSumExpr|gmvCompare|SUM\s*\(/i.test(text);
    const hasOrders = /today_orders|dashboardOrderCountExpr|COUNT\s*\(\s*DISTINCT/i.test(text);
    if (hasGmv || hasOrders) {
      candidates.push({
        file: f.file,
        role: f.role,
        signals: [hasGmv && 'gmv', hasOrders && 'orders'].filter(Boolean),
      });
    }
  }
  return candidates;
}

function scanUnscopedApiCandidates() {
  const hits = [];
  const routeFiles = walkFiles(path.join(BACKEND, 'modules')).filter((f) => f.endsWith('routes.js'));
  for (const file of routeFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const moduleName = text.match(/modules[\\/]+([^\\/]+)[\\/]+routes/)?.[1] || path.basename(path.dirname(file));
    const hasAuth = /authRequired/.test(text);
    const hasTenant = /tenantScope|effectiveTenantScope/.test(text);
    const hasDataScope = /attachDataScope|buildShopScopeWhere/.test(text);
    if (!hasAuth && !/ping|login|register|logout/.test(text)) {
      hits.push({
        file: rel(file),
        module: moduleName,
        risk: 'no_authRequired_in_routes',
      });
    } else if (hasAuth && !hasTenant && !/auth\/routes/.test(file)) {
      const isPublicPing = /router\.get\(['"]\/ping['"]/.test(text);
      if (!isPublicPing) {
        hits.push({
          file: rel(file),
          module: moduleName,
          risk: 'auth_without_tenantScope',
        });
      }
    }
  }
  const serverText = readText('backend/server.js') || '';
  if (!/tenantScope/.test(serverText) && /\/api\/tiktok\/shops/.test(serverText)) {
    hits.push({
      file: 'backend/server.js',
      path: '/api/tiktok/shops',
      risk: 'reads_shops_json_without_mysql_tenant_scope',
    });
  }
  if (/app\.get\(['"]\/api\/exchange-rate['"]/.test(serverText)) {
    hits.push({
      file: 'backend/server.js',
      path: '/api/exchange-rate',
      risk: 'public_exchange_rate_no_tenant_scope',
    });
  }
  return hits;
}

function scanFrontendDirectApiCalls() {
  const hits = [];
  const allowServiceImports = /from\s+['"].*services\/api\//;
  const componentDirs = [
    path.join(FRONTEND_SRC, 'components'),
    path.join(FRONTEND_SRC, 'legacy'),
    path.join(FRONTEND_SRC, 'analytics'),
    FRONTEND_SRC,
  ];
  const seen = new Set();
  for (const dir of componentDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walkFiles(dir, [], /\.(tsx|ts|jsx|js)$/)) {
      const base = path.basename(file);
      if (base === 'apiClient.ts' || base === 'client.ts') continue;
      if (file.includes(`${path.sep}services${path.sep}api${path.sep}`)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!/(apiFetch|fetchWithAuth)\s*\(/.test(text)) continue;
      if (allowServiceImports.test(text) && !/apiFetch\s*\(\s*['"`]\/api\//.test(text)) {
        /* may only use fetchAuthMe etc */
      }
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!/(apiFetch|fetchWithAuth)\s*\(/.test(line)) return;
        if (!/\/api\//.test(line)) return;
        const key = `${rel(file)}:${i + 1}`;
        if (seen.has(key)) return;
        seen.add(key);
        hits.push({
          file: rel(file),
          line: i + 1,
          snippet: line.trim().slice(0, 140),
        });
      });
    }
  }
  return hits;
}

function buildModuleBoundaryStatus() {
  const modulesDir = path.join(BACKEND, 'modules');
  const status = {};
  for (const name of RECOMMENDED_MODULES) {
    const modPath = path.join(modulesDir, name);
    const exists = fs.existsSync(modPath);
    const routes = fs.existsSync(path.join(modPath, 'routes.js'));
    const service =
      fs.existsSync(path.join(modPath, 'service.js')) ||
      fs.existsSync(path.join(modPath, 'ordersListService.js'));
    const repo =
      fs.existsSync(path.join(modPath, 'repository.js')) ||
      fs.existsSync(path.join(modPath, 'model.js')) ||
      (name === 'dashboard' && fs.existsSync(path.join(modPath, 'todayMetricsQuery.js')));
    status[name] = {
      exists,
      routes,
      service,
      repository: repo,
      note: !exists ? mapModuleAlias(name) : undefined,
    };
  }
  status._actualModules = fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return status;
}

function mapModuleAlias(name) {
  const aliases = {
    realtime: 'implemented as modules/dashboard (warRoomOrders, /orders)',
    currency: 'modules/exchangeRateService.js + lib/rates.js (migrate target)',
    logs: 'modules/operation-logs + /api/logs mount',
  };
  return aliases[name] || 'missing';
}

function buildRecommendations(report) {
  const rec = [];
  if (report.legacyReferences.length) {
    rec.push(
      '清理或隔离 legacy 引用：优先确认是否为注释/门禁/已 410 路径；运行时路径禁止 fallback 到 cache/json/sqlite。',
    );
  }
  const bizRoutes = report.serverJsBusinessRoutes.filter((r) => r.category !== 'infra');
  if (bizRoutes.length > 8) {
    rec.push(
      `server.js 仍挂载 ${bizRoutes.length} 条非基础设施路由：汇率迁移到 modules/currency，TikTok OAuth 迁移到 modules/sync 或 modules/shops。`,
    );
  }
  if (report.duplicateMetricCandidates.length >= 3) {
    rec.push('合并 gmv-compare：dashboard/gmvCompareQuery 与 analytics/analyticsCompareService 应共享同一 service。');
  }
  if (report.frontendDirectApiCalls.length > 5) {
    rec.push('前端作战室组件改走 services/api/dashboard.ts，禁止页面级 apiFetch 重复实现。');
  }
  if (!report.moduleBoundaryStatus.realtime?.exists) {
    rec.push('建立 modules/realtime 或将 dashboard/orders 明确登记为 realtime 边界（见 module-boundary-map.md）。');
  }
  const missingDocs = REQUIRED_DOCS.filter((d) => !fs.existsSync(path.join(ROOT, d)));
  if (missingDocs.length) {
    rec.push(`补齐文档：${missingDocs.join(', ')}`);
  }
  rec.push('统计接口统一返回 timeWindow 元信息（当前多为 time_window/contract 片段，见 metric-definition-map.md）。');
  rec.push('Analytics 与 Dashboard 时间模型统一：日历 range vs hours 滚动窗需后端单一契约。');
  return rec;
}

function scanMetricAuthorityStatus() {
  const metricServiceFile = path.join(BACKEND, 'modules', 'analytics', 'metricService.js');
  const metricRepoFile = path.join(BACKEND, 'modules', 'analytics', 'metricRepository.js');
  const dashboardServiceText = readText('backend/modules/dashboard/service.js') || '';
  const analyticsControllerText = readText('backend/modules/analytics/controller.js') || '';
  return {
    metricServiceExists: fs.existsSync(metricServiceFile),
    metricRepositoryExists: fs.existsSync(metricRepoFile),
    dashboardUsesMetricService: /metricService/.test(dashboardServiceText),
    analyticsUsesMetricService: /metricService/.test(analyticsControllerText),
    authorityHint:
      /getDashboardSummary|getDashboardGmvCompare|getAnalyticsGmvCompare/.test(
        fs.existsSync(metricServiceFile) ? fs.readFileSync(metricServiceFile, 'utf8') : '',
      ),
  };
}

function scanTimeWindowCoverage() {
  const targets = [
    'backend/modules/dashboard/controller.js',
    'backend/modules/analytics/controller.js',
    'backend/modules/orders/ordersListController.js',
    'backend/modules/realtime/controller.js',
  ];
  const status = {};
  for (const file of targets) {
    const text = readText(file) || '';
    status[file] = /timeWindow|withTimeWindow/.test(text);
  }
  return status;
}

function scanRealtimeModuleStatus() {
  const routesText = readText('backend/modules/realtime/routes.js') || '';
  const controllerText = readText('backend/modules/dashboard/controller.js') || '';
  const routeRegister = readText('backend/routes/registerApiRoutes.js') || '';
  return {
    moduleExists: fs.existsSync(path.join(BACKEND, 'modules', 'realtime')),
    routesExists: fs.existsSync(path.join(BACKEND, 'modules', 'realtime', 'routes.js')),
    serviceExists: fs.existsSync(path.join(BACKEND, 'modules', 'realtime', 'service.js')),
    repositoryExists: fs.existsSync(path.join(BACKEND, 'modules', 'realtime', 'repository.js')),
    mounted: /\/api\/realtime/.test(routeRegister),
    dashboardOrdersReused: /realtimeService\.listOrders/.test(controllerText),
    hasOrdersRoute: /router\.get\('\/orders'/.test(routesText),
  };
}

function scanCurrencyModuleStatus() {
  const routeRegister = readText('backend/routes/registerApiRoutes.js') || '';
  const serverText = readText('backend/server.js') || '';
  const routesText = readText('backend/modules/currency/routes.js') || '';
  return {
    moduleExists: fs.existsSync(path.join(BACKEND, 'modules', 'currency')),
    routesExists: fs.existsSync(path.join(BACKEND, 'modules', 'currency', 'routes.js')),
    serviceExists: fs.existsSync(path.join(BACKEND, 'modules', 'currency', 'service.js')),
    repositoryExists: fs.existsSync(path.join(BACKEND, 'modules', 'currency', 'repository.js')),
    mountedAtApiRoot: /currency', '\/api'/.test(routeRegister),
    serverRouteRemoved: !/app\.get\('\/api\/exchange-rate'/.test(serverText),
    currencyRoutesProvideExchange: /\/exchange-rate/.test(routesText),
  };
}

function scanFrontendApiServiceCoverage(frontendDirectApiCalls) {
  const criticalFiles = [
    'frontend/src/components/RealtimeOrdersPanel.tsx',
    'frontend/src/components/OrderVolumeChart.tsx',
    'frontend/src/GmvCompareTrendPanel.tsx',
    'frontend/src/analytics/AnalyticsGmvCompareTrendPanel.tsx',
    'frontend/src/AnalyticsPage.tsx',
    'frontend/src/ShopMgmtPanel.tsx',
  ];
  const serviceFiles = [
    'frontend/src/services/api/dashboard.ts',
    'frontend/src/services/api/analytics.ts',
    'frontend/src/services/api/orders.ts',
    'frontend/src/services/api/shops.ts',
    'frontend/src/services/api/realtime.ts',
    'frontend/src/services/api/currency.ts',
    'frontend/src/services/api/logs.ts',
  ];
  const directCritical = frontendDirectApiCalls.filter((h) => criticalFiles.includes(h.file));
  const coverage = {};
  for (const f of serviceFiles) {
    coverage[f] = fs.existsSync(path.join(ROOT, f));
  }
  return {
    serviceFiles: coverage,
    directCriticalCount: directCritical.length,
    directCriticalSamples: directCritical.slice(0, 20),
    directTotalCount: frontendDirectApiCalls.length,
  };
}

function scanAnalyticsAuthorityStatus() {
  const repoText = readText('backend/modules/analytics/metricRepository.js') || '';
  const serviceText = readText('backend/modules/analytics/service.js') || '';
  const controllerText = readText('backend/modules/analytics/controller.js') || '';
  const ordersQueryText = readText('backend/modules/dashboard/ordersQuery.js') || '';
  const authorityLibText = readText('backend/lib/dashboardQueryAuthority.js') || '';
  const analyticsRoutesText = readText('backend/modules/analytics/routes.js') || '';

  const delegatesSummary = /summaryService\.getUnifiedSummary|getTodaySummary/.test(repoText);
  const delegatesProduct = /getProductRanking|getAnalyticsTopProducts/.test(repoText);
  const delegatesShop = /getShopRanking|getAnalyticsTopShops/.test(repoText);
  const delegatesTrend = /getOrderTrend|getAnalyticsShopTrend/.test(repoText);
  const delegatesRecent = /realtimeService\.listOrders|getAnalyticsRecentOrders/.test(repoText);
  const usesAuthorityQuery = /buildAuthorityServiceQuery|dashboardQueryAuthority/.test(repoText);

  const independentSumInActivePath =
    /getTopProducts|getTopShops|getShopTrend|getRecentOrders/.test(serviceText) &&
    !/module\.exports\s*=\s*\{[^}]*getTopProducts/s.test(serviceText);

  const independentSumSql =
    (serviceText.match(/SUM\s*\(/gi) || []).length +
    (readText('backend/modules/analytics/analyticsCompareService.js')?.match(/SUM\s*\(/gi) || []).length;

  const recentOrdersRateRisk =
    /preloadUsdRatesRows\(\[[^\]]*CNY/.test(ordersQueryText) ||
    (/preloadUsdRatesRows/.test(ordersQueryText) &&
      !/lenient:\s*true/.test(ordersQueryText) &&
      !/currenciesToLoad/.test(ordersQueryText));

  const recentOrdersLenient =
    /lenient:\s*true/.test(ordersQueryText) || /currenciesToLoad/.test(ordersQueryText);

  const analyticsAttachDataScope = /attachDataScope/.test(analyticsRoutesText);
  const debugAuthorityInController = /debugAuthority|attachDebugAuthority/.test(controllerText);

  return {
    dashboardQueryAuthorityLibExists: fs.existsSync(path.join(ROOT, 'backend', 'lib', 'dashboardQueryAuthority.js')),
    metricRepositoryUsesAuthorityQuery: usesAuthorityQuery,
    delegates: {
      summary: delegatesSummary,
      topProducts: delegatesProduct,
      topShops: delegatesShop,
      shopTrend: delegatesTrend,
      recentOrders: delegatesRecent,
    },
    analyticsRoutesAttachDataScope: analyticsAttachDataScope,
    analyticsControllerDebugAuthority: debugAuthorityInController,
    independentSumSqlHints: independentSumInActivePath ? independentSumSql : 0,
    recentOrdersHardcodedCurrencyPreloadRisk: recentOrdersRateRisk,
    recentOrdersLenientExchangeRates: recentOrdersLenient,
    authorityLibUsesParseDashboardFilterQuery: /parseDashboardFilterQuery/.test(authorityLibText),
  };
}

function scanFrontendQueryAuthorityStatus() {
  const storeFile = path.join(ROOT, 'frontend', 'src', 'stores', 'dashboardQueryStore.ts');
  const targets = [
    'frontend/src/legacy/LegacyDashboardPage.tsx',
    'frontend/src/AnalyticsPage.tsx',
    'frontend/src/pages/Orders/OrdersPage.tsx',
  ];
  const status = {
    dashboardQueryStoreExists: fs.existsSync(storeFile),
    pageStoreUsage: {},
    inlineQueryStateHints: [],
    handwrittenQueryStringHints: [],
  };
  const queryPattern = /(\?|\&)(market|range|orderFilter|status)\s*=/;
  const queryScanFiles = walkFiles(path.join(ROOT, 'frontend', 'src'), [], /\.(ts|tsx|js|jsx)$/);
  for (const file of queryScanFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!queryPattern.test(line)) return;
      status.handwrittenQueryStringHints.push({
        file: rel(file),
        line: i + 1,
        snippet: line.trim().slice(0, 160),
      });
    });
  }
  for (const file of targets) {
    const text = readText(file) || '';
    status.pageStoreUsage[file] = {
      importsStore: /dashboardQueryStore/.test(text),
      readsStore: /useDashboardQueryStore/.test(text),
      writesStore: /setDashboardQueryState/.test(text),
      anyStoreUsage: /dashboardQueryStore|useDashboardQueryStore|setDashboardQueryState/.test(text),
    };
    const hasLocalMarket = /useState\([^)]*market/i.test(text);
    const hasLocalRange = /useState\([^)]*range/i.test(text);
    const hasLocalFilter = /useState\([^)]*orderFilter|useState\([^)]*status/i.test(text);
    if (hasLocalMarket || hasLocalRange || hasLocalFilter) {
      status.inlineQueryStateHints.push({
        file,
        localMarketState: hasLocalMarket,
        localRangeState: hasLocalRange,
        localFilterState: hasLocalFilter,
      });
    }
  }
  return status;
}

function main() {
  const jsonOut = process.argv.includes('--json');
  const legacyReferences = scanLegacyReferences();
  const serverJsBusinessRoutes = scanServerJsBusinessRoutes();
  const duplicateMetricCandidates = scanDuplicateMetricCandidates();
  const unscopedApiCandidates = scanUnscopedApiCandidates();
  const frontendDirectApiCalls = scanFrontendDirectApiCalls();
  const moduleBoundaryStatus = buildModuleBoundaryStatus();
  const metricAuthorityStatus = scanMetricAuthorityStatus();
  const timeWindowCoverage = scanTimeWindowCoverage();
  const realtimeModuleStatus = scanRealtimeModuleStatus();
  const currencyModuleStatus = scanCurrencyModuleStatus();
  const frontendApiServiceCoverage = scanFrontendApiServiceCoverage(frontendDirectApiCalls);
  const frontendQueryAuthorityStatus = scanFrontendQueryAuthorityStatus();
  const analyticsAuthorityStatus = scanAnalyticsAuthorityStatus();
  const serverJsBusinessRouteCount = serverJsBusinessRoutes.filter((r) => r.category !== 'infra').length;

  const missingDocs = REQUIRED_DOCS.filter((d) => !fs.existsSync(path.join(ROOT, d)));

  const runtimeLegacyHits = legacyReferences.filter(
    (h) =>
      !h.file.includes('legacy-quarantine') &&
      !h.snippet.includes('禁止') &&
      !h.snippet.includes('410') &&
      !h.snippet.includes('LOCKED') &&
      !h.snippet.includes('check-no-dashboard'),
  );

  const ok =
    missingDocs.length === 0 &&
    runtimeLegacyHits.filter((h) => ['orders-cache', 'gmv-cache', 'shops-json'].includes(h.pattern)).length === 0;

  const p1Pass =
    metricAuthorityStatus.metricServiceExists &&
    metricAuthorityStatus.metricRepositoryExists &&
    Object.values(timeWindowCoverage).every(Boolean) &&
    realtimeModuleStatus.moduleExists &&
    realtimeModuleStatus.dashboardOrdersReused &&
    currencyModuleStatus.moduleExists &&
    currencyModuleStatus.serverRouteRemoved &&
    serverJsBusinessRouteCount <= 8 &&
    frontendApiServiceCoverage.directCriticalCount <= 5;

  const report = {
    ok,
    generatedAt: new Date().toISOString(),
    baseline: 'daping-staging clean',
    legacyReferences,
    serverJsBusinessRoutes,
    duplicateMetricCandidates,
    unscopedApiCandidates,
    frontendDirectApiCalls,
    moduleBoundaryStatus,
    metricAuthorityStatus,
    timeWindowCoverage,
    realtimeModuleStatus,
    currencyModuleStatus,
    frontendApiServiceCoverage,
    frontendQueryAuthorityStatus,
    analyticsAuthorityStatus,
    serverJsBusinessRouteCount,
    p1Pass,
    docsPresent: REQUIRED_DOCS.filter((d) => fs.existsSync(path.join(ROOT, d))),
    docsMissing: missingDocs,
    recommendations: [],
  };
  report.recommendations = buildRecommendations(report);

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('auditSaasUnification');
    console.log('ROOT=', ROOT);
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(ok ? 0 : 1);
}

main();
