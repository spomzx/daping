# Tenant 隔离审计（Phase-4.1 同步）

## 原则

所有 `sync_jobs` / `sync_logs` / `shop_sync_status` 的 **SELECT / UPDATE / DELETE** 必须带：

- `tenant_id`
- `shop_id`（内部 `shops.id`）

禁止仅按 `shop_id` 更新（跨租户碰撞风险）。

## 已审计文件

| 模块 | 文件 | 结论 |
|------|------|------|
| 入队 | `backend/sync/services/syncJobRepository.js` | `enqueue` / `hasActive` / `claim` / `updateJob` / `listJobs` 均含 `tenant_id` |
| 状态 | `backend/sync/services/shopSyncStatusService.js` | `patch` WHERE `shop_id + platform + tenant_id` |
| 锁 | `backend/sync/locks/shopSyncLock.js` | `FOR UPDATE` 带 `tenant_id` |
| Worker | `backend/sync/workers/shopSyncWorker.js` | job 携带 `tenant_id`；`loadShopsForOpenApiCollect({ tenantId })` |
| Scheduler | `backend/sync/queue/syncScheduler.js` | 按店 `tenant_id` 入队 |
| API | `backend/modules/syncJobs/service.js` | `enforceAuthTenantScope` + `listJobsForTenant` |
| 店铺列表 | `backend/modules/shops/service.js` | `enrichShopsWithSyncStatus` 按 `tenant_id` 分组查询 |

## 既有同步（未改 SQL 口径）

- `shopSyncRunner.js` → 仍走 `sync_shop_logs` + `orders` 持久化（原逻辑）
- OpenAPI worker `collectOnce` 未改；队列 worker 为 **并行新进程** `npm run sync:queue`

## 验收

1. 租户 A 登录 `/api/sync-jobs` 不得出现租户 B 的 `job.tenant_id`
2. 平台管理员切换 `?tenant_id=` 后仅见该租户任务
