require('./loadEnv');

const path = require('path');
const express = require('express');
const cors = require('cors');

const { normalizeBaseCurrency, normalizeTargetCurrency } = require('./lib/rates');
const {
  getAuthUrl,
  handleCallbackByCode,
  buildPartnerAuthorizeUrl,
  getServiceAuthorizeResponse,
  normalizeOAuthRegion,
  normalizeSellerType,
  consumeOAuthState,
  logAuthRouting,
} = require('./tiktok-api/auth');
const { isStagingOAuthEnvironment } = require('./lib/tiktokOAuthUrl');
const { readShops, sanitizeShop, patchShopEnabled } = require('./tiktok-api/shops');
const { collectOnce } = require('./tiktok-api/scheduler');
const { runHealthCheck } = require('./lib/healthCheck');
const { getMetricsSnapshot } = require('./lib/syncMetrics');
const { optionalAuth } = require('./middlewares/optionalAuth');
const { authRequired, authRequiredAllowQueryToken } = require('./middlewares/authRequired');
const { requireRole } = require('./middlewares/requireRole');
const { requireFullAccess } = require('./middlewares/requireFullAccess');
const { collectNowLimiter } = require('./middlewares/rateLimit');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const SERVICE_VERSION = 'p8-ops-isolated';
const SERVICE_STARTED_AT = new Date().toISOString();
const STORAGE_DIR = path.join(__dirname, 'storage');

app.use(cors());
app.use(express.json());

/** 登录/注册：独立挂载，不受 users/shops/analytics 等模块 require 失败影响 */
try {
  const { router: authRouter } = require('./modules/auth/routes');
  app.use('/api/auth', authRouter);
  console.log('[routes] /api/auth mounted (login, register, logout, me)');
} catch (e) {
  const msg = e && e.message ? e.message : String(e);
  console.error('[routes] /api/auth mount failed (no fallback login route):', msg);
}

try {
  const { isMysqlConfigured } = require('./config/database');
  const { getMysqlPool } = require('./db/mysqlPool');
  if (isMysqlConfigured()) {
    getMysqlPool();
  } else {
    console.warn('[mysql] DB_* 未配置：业务 API 未挂载；/api/auth 仍可用（login 返回 database_not_configured）');
  }
} catch (e) {
  console.error('[mysql] pool init error:', e && e.message ? e.message : e);
}

function mountApiRouter(label, mountPath, modulePath) {
  try {
    const mod = require(modulePath);
    const router = mod.router || mod;
    if (!router) throw new Error('module has no router export');
    app.use(mountPath, router);
    console.log(`[routes] ${mountPath} mounted (${label})`);
    return true;
  } catch (e) {
    console.error(`[routes] ${mountPath} mount failed (${label}):`, e && e.message ? e.message : e);
    return false;
  }
}

const { registerApiRoutes } = require('./routes/registerApiRoutes');
registerApiRoutes(app, mountApiRouter);

if (isStagingOAuthEnvironment()) {
  console.log('[tiktok-auth] staging: authorize_mode=service_open_authorize (GET /api/tiktok/auth → JSON)');
}
const { registerRemovedLegacyGone } = require('./routes/removedLegacyGone');
registerRemovedLegacyGone(app);
try {
  const { SAAS_DATA_SOURCE_LABEL } = require('./lib/saasMysqlOnly');
  console.log(`[saas-mysql-only] SaaS API locked: ${SAAS_DATA_SOURCE_LABEL}`);
} catch (_) {
  /* ignore */
}

async function assertTenantActiveForOAuth(req) {
  const { getMysqlPool } = require('./db/mysqlPool');
  const { assertTenantActive, planErrorToHttp } = require('./modules/tenants/planService');
  const pool = getMysqlPool();
  if (pool && req.auth?.tenant_id) {
    try {
      await assertTenantActive(pool, Number(req.auth.tenant_id));
    } catch (e) {
      const mapped = planErrorToHttp(e);
      if (mapped) {
        const err = new Error('tenant_plan_blocked');
        err.status = mapped.status;
        err.body = mapped.body;
        throw err;
      }
      throw e;
    }
  }
}

