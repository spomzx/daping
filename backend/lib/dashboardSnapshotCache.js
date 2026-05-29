'use strict';

/**
 * Dashboard JSON snapshot 本地缓存（非事实源；MySQL-only 原则不变）
 * @deprecated Snapshot is no longer part of SaaS dashboard primary cache path.
 * SaaS 主读链路为 memory → dashboard_*_cache 表 → MySQL loader（见 dashboardCacheService）。
 * 本模块仅供 warmup/cleanup 运维与历史兼容，禁止在 withDashboardCache 主路径读取。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isTrendCacheEndpoint } = require('./dashboardTrendTtl');
const { trendPayloadIsEmpty } = require('./dashboardTrendCacheMeta');

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_ROOT = path.join(__dirname, '..', 'storage', 'dashboard-snapshot');

/** @type {Record<string, string>} */
const ENDPOINT_DIR = {
  summary: 'summary',
  ranking: 'shop-ranking',
  'product-ranking': 'product-ranking',
  'gmv-compare': 'gmv-compare',
  'order-volume': 'order-volume',
};

const SNAPSHOT_ENDPOINTS = new Set(Object.keys(ENDPOINT_DIR));

/** @type {boolean|null} */
let storageWritableCache = null;

function isTruthyEnvFlag(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function isProdDeploy() {
  const stage = String(
    process.env.APP_ENV || process.env.DEPLOY_ENV || process.env.STAGE || process.env.APP_STAGE || '',
  )
    .trim()
    .toLowerCase();
  return stage === 'prod' || stage === 'production';
}

/**
 * 默认与 table cache 对齐开启；显式 DASHBOARD_SNAPSHOT_CACHE_ENABLED=0 关闭。
 * prod 部署标记（APP_ENV=prod）且未显式开启时保持关闭（不改 prod .env）。
 */
function checkSnapshotStorageWritable() {
  if (storageWritableCache != null) return storageWritableCache;
  try {
    fs.mkdirSync(SNAPSHOT_ROOT, { recursive: true });
    const testFile = path.join(SNAPSHOT_ROOT, '.write-test');
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    storageWritableCache = true;
  } catch (e) {
    storageWritableCache = false;
    console.error(
      `[dashboard-snapshot] storage not writable root=${SNAPSHOT_ROOT} error=${e?.message || e}`,
    );
  }
  return storageWritableCache;
}

function isSnapshotStorageWritable() {
  return checkSnapshotStorageWritable();
}

function isSnapshotCacheEnabled() {
  if (!checkSnapshotStorageWritable()) return false;
  const raw = process.env.DASHBOARD_SNAPSHOT_CACHE_ENABLED;
  if (raw != null && String(raw).trim() !== '') {
    return isTruthyEnvFlag(raw);
  }
  if (isProdDeploy()) return false;
  return isTruthyEnvFlag(process.env.DASHBOARD_TABLE_CACHE_ENABLED ?? '1');
}

function isSnapshotCleanupEnabled() {
  const raw = process.env.DASHBOARD_SNAPSHOT_CLEANUP_ENABLED;
  if (raw == null || String(raw).trim() === '') return isSnapshotCacheEnabled();
  return isTruthyEnvFlag(raw);
}

function retentionDays() {
  const n = Number(process.env.DASHBOARD_SNAPSHOT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

function isSnapshotEndpoint(endpoint) {
  return SNAPSHOT_ENDPOINTS.has(String(endpoint || '').trim());
}

/**
 * @param {string} raw
 * @param {{ fallback?: string, maxLen?: number }} [opts]
 */
function safeSegment(raw, opts = {}) {
  const fb = opts.fallback != null ? String(opts.fallback) : 'all';
  let s = String(raw ?? fb)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!s) s = fb;
  const maxLen = opts.maxLen != null ? opts.maxLen : 48;
  return s.slice(0, maxLen);
}

/**
 * @param {string} raw
 */
function safeMarket(raw) {
  let s = String(raw ?? 'ALL')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '_');
  if (!s) s = 'ALL';
  return s.slice(0, 32);
}

/**
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 */
function normalizeContractDims(contract) {
  return {
    shopId: safeSegment(contract?.shopId, { fallback: 'all' }),
    market: safeMarket(contract?.market),
    orderFilter: safeSegment(contract?.orderFilter, { fallback: 'all' }),
    timeRange: safeSegment(contract?.timeRange, { fallback: 'today' }),
    startDate: safeSegment(contract?.startDate, { fallback: '', maxLen: 16 }),
    endDate: safeSegment(contract?.endDate, { fallback: '', maxLen: 16 }),
  };
}

/**
 * @param {string} cacheKey
 */
function shortFilterHash(cacheKey) {
  return crypto.createHash('sha256').update(String(cacheKey || '')).digest('hex').slice(0, 6);
}

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 * }} query
 */
