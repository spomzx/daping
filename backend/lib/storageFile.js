'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STORAGE_DIR = path.join(__dirname, '..', 'storage');
const LOCK_DIR = path.join(DEFAULT_STORAGE_DIR, '.locks');
const BACKUP_DIR = path.join(DEFAULT_STORAGE_DIR, 'backups');

const DEFAULT_MAX_BACKUPS = Math.max(1, Number(process.env.STORAGE_MAX_BACKUPS || 8));
const LOCK_STALE_MS = Math.max(60_000, Number(process.env.STORAGE_LOCK_STALE_MS || 600_000));
const LOCK_WAIT_MS = Math.max(1000, Number(process.env.STORAGE_LOCK_WAIT_MS || 45_000));
const MIN_FREE_BYTES = Math.max(0, Number(process.env.STORAGE_MIN_FREE_BYTES || 5 * 1024 * 1024));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function storageDir() {
  return process.env.STORAGE_DIR || DEFAULT_STORAGE_DIR;
}

function lockPath(lockKey) {
  const safe = String(lockKey || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(LOCK_DIR, `${safe}.lock`);
}

function backupDirFor(filePath) {
  const base = path.basename(filePath);
  return path.join(BACKUP_DIR, base);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 尽力检测剩余空间（跨平台，失败则跳过） */
function hasMinFreeSpace(dir) {
  if (MIN_FREE_BYTES <= 0) return true;
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.space-probe-${process.pid}-${Date.now()}`);
    const buf = Buffer.alloc(Math.min(MIN_FREE_BYTES, 64 * 1024));
    fs.writeFileSync(probe, buf);
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT')) return false;
    return true;
  }
}

function pruneBackups(filePath, maxBackups) {
  const dir = backupDirFor(filePath);
  if (!fs.existsSync(dir)) return;
  const base = path.basename(filePath);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base + '.') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (let i = maxBackups; i < files.length; i++) {
    try {
      fs.unlinkSync(path.join(dir, files[i].f));
    } catch {
      /* ignore */
    }
  }
}

function backupFileSync(filePath, maxBackups = DEFAULT_MAX_BACKUPS) {
  if (!fs.existsSync(filePath)) return null;
  const dir = backupDirFor(filePath);
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(filePath)}.${stamp}.json`);
  fs.copyFileSync(filePath, dest);
  pruneBackups(filePath, maxBackups);
  return dest;
}

function listBackupFiles(filePath) {
  const dir = backupDirFor(filePath);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(filePath);
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base + '.') && f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .map((p) => ({ path: p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function parseJsonContent(raw) {
  if (raw == null || raw === '') return { ok: false, error: 'empty' };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * 读取 JSON；主文件损坏时按备份从新到旧恢复，可选写回主文件。
 */
function readJsonWithRecovery(filePath, opts = {}) {
  const restore = opts.restore !== false;
  const candidates = [filePath, ...listBackupFiles(filePath).map((b) => b.path)];
  let lastErr = 'missing';
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      lastErr = String(e?.message || e);
      continue;
    }
    const parsed = parseJsonContent(raw);
    if (!parsed.ok) {
      lastErr = parsed.error;
      continue;
    }
    if (p !== filePath && restore) {
      try {
        atomicWriteJsonSync(filePath, parsed.data, { skipBackup: true, lockHeld: true });
        console.warn('[storage] restored', filePath, 'from', p);
      } catch (e) {
        console.warn('[storage] restore write failed:', filePath, e?.message || e);
      }
    }
    return { data: parsed.data, source: p, recovered: p !== filePath };
  }
  return { data: null, source: null, recovered: false, error: lastErr };
}

function readJsonSync(filePath, opts = {}) {
  const r = readJsonWithRecovery(filePath, opts);
  return r.data;
}

/**
 * 原子写入：tmp → rename；写前自动备份；磁盘不足时保留原文件。
 */
function atomicWriteJsonSync(filePath, data, opts = {}) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  if (!hasMinFreeSpace(dir)) {
    const err = new Error('storage_no_space');
    err.code = 'ENOSPC';
    throw err;
  }
  const pretty = opts.pretty !== false;
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  parseJsonContent(content);

  const release = opts.lockKey && !opts.lockHeld ? acquireLockSync(opts.lockKey) : () => {};

  try {
    if (!opts.skipBackup && fs.existsSync(filePath)) {
      backupFileSync(filePath, opts.maxBackups ?? DEFAULT_MAX_BACKUPS);
    }
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
  } finally {
    release();
  }
}

function tryBreakStaleLock(lp) {
  try {
    if (!fs.existsSync(lp)) return;
    const stat = fs.statSync(lp);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(lp);
      console.warn('[storage] removed stale lock', lp);
    }
  } catch {
    /* ignore */
  }
}

function acquireLockSync(lockKey) {
  ensureDir(LOCK_DIR);
  const lp = lockPath(lockKey);
  const start = Date.now();
  while (Date.now() - start < LOCK_WAIT_MS) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        'utf8',
      );
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lp);
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        tryBreakStaleLock(lp);
        const end = Date.now() + 40 + Math.floor(Math.random() * 60);
        while (Date.now() < end) {
          /* spin */
        }
        continue;
      }
      throw e;
    }
  }
  console.warn('[storage] lock wait timeout (sync spin)', { lockKey: 'sync' });
  const err = new Error('storage_lock_timeout');
  err.code = 'STORAGE_LOCK_TIMEOUT';
  throw err;
}

async function acquireLock(lockKey) {
  ensureDir(LOCK_DIR);
  const lp = lockPath(lockKey);
  const start = Date.now();
  while (Date.now() - start < LOCK_WAIT_MS) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        'utf8',
      );
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lp);
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        tryBreakStaleLock(lp);
        await sleep(50 + Math.floor(Math.random() * 50));
        continue;
      }
      throw e;
    }
  }
  console.warn('[storage] lock wait timeout', { lockKey });
  const err = new Error('storage_lock_timeout');
  err.code = 'STORAGE_LOCK_TIMEOUT';
  throw err;
}

async function withStorageLock(lockKey, fn) {
  const release = await acquireLock(lockKey);
  try {
    return await fn();
  } finally {
    release();
  }
}

function withStorageLockSync(lockKey, fn) {
  const release = acquireLockSync(lockKey);
  try {
    return fn();
  } finally {
    release();
  }
}

module.exports = {
  storageDir,
  LOCK_DIR,
  BACKUP_DIR,
  backupFileSync,
  readJsonWithRecovery,
  readJsonSync,
  atomicWriteJsonSync,
  acquireLock,
  acquireLockSync,
  withStorageLock,
  withStorageLockSync,
  hasMinFreeSpace,
  listBackupFiles,
};
