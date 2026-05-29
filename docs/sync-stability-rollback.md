# Phase-4.1 / 4.2 同步稳定化 — 回滚

## Queue-only 快速回滚（推荐，staging / prod）

切回 legacy OpenAPI `collectOnce`，停止队列 worker 与 scheduler。

### 1. 修改 `.env`

```env
SYNC_USE_QUEUE_ONLY=0
SYNC_WORKER_ENABLED=0
```

（可选：保留 `SYNC_WORKER_CONCURRENCY=1` 或删除该行，worker 已关闭则不生效。）

### 2. 重启 API 进程

```bash
# staging
cd /home/admin/daping-staging
pm2 restart daping-staging --update-env

# prod（名称以实际为准）
pm2 restart daping-prod --update-env
```

### 3. 恢复 legacy OpenAPI 同步

- 确认 **`SYNC_USE_QUEUE_ONLY=0`**（否则 scheduler 仍会 skip `collectOnce`）
- 启动或确认 PM2 中 **openapi-sync** 进程在跑，例如：
  - `pm2 start ecosystem.config.js --only tiktok-openapi-sync`
  - 或 `cd backend && npm run openapi:sync`（由 PM2 托管）

验证日志应出现 legacy 同步路径，且 **不再** 持续打印 `[sync-queue] scheduled` / `[sync-worker] env enabled=1`。

### 4. 停止独立队列进程（若曾单独起过）

```bash
pm2 stop sync-queue-staging
# 或：pm2 delete sync-queue-staging
```

## 停止新队列 Worker（不恢复 legacy 时）

```bash
pm2 stop sync-queue-worker
# 或 .env：SYNC_WORKER_ENABLED=0 后 pm2 restart … --update-env
```

仅停 worker、仍 `SYNC_USE_QUEUE_ONLY=1` 时：**不会有任何同步写库**，需尽快恢复其一。

## 环境变量对照

| 目标 | `SYNC_USE_QUEUE_ONLY` | `SYNC_WORKER_ENABLED` | legacy openapi-sync |
|------|------------------------|------------------------|---------------------|
| 队列模式（Phase-4.2） | `1` | `1` | 可不跑 / exit(0) |
| 回滚到 legacy | `0` | `0` | **必须跑** |
| 双跑（禁止） | `1` | `1` + openapi-sync 同时写 | 会重复拉单 |

## 数据库（可选，staging 慎用）

新表可保留，不影响 legacy 同步。若需完全回滚 schema：

1. 停止所有 worker 与 API 内 sync bootstrap
2. `DROP TABLE sync_logs;`
3. `DROP TABLE shop_sync_status;`
4. `DROP TABLE sync_jobs;`
5. 若存在归档：`RENAME TABLE sync_jobs_legacy_v0 TO sync_jobs;`（及 `sync_logs_legacy_v0`、`sync_shop_logs_legacy_v0` 等）

生产环境 **不建议** DROP；仅用 env 回滚即可。

## 前端

移除导航项 `syncJobs` 或隐藏 `/admin/sync-jobs` 路由即可；店铺列表 sync 列可忽略（无 worker 时状态不再更新）。

## 风险

- legacy `collectOnce` 与队列 worker **双写** 同一店铺 → 重复拉单、锁冲突、dashboard 变慢
- 回滚后若仍 `SYNC_WORKER_CONCURRENCY=3` 且误开 worker，仍会抢 MySQL；回滚场景建议 worker 关闭

## 相关文档

- 验收与 prod 并发限制：`docs/sync-phase42-pressure-test.md`
- 环境变量说明：`docs/env.md`、`backend/.env.example`