function buildSnapshotFileBase(query) {
  const endpoint = safeSegment(query.endpoint, { fallback: 'unknown', maxLen: 32 });
  const dims = normalizeContractDims(query.contract);
  const hash = shortFilterHash(
    query.cacheKey ||
      `dashboard:${endpoint}:${query.tenantId}:${dims.shopId}:${dims.market}:${dims.orderFilter}:${dims.timeRange}`,
  );
  // filterHash 已含 cacheKey 全部维度（含 groupBy），不再追加 extraSuffix 避免读写路径漂移
  return `${endpoint}_${dims.timeRange}_${dims.orderFilter}_${dims.market}_${dims.shopId}_${hash}`;
}

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 * }} query
 * @returns {{ dir: string, filePath: string, tmpPath: string, fileName: string }}
 */
function buildDashboardSnapshotPath(query) {
  const endpoint = String(query.endpoint || '').trim();
  const dirName = ENDPOINT_DIR[endpoint];
  if (!dirName) {
    throw new Error(`snapshot_endpoint_not_allowed:${endpoint}`);
  }
  const tenantId = Math.floor(Number(query.tenantId));
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    throw new Error('snapshot_invalid_tenant');
  }
  const tenantSeg = `tenant-${tenantId}`;
  const base = buildSnapshotFileBase(query);
  const fileName = `${base}.json`;
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error('snapshot_unsafe_filename');
  }
  const dir = path.join(SNAPSHOT_ROOT, tenantSeg, dirName);
  const filePath = path.join(dir, fileName);
  const resolved = path.resolve(filePath);
  const rootResolved = path.resolve(SNAPSHOT_ROOT);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error('snapshot_path_escape');
  }
  return { dir, filePath: resolved, fileName };
}

/**
 * 唯一临时文件，避免多 worker 并发写同一 .tmp 导致 JSON 损坏
 * @param {string} resolvedFinalPath
 */
function buildUniqueSnapshotTmpPath(resolvedFinalPath) {
  const rand = crypto.randomBytes(4).toString('hex');
  return `${resolvedFinalPath}.tmp.${process.pid}.${Date.now()}.${rand}`;
}

/**
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 */
function snapshotTtlMs(contract, endpoint = 'gmv-compare') {
  try {
    const { isPrecomputeSchedulerEnabled } = require('./dashboardReadonly');
    const { precomputeTtlMs } = require('./dashboardPrecomputeTtl');
    if (isPrecomputeSchedulerEnabled()) {
      return precomputeTtlMs(endpoint, contract);
    }
  } catch {
    /* ignore */
  }
  const tr = String(contract?.timeRange || 'today')
    .trim()
    .toLowerCase();
  const envNum = (key, fallback) => {
    const n = Number(process.env[key]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  if (tr === 'today') return envNum('DASHBOARD_SNAPSHOT_TTL_TODAY_MS', 90_000);
  if (tr === 'yesterday') return envNum('DASHBOARD_SNAPSHOT_TTL_YESTERDAY_MS', 300_000);
  if (tr === 'last7') return envNum('DASHBOARD_SNAPSHOT_TTL_LAST7_MS', 600_000);
  if (tr === 'last30') return envNum('DASHBOARD_SNAPSHOT_TTL_LAST30_MS', 1_800_000);
  if (tr === 'custom') {
    const start = String(contract?.startDate || '').trim();
    const end = String(contract?.endDate || '').trim();
    let days = 7;
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      const a = Date.parse(`${start}T00:00:00Z`);
      const b = Date.parse(`${end}T00:00:00Z`);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
        days = Math.max(1, Math.ceil((b - a) / 86400000) + 1);
      }
    }
    return Math.min(1_800_000, Math.max(300_000, days * 60_000));
  }
  return 600_000;
}