async function handleTiktokServiceAuthorizeJson(req, res) {
  try {
    await assertTenantActiveForOAuth(req);
    return res.json(getServiceAuthorizeResponse(req.auth));
  } catch (e) {
    if (e && e.status && e.body) {
      return res.status(e.status).json(e.body);
    }
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
}

app.get('/api/tiktok/auth-url', authRequired, async (req, res) => {
  if (isStagingOAuthEnvironment()) {
    return handleTiktokServiceAuthorizeJson(req, res);
  }
  try {
    const qMarket = req.query.market ?? req.query.region;
    const market = typeof qMarket === 'string' ? qMarket : Array.isArray(qMarket) ? String(qMarket[0] || '') : '';
    const qSt = req.query.seller_type ?? req.query.sellerType;
    const requestedSellerType = typeof qSt === 'string' ? qSt : Array.isArray(qSt) ? String(qSt[0] || '') : '';
    const sellerType = normalizeSellerType(requestedSellerType);
    if (!sellerType) {
      return res.status(400).json({
        error: 'missing_seller_type',
        allowed: ['local', 'cross_border'],
      });
    }
    const parsedMarket = normalizeOAuthRegion(market);
    if (sellerType === 'local' && !parsedMarket) {
      return res.status(400).json({ error: 'missing_market', allowed: ['TH', 'MY', 'SG', 'PH', 'VN'] });
    }
    res.json(
      getAuthUrl(sellerType === 'local' ? parsedMarket : undefined, req.auth, {
        sellerType,
        requestedSellerType,
        market: sellerType === 'local' ? parsedMarket : null,
        source: String(req.query.source || 'saas'),
      }),
    );
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** prod：浏览器跳转 TikTok 授权（302），query: market/region + seller_type + token=JWT */
async function handleTiktokOAuthStart(req, res) {
  try {
    await assertTenantActiveForOAuth(req);
    const qSt = req.query.seller_type ?? req.query.sellerType;
    const rawSt = typeof qSt === 'string' ? qSt : Array.isArray(qSt) ? String(qSt[0] || '') : '';
    const requestedSellerType = rawSt.trim();
    const sellerType = normalizeSellerType(requestedSellerType);
    if (!sellerType) {
      return res.status(400).json({
        error: 'missing_seller_type',
        message: '必须传 seller_type=local 或 seller_type=cross_border',
        allowed: ['local', 'cross_border'],
      });
    }
    const qMarket = req.query.market ?? req.query.region;
    const rawMarket = typeof qMarket === 'string' ? qMarket : Array.isArray(qMarket) ? String(qMarket[0] || '') : '';
    let market = normalizeOAuthRegion(rawMarket);
    if (sellerType === 'local') {
      if (!market) {
        return res.status(400).json({
          error: 'missing_market',
          message: '本土店授权必须传 market=TH|MY|SG|PH|VN',
          allowed: ['TH', 'MY', 'SG', 'PH', 'VN'],
        });
      }
    } else {
      market = null;
    }
    const qSrc = req.query.source;
    const source = typeof qSrc === 'string' ? qSrc : Array.isArray(qSrc) ? String(qSrc[0] || '') : 'saas';
    const url = buildPartnerAuthorizeUrl(req.auth, {
      sellerType,
      requestedSellerType,
      market,
      source,
      tenantId: req.auth?.tenant_id,
    });
    return res.redirect(302, url);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

const tiktokOAuthAdminMiddleware = [
  authRequired,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
];

const tiktokOAuthStartMiddleware = [
  authRequiredAllowQueryToken,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  handleTiktokOAuthStart,
];

if (isStagingOAuthEnvironment()) {
  app.get('/api/tiktok/auth', ...tiktokOAuthAdminMiddleware, handleTiktokServiceAuthorizeJson);
  app.get(
    '/api/tiktok/auth/start',
    authRequiredAllowQueryToken,
    requireFullAccess,
    requireRole('admin', 'super_admin'),
    handleTiktokServiceAuthorizeJson,
  );
} else {
  app.get('/api/tiktok/auth/start', ...tiktokOAuthStartMiddleware);
  app.get('/api/tiktok/auth', ...tiktokOAuthStartMiddleware);
}

/**
 * OAuth 回调（需在 TikTok 控制台配置为 TIKTOK_REDIRECT_URI；推荐使用 /api/tiktok/auth/callback）
 * 校验 state 后落库并回到大屏
 */
app.get('/api/tiktok/auth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const serviceAuthorizeEnabled = Boolean(String(process.env.TIKTOK_SERVICE_AUTHORIZE_URL || '').trim());
    logAuthRouting('callback_received', { has_code: Boolean(code), has_state: Boolean(state) });
    let meta = consumeOAuthState(state);
    if (!meta && serviceAuthorizeEnabled && code) {
      meta = {
        tenantId: Number(process.env.TIKTOK_DEFAULT_TENANT_ID || 6),
        userId: Number(process.env.TIKTOK_DEFAULT_USER_ID || 27),
        source: 'service_open_authorize',
        sellerType: null,
        market: null,
        region: null,
      };
      logAuthRouting('callback_state_fallback_service_authorize', {
        tenant_id: meta.tenantId,
        user_id: meta.userId,
        has_code: true,
      });
    }
    logAuthRouting('callback_state_parsed', meta ? {
      tenant_id: meta.tenantId,
      market: meta.market,
      seller_type: meta.sellerType,
      source: meta.source,
      nonce: meta.nonce,
    } : { ok: false });
    if (!meta) {
      return res.redirect(302, '/?shop_auth=error&reason=invalid_state');
    }
    if (!meta.tenantId) {
      return res.redirect(302, '/?shop_auth=error&reason=oauth_missing_tenant');
    }
    if (!code) {
      return res.redirect(302, '/?shop_auth=error&reason=missing_code');
    }
    const result = await handleCallbackByCode(code, {
      oauthRegion: meta.region,
      oauthMarket: meta.market,
      sellerType: meta.sellerType,
      source: meta.source,
      tenantId: meta.tenantId,
      userId: meta.userId,
    });
    if (!result?.ok) {
      return res.redirect(302, '/?shop_auth=error&reason=no_shops_saved');
    }
    const q = new URLSearchParams({
      shop_auth: 'ok',
      imported: String(result.imported_count ?? 0),
      updated: String(result.updated_count ?? 0),
      skipped: String(result.skipped_count ?? 0),
    });
    return res.redirect(302, `/?${q.toString()}`);
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    const msg = encodeURIComponent(code || String(e?.message || e).slice(0, 240));
    return res.redirect(302, `/?shop_auth=error&reason=${msg}`);
  }
});

/** JSON 回调（与 auth/callback 相同校验；redirect_uri 若仍指向此路径则继续可用） */
app.get('/api/tiktok/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    logAuthRouting('callback_received', { has_code: Boolean(code), has_state: Boolean(state), path: '/api/tiktok/callback' });
    const meta = consumeOAuthState(state);
    logAuthRouting('callback_state_parsed', meta ? {
      tenant_id: meta.tenantId,
      market: meta.market,
      seller_type: meta.sellerType,
      source: meta.source,
      nonce: meta.nonce,
    } : { ok: false });
    if (!meta) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_or_expired_state',
        message: '请从大屏「添加店铺授权」或连接店铺入口重新发起授权',
      });
    }
    if (!meta.tenantId) {
      return res.status(400).json({ ok: false, error: 'oauth_missing_tenant' });
    }
    if (!code) {
      return res.status(400).json({ ok: false, error: 'missing_code' });
    }
    const result = await handleCallbackByCode(code, {
      oauthRegion: meta.region,
      oauthMarket: meta.market,
      sellerType: meta.sellerType,
      source: meta.source,
      tenantId: meta.tenantId,
      userId: meta.userId,
    });
    res.json({
      ok: Boolean(result?.ok),
      imported_count: result.imported_count ?? 0,
      updated_count: result.updated_count ?? 0,
      skipped_count: result.skipped_count ?? 0,
      skipped: result.skipped ?? [],
      authorizedShopsDebug: result?.authorizedShopsDebug || null,
      shops: Array.isArray(result?.shops) ? result.shops.map((s) => sanitizeShop(s)) : [],
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      authorizedShopsDebug: e?.debug || null,
      shops: [],
      error: String(e?.message || e),
    });
  }
});

