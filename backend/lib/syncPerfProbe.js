'use strict';

/**
 * Sync 链路性能探测（只读日志，不改变同步结果）。
 * 启用：SYNC_PERF_PROBE=1
 */

function enabled() {
  const s = String(process.env.SYNC_PERF_PROBE ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * @param {Record<string, unknown>} meta
 */
function logSyncPerfProbe(meta) {
  if (!enabled()) return;
  console.log(
    '[sync-perf-probe]',
    JSON.stringify({
      ts: new Date().toISOString(),
      ...meta,
    }),
  );
}

module.exports = { logSyncPerfProbe };
