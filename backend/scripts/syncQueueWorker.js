/**
 * Phase-4.1 同步队列 Worker（与 legacy collectOnce 并行部署，由 SYNC_WORKER_ENABLED 控制）
 */
require('../loadEnv');

const { startSyncQueueRuntime } = require('../sync/syncQueueRuntime');
const { isSyncWorkerEnabled } = require('../sync/services/syncEnv');

if (!isSyncWorkerEnabled()) {
  console.log('[sync-queue] SYNC_WORKER_ENABLED is off — exit');
  process.exit(0);
}

startSyncQueueRuntime();
console.log('[sync-queue] runtime active (Ctrl+C to stop)');

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