app.get(
  '/api/tiktok/shops',
  authRequired,
  requireFullAccess,
  requireRole('viewer', 'admin', 'super_admin'),
  (_req, res) => {
    res.json({ shops: readShops().map((s) => sanitizeShop(s)) });
  },
);

app.post(
  '/api/tiktok/shops/:shopId/disable',
  authRequired,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  (req, res) => {
    const shop = patchShopEnabled(req.params.shopId, false);
    if (!shop) return res.status(404).json({ ok: false, error: 'shop_not_found' });
    res.json({ ok: true, shop: sanitizeShop(shop) });
  },
);

app.post(
  '/api/tiktok/shops/:shopId/enable',
  authRequired,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  (req, res) => {
    const shop = patchShopEnabled(req.params.shopId, true);
    if (!shop) return res.status(404).json({ ok: false, error: 'shop_not_found' });
    res.json({ ok: true, shop: sanitizeShop(shop) });
  },
);

app.post(
  '/api/tiktok/collect-now',
  authRequired,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  collectNowLimiter,
  async (req, res) => {
    try {
      const { isSyncQueueOnly } = require('./sync/services/syncEnv');
      if (isSyncQueueOnly()) {
        return res.status(409).json({
          ok: false,
          error: 'collect_once_disabled',
          message: 'SYNC_USE_QUEUE_ONLY=1：请使用队列 worker 或 /api/sync/run',
        });
      }
      const baseCurrency = normalizeBaseCurrency(req.body?.baseCurrency);
      const targetCurrency = normalizeTargetCurrency(req.body?.targetCurrency);
      const payload = await collectOnce({ baseCurrency, targetCurrency });
      res.json({ ok: true, meta: payload?.meta || null, summary: payload?.summary || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  },
);

app.get('/api/dashboard/ping', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.json({ ok: true, route: 'dashboard' });
});

app.get('/api/health', async (req, res) => {
  try {
    const body = await runHealthCheck(STORAGE_DIR);
    res.status(body.status === 'unhealthy' ? 503 : 200).json({
      ...body,
      service: 'gmv-dashboard-api',
      version: SERVICE_VERSION,
      startedAt: SERVICE_STARTED_AT,
    });
  } catch (e) {
    res.status(503).json({
      status: 'unhealthy',
      error: String(e?.message || e),
      service: 'gmv-dashboard-api',
      version: SERVICE_VERSION,
    });
  }
});

app.get('/api/metrics', optionalAuth, (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });
  const metrics = getMetricsSnapshot();
  res.json({
    ok: true,
    version: SERVICE_VERSION,
    dataSourcePrimary: 'mysql',
    ...metrics,
  });
});