/**
 * 剩余 TTL 低于此阈值时，读路径按 snapshot-stale 立即返回并后台刷新（避免 ttlMs=0~5 触发同步 MySQL）
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 */
function snapshotNearExpiryRemainingMs(contract) {
  const ttl = snapshotTtlMs(contract);
  const tr = String(contract?.timeRange || 'today')
    .trim()
    .toLowerCase();
  if (tr === 'today') return Math.max(10_000, Math.floor(ttl * 0.12));
  if (tr === 'yesterday') return Math.max(20_000, Math.floor(ttl * 0.1));
  return Math.max(30_000, Math.floor(ttl * 0.08));
}

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 * }} query
 * @param {unknown} data
 * @param {number} [ttlMs]
 */
async function writeDashboardSnapshotCache(query, data, ttlMs) {
  if (!isSnapshotCacheEnabled() || !isSnapshotEndpoint(query.endpoint)) return;
  const ttl =
    ttlMs != null && ttlMs > 0
      ? Math.floor(ttlMs)
      : snapshotTtlMs(query.contract, query.endpoint);
  const dims = normalizeContractDims(query.contract);
  const filterHash = query.cacheKey || '';
  const now = Date.now();
  const envelope = {
    version: SNAPSHOT_VERSION,
    endpoint: String(query.endpoint),
    tenantId: Math.floor(Number(query.tenantId)),
    shopId: dims.shopId,
    market: dims.market,
    orderFilter: dims.orderFilter,
    timeRange: dims.timeRange,
    filterHash,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    source: 'mysql',
    data,
  };

  try {
    const paths = buildDashboardSnapshotPath(query);
    await fs.promises.mkdir(paths.dir, { recursive: true });
    const tmpPath = buildUniqueSnapshotTmpPath(paths.filePath);
    const body = JSON.stringify(envelope);
    await fs.promises.writeFile(tmpPath, body, 'utf8');
    await fs.promises.rename(tmpPath, paths.filePath);
    console.log(
      `[dashboard-snapshot] write endpoint=${query.endpoint} tenant=${query.tenantId} timeRange=${dims.timeRange} market=${dims.market} orderFilter=${dims.orderFilter} shopId=${dims.shopId} ttlMs=${ttl} path=${paths.filePath}`,
    );
  } catch (e) {
    console.warn(
      `[dashboard-snapshot] write fail endpoint=${query.endpoint} tenant=${query.tenantId}`,
      e?.message || e,
    );
  }
}

/**
 * @param {string} filePath
 * @param {string} reason
 */
async function removeInvalidSnapshotFile(filePath, reason) {
  try {
    await fs.promises.unlink(filePath);
    console.warn(`[dashboard-snapshot] invalid-removed path=${filePath} reason=${reason}`);
  } catch (e) {
    console.warn(
      `[dashboard-snapshot] invalid-remove-fail path=${filePath} reason=${reason}`,
      e?.message || e,
    );
  }
}

/**
 * 精确路径未命中时，按 hash 后缀扫描目录（兼容历史 extraSuffix 文件）
 * @param {ReturnType<typeof buildDashboardSnapshotPath>} paths
 * @param {string} hash6
 */
async function resolveSnapshotFileByHash(paths, hash6) {
  try {
    const names = await fs.promises.readdir(paths.dir);
    const match = names.find((n) => n.endsWith('.json') && n.includes(`_${hash6}.json`));
    if (!match) return null;
    return path.join(paths.dir, match);
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 * }} query
 * @param {{ allowStale?: boolean }} [readOpts]
 * @returns {Promise<{
 *   hit: boolean,
 *   val?: unknown,
 *   ttlMs?: number,
 *   stale?: boolean,
 *   logSource: 'snapshot'|'snapshot-stale'|'snapshot-miss'|'snapshot-invalid',
 * }>}
 * @deprecated Snapshot is no longer part of SaaS dashboard primary cache path.
 */
