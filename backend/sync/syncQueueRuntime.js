'use strict';

const { getMysqlPool } = require('../db/mysqlPool');
const { startSyncScheduler } = require('./queue/syncScheduler');
const { processOneSyncJob } = require('./workers/shopSyncWorker');
const { isSyncWorkerEnabled, isSyncQueueOnly, syncWorkerConcurrency } = require('./services/syncEnv');
const { isMissingSyncTableError } = require('./services/syncSchemaGuard');
const { logSyncSqlError } = require('./services/syncSql');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let syncWorkerPaused = false;
let syncWorkerPauseLogged = false;

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} workerIndex
 */
async function workerLoop(pool, workerIndex) {
  const tag = `w${workerIndex}`;
  while (true) {
    if (syncWorkerPaused) {
      await sleep(60000);
      continue;
    }
    try {
      const did = await processOneSyncJob(pool);
      if (!did) await sleep(1200);
      else await sleep(50);
    } catch (e) {
      if (isMissingSyncTableError(e)) {
        syncWorkerPaused = true;
        if (!syncWorkerPauseLogged) {
          const sqlTag = e?.sqlTag || 'worker_loop';
          const table = e?.sqlTable || 'unknown';
          console.log(
            `[sync-worker] paused reason=schema_invalid sqlTag=${sqlTag} table=${table} error=${e?.message || e}`,
          );
          syncWorkerPauseLogged = true;
        }
        await sleep(60000);
        continue;
      }
      if (!e?.sqlTagLogged) {
        logSyncSqlError(`${tag}_uncaught`, 'unknown', e);
      }
      await sleep(3000);
    }
  }
}

/**
 * @param {{ schemaReady?: boolean }} [opts]
 */
function startSyncQueueRuntime(opts = {}) {
  if (isSyncQueueOnly() && !isSyncWorkerEnabled()) {
    console.error(
      '[sync-queue-only] SYNC_USE_QUEUE_ONLY=1 requires SYNC_WORKER_ENABLED=1 — fix env and restart',
    );
    return { stop: () => {} };
  }

  if (!isSyncWorkerEnabled()) {
    return { stop: () => {} };
  }

  if (!opts.schemaReady) {
    console.log('[sync-worker] bootstrap skipped reason=schema_invalid');
    return { stop: () => {} };
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[sync-queue] mysql_unavailable');
    return { stop: () => {} };
  }

  syncWorkerPaused = false;
  syncWorkerPauseLogged = false;

  const stopScheduler = startSyncScheduler({ schemaReady: true });
  const n = syncWorkerConcurrency();
  for (let i = 0; i < n; i++) {
    void workerLoop(pool, i);
  }
  return {
    stop: () => {
      if (typeof stopScheduler === 'function') stopScheduler();
    },
  };
}

module.exports = { startSyncQueueRuntime };