const frontendDist = path.join(__dirname, '../frontend/dist');

app.use(express.static(frontendDist));

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api')) return next();
  return res.sendFile(path.join(frontendDist, 'index.html'));
});

console.log(
  '[server] SaaS mysql-only | /api/auth | registerApiRoutes | TikTok OAuth | /api/health | static',
);

let dashboardCacheWarmupHookDone = false;

function bootDashboardCacheWarmup(hook = 'listen') {
  if (dashboardCacheWarmupHookDone) return;
  dashboardCacheWarmupHookDone = true;
  try {
    const { scheduleDashboardCacheWarmup } = require('./lib/dashboardCacheWarmup');
    scheduleDashboardCacheWarmup();
  } catch (e) {
    console.error(`[dashboard-cache-warmup] boot failed hook=${hook}`, e?.stack || e?.message || e);
  }
}

const httpServer = app.listen(PORT, () => {
  console.log(`GMV API running on http://localhost:${PORT}`);
  console.log(`[gmv] ${SERVICE_VERSION} | dashboard primary=mysql`);
});

function bootSyncQueueWorker(hook = 'listen') {
  void (async () => {
    try {
      const { bootstrapSyncWorker } = require('./sync/bootstrapSyncWorker');
      await bootstrapSyncWorker(hook);
    } catch (e) {
      console.error('[sync-worker] bootstrap failed', e?.message || e);
    }
  })();
}

httpServer.on('listening', () => {
  bootDashboardCacheWarmup('listening');
  try {
    const { isPrecomputeSchedulerEnabled } = require('./lib/dashboardReadonly');
    if (!isPrecomputeSchedulerEnabled()) {
      const { startDashboardRefreshScheduler } = require('./lib/dashboardRefreshScheduler');
      startDashboardRefreshScheduler();
    }
  } catch (e) {
    console.error('[dashboard-refresh-scheduler] boot failed', e?.message || e);
  }
  try {
    const { startDashboardSnapshotCleanupScheduler, logDashboardSnapshotBootState } = require('./lib/dashboardSnapshotCache');
    logDashboardSnapshotBootState();
    startDashboardSnapshotCleanupScheduler();
  } catch (e) {
    console.warn('[dashboard-snapshot] cleanup scheduler boot failed', e?.message || e);
  }
  try {
    const { isPrecomputeSchedulerEnabled } = require('./lib/dashboardReadonly');
    if (!isPrecomputeSchedulerEnabled()) {
      const { startDashboardSnapshotWarmScheduler } = require('./lib/dashboardSnapshotWarmScheduler');
      startDashboardSnapshotWarmScheduler();
    }
  } catch (e) {
    console.warn('[dashboard-snapshot-warmup] scheduler boot failed', e?.message || e);
  }
  try {
    const { isDashboardApiReadonly } = require('./lib/dashboardReadonly');
    console.log(`[dashboard-readonly] boot enabled=${isDashboardApiReadonly() ? '1' : '0'}`);
    const { startDashboardPrecomputeScheduler } = require('./lib/dashboardPrecomputeScheduler');
    startDashboardPrecomputeScheduler();
  } catch (e) {
    console.error('[dashboard-precompute] boot failed', e?.message || e);
  }
  bootSyncQueueWorker('listening');
});