async function readDashboardSnapshotCache(query, readOpts = {}) {
  const miss = (logSource) => ({ hit: false, logSource });
  if (!isSnapshotCacheEnabled() || !isSnapshotEndpoint(query.endpoint)) {
    return miss('snapshot-miss');
  }

  let paths;
  try {
    paths = buildDashboardSnapshotPath(query);
  } catch (e) {
    console.warn('[dashboard-snapshot] path build fail', e?.message || e);
    return miss('snapshot-miss');
  }

  const hash6 = shortFilterHash(
    query.cacheKey ||
      `dashboard:${query.endpoint}:${query.tenantId}:${normalizeContractDims(query.contract).shopId}`,
  );

  let filePath = paths.filePath;
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const alt = await resolveSnapshotFileByHash(paths, hash6);
      if (!alt) {
        console.log(
          `[dashboard-snapshot] read miss endpoint=${query.endpoint} tenant=${query.tenantId} path=${filePath}`,
        );
        return miss('snapshot-miss');
      }
      filePath = alt;
      try {
        raw = await fs.promises.readFile(filePath, 'utf8');
      } catch (e2) {
        console.warn('[dashboard-snapshot] read fail', filePath, e2?.message || e2);
        return miss('snapshot-miss');
      }
    } else {
      console.warn('[dashboard-snapshot] read fail', filePath, e?.message || e);
      return miss('snapshot-miss');
    }
  }

  /** @type {Record<string, unknown>} */
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    console.warn('[dashboard-snapshot] cacheSource=snapshot-invalid', filePath, e?.message || e);
    await removeInvalidSnapshotFile(filePath, 'json_parse');
    return miss('snapshot-invalid');
  }

  if (!doc || typeof doc !== 'object' || doc.version !== SNAPSHOT_VERSION) {
    console.warn('[dashboard-snapshot] cacheSource=snapshot-invalid', filePath, 'bad_version');
    await removeInvalidSnapshotFile(filePath, 'bad_version');
    return miss('snapshot-invalid');
  }

  const expMs = Date.parse(String(doc.expiresAt || ''));
  const fresh = Number.isFinite(expMs) && expMs > Date.now();
  if (!fresh && !readOpts.allowStale) {
    return miss('snapshot-miss');
  }

  const val = doc.data;
  const ttlMs = Number.isFinite(expMs)
    ? Math.max(0, expMs - Date.now())
    : snapshotTtlMs(query.contract, query.endpoint);
  const logSource = fresh ? 'snapshot' : 'snapshot-stale';
  console.log(
    `[dashboard-snapshot] read hit endpoint=${query.endpoint} tenant=${query.tenantId} cacheSource=${logSource} stale=${!fresh} path=${filePath}`,
  );
  return { hit: true, val, ttlMs, stale: !fresh, logSource, filePath };
}

/**
 * @param {string} filePath
 */
async function fileOlderThanRetention(filePath, cutoffMs) {
  try {
    const st = await fs.promises.stat(filePath);
    const t = st.mtimeMs || st.mtime?.getTime?.() || 0;
    if (t > 0 && t < cutoffMs) return true;
  } catch {
    /* ignore */
  }
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const doc = JSON.parse(raw);
    const gen = Date.parse(String(doc.generatedAt || ''));
    if (Number.isFinite(gen) && gen < cutoffMs) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * @param {string} dir
 * @param {number} cutoffMs
 */
async function walkCleanupDir(dir, cutoffMs) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { removed: 0, scanned: 0 };
    throw e;
  }
  let removed = 0;
  let scanned = 0;
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await walkCleanupDir(full, cutoffMs);
      removed += sub.removed;
      scanned += sub.scanned;
      continue;
    }
    if (!ent.isFile()) continue;
    scanned += 1;
    if (ent.name.includes('.tmp') || ent.name.endsWith('.tmp')) {
      try {
        await fs.promises.unlink(full);
        removed += 1;
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!ent.name.endsWith('.json')) continue;
    if (await fileOlderThanRetention(full, cutoffMs)) {
      try {
        await fs.promises.unlink(full);
        removed += 1;
      } catch (e) {
        console.warn('[dashboard-snapshot] cleanup unlink fail', full, e?.message || e);
      }
    }
  }
  return { removed, scanned };
}

