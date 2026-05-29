'use strict';

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function isTruthyEnv(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isSyncWorkerEnabled() {
  return isTruthyEnv('SYNC_WORKER_ENABLED');
}

/** staging/prod 切流：仅 queue worker 拉单，禁止 legacy collectOnce 主同步 */
function isSyncQueueOnly() {
  return isTruthyEnv('SYNC_USE_QUEUE_ONLY');
}

function syncWorkerConcurrency() {
  return Math.min(8, Math.max(1, envInt('SYNC_WORKER_CONCURRENCY', 3)));
}

function isSyncJobRetryEnabled() {
  const v = String(process.env.SYNC_JOB_RETRY_ENABLED ?? '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function syncLockTimeoutMs() {
  return envInt('SYNC_LOCK_TIMEOUT_MS', 600000);
}

function syncSchedulerIntervalMs() {
  return Math.max(5000, envInt('SYNC_SCHEDULER_INTERVAL_MS', 30000));
}

function describeSyncMode() {
  return {
    worker_enabled: isSyncWorkerEnabled(),
    queue_only: isSyncQueueOnly(),
    concurrency: syncWorkerConcurrency(),
    retry_enabled: isSyncJobRetryEnabled(),
    lock_timeout_ms: syncLockTimeoutMs(),
    scheduler_interval_ms: syncSchedulerIntervalMs(),
  };
}

module.exports = {
  isTruthyEnv,
  isSyncWorkerEnabled,
  isSyncQueueOnly,
  syncWorkerConcurrency,
  isSyncJobRetryEnabled,
  syncLockTimeoutMs,
  syncSchedulerIntervalMs,
  describeSyncMode,
};
