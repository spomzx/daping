'use strict';

/**
 * 主进程（server.js）内嵌启动 sync scheduler + worker 池（仅 bootstrap 一次）。
 */

const { ensureSyncSchemaReady } = require('./services/syncSchemaGuard');

let syncQueueBootstrapDone = false;

async function bootstrapSyncWorker(hook = 'listen') {
  if (syncQueueBootstrapDone) return;
  syncQueueBootstrapDone = true;

  let isSyncWorkerEnabled;
  let isSyncQueueOnly;
  let syncWorkerConcurrency;
  try {
    ({ isSyncWorkerEnabled, isSyncQueueOnly, syncWorkerConcurrency } = require('./services/syncEnv'));
  } catch (e) {
    console.error('[sync-worker] bootstrap failed', e?.message || e);
    return;
  }

  if (isSyncQueueOnly()) {
    console.log('[sync-queue-only] legacy collectOnce skipped');
  }

  if (!isSyncWorkerEnabled()) {
    console.log(`[sync-worker] env enabled=0 hook=${hook} — queue runtime not started`);
    return;
  }

  let schema;
  try {
    schema = await ensureSyncSchemaReady();
  } catch (e) {
    console.error('[sync-worker] bootstrap failed', e?.message || e);
    return;
  }

  if (!schema.ok) {
    const detail = (schema.missing || []).join(',');
    console.log(`[sync-worker] bootstrap skipped reason=schema_invalid missing=${detail}`);
    return;
  }

  const concurrency = syncWorkerConcurrency();
  const queueOnly = isSyncQueueOnly() ? 1 : 0;
  console.log(`[sync-worker] env enabled=1 concurrency=${concurrency} queueOnly=${queueOnly} hook=${hook}`);

  try {
    const { startSyncQueueRuntime } = require('./syncQueueRuntime');
    startSyncQueueRuntime({ schemaReady: true });
  } catch (e) {
    console.error('[sync-worker] bootstrap failed', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
}

module.exports = { bootstrapSyncWorker };