async function cleanupDashboardSnapshotCache() {
  if (!isSnapshotCleanupEnabled()) return { removed: 0, scanned: 0 };
  const days = retentionDays();
  const cutoffMs = Date.now() - days * 86400000;
  try {
    await fs.promises.mkdir(SNAPSHOT_ROOT, { recursive: true });
    const result = await walkCleanupDir(SNAPSHOT_ROOT, cutoffMs);
    console.log(
      `[dashboard-snapshot] cleanup done retentionDays=${days} removed=${result.removed} scanned=${result.scanned}`,
    );
    return result;
  } catch (e) {
    console.warn('[dashboard-snapshot] cleanup fail', e?.message || e);
    return { removed: 0, scanned: 0, error: String(e?.message || e) };
  }
}

/** 启动时一次 + 每 24h */
function startDashboardSnapshotCleanupScheduler() {
  if (!isSnapshotCleanupEnabled()) return;
  void cleanupDashboardSnapshotCache();
  const DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    void cleanupDashboardSnapshotCache();
  }, DAY_MS);
}

/**
 * @param {string} endpoint
 * @param {unknown} val
 * @param {(v: unknown) => number|undefined} [rowsPick]
 */
function shouldPersistSnapshot(endpoint, val, rowsPick) {
  if (!isSnapshotCacheEnabled() || !isSnapshotEndpoint(endpoint)) return false;
  if (val == null) return false;
  if (isTrendCacheEndpoint(endpoint)) {
    return !trendPayloadIsEmpty(endpoint, val, rowsPick);
  }
  return true;
}

/**
 * warmup 跳过原因：fresh | fresh-stale | null=需要刷新
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 * }} query
 */
async function snapshotWarmSkipReason(query) {
  if (!isSnapshotCacheEnabled()) return 'disabled';
  const fresh = await readDashboardSnapshotCache(query, { allowStale: false });
  if (fresh.hit) return 'fresh';
  const ttlCap = snapshotTtlMs(query.contract, query.endpoint);
  const stale = await readDashboardSnapshotCache(query, { allowStale: true });
  if (stale.hit && stale.ttlMs != null && stale.ttlMs > ttlCap * 0.2) {
    return 'fresh-stale';
  }
  return null;
}

/** 启动时打印 snapshot 开关（便于 staging 验收） */
function logDashboardSnapshotBootState() {
  checkSnapshotStorageWritable();
  const writable = storageWritableCache === true;
  const enabled = writable && isSnapshotCacheEnabled();
  console.log(
    `[dashboard-snapshot] boot enabled=${enabled ? '1' : '0'} root=${SNAPSHOT_ROOT} writable=${writable ? 'true' : 'false'} prodDeploy=${isProdDeploy() ? '1' : '0'}`,
  );
}

module.exports = {
  SNAPSHOT_ROOT,
  ENDPOINT_DIR,
  SNAPSHOT_ENDPOINTS,
  isSnapshotCacheEnabled,
  isSnapshotEndpoint,
  isSnapshotCleanupEnabled,
  snapshotTtlMs,
  snapshotNearExpiryRemainingMs,
  buildDashboardSnapshotPath,
  buildSnapshotFileBase,
  readDashboardSnapshotCache,
  writeDashboardSnapshotCache,
  cleanupDashboardSnapshotCache,
  startDashboardSnapshotCleanupScheduler,
  shouldPersistSnapshot,
  logDashboardSnapshotBootState,
  isProdDeploy,
  checkSnapshotStorageWritable,
  isSnapshotStorageWritable,
  snapshotWarmSkipReason,
};
