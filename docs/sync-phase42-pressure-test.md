# Phase-4.2 Staging 压测与 Legacy 切流

> **锁版本**：`staging-sync-stability-phase2-validated-v1`（Phase-4.2 staging 验收通过）

## Staging 验收结论（已锁定）

**结论：Phase-4.2 staging 通过。**

| # | 检查项 | 结果 |
|---|--------|------|
| 1 | `npm run sync:audit` → schema verify | **PASS** |
| 2 | duplicate_active_check | **PASS** |
| 3 | duplicate active job（同店 queued/running/retry_wait） | **无** |
| 4 | stale `sync_lock_until` | **无** |
| 5 | running jobs older than 15min | **无** |
| 6 | `pm2 logs … \| grep Unknown column / doesn't exist / schema_invalid / crash` | **无输出** |
| 7 | `SYNC_WORKER_CONCURRENCY=1` 后 dashboard（gmv-compare / summary / orders） | **明显恢复** |
| 8 | 当前失败为 TikTok `Invalid app_key` | **授权数据问题**，非队列/表结构问题 |

验收命令（staging）：

```bash
cd /home/admin/daping-staging/backend
node db/init.js
npm run sync:audit

cd /home/admin/daping-staging
pm2 logs daping-staging --lines 120 | grep -E "sync-worker|sync-queue|Unknown column|doesn't exist|schema_invalid|crash"
```

## Worker 并发限制（重要）

| 环境 | `SYNC_WORKER_CONCURRENCY` | 说明 |
|------|---------------------------|------|
| **prod** | **必须为 `1`** | 禁止 `3`；与 dashboard 共用 MySQL，并发 3 会导致 gmv-compare / summary / orders 明显变慢 |
| **staging（日常）** | **`1`（推荐）** | 与 prod 一致，便于观察真实负载 |
| **staging（压测）** | 可临时 `3` | 仅用于队列压测窗口；压测结束必须改回 `1` 并 `pm2 restart --update-env` |

**禁止在 prod 使用 `SYNC_WORKER_CONCURRENCY=3`。**

原因：3 个 worker 与 dashboard 查询争抢 MySQL 连接与 InnoDB 行锁，压测期间已复现大屏接口变慢；降为 1 后 dashboard 明显恢复。

## 环境变量

### Staging（验收通过配置）

```env
SYNC_WORKER_ENABLED=1
SYNC_USE_QUEUE_ONLY=1
SYNC_WORKER_CONCURRENCY=1
SYNC_JOB_RETRY_ENABLED=1
SYNC_LOCK_TIMEOUT_MS=600000
SYNC_SCHEDULER_INTERVAL_MS=30000
```

> 压测阶段曾使用 `SYNC_WORKER_CONCURRENCY=3`；**锁版本以 `1` 为准**。

### Prod 上线（必须全部设置）

```env
SYNC_WORKER_ENABLED=1
SYNC_USE_QUEUE_ONLY=1
SYNC_WORKER_CONCURRENCY=1
SYNC_JOB_RETRY_ENABLED=1
SYNC_LOCK_TIMEOUT_MS=600000
SYNC_SCHEDULER_INTERVAL_MS=30000
```

| 变量 | 作用 |
|------|------|
| `SYNC_WORKER_ENABLED=1` | 主进程 bootstrap 启动 scheduler + worker 池 |
| `SYNC_USE_QUEUE_ONLY=1` | 禁用 legacy `collectOnce`；仅队列 worker 写 MySQL |
| `SYNC_WORKER_CONCURRENCY=1` | 单 worker，避免与 dashboard 抢库 |
| `SYNC_JOB_RETRY_ENABLED=1` | 失败 job 进入 `retry_wait` |
| `SYNC_LOCK_TIMEOUT_MS=600000` | 店铺锁 10 分钟超时 |
| `SYNC_SCHEDULER_INTERVAL_MS=30000` | 每 30s 扫描入队 |

| 变量 | prod 禁止值 |
|------|-------------|
| `SYNC_WORKER_CONCURRENCY` | **`3`**（及任何 >1 的常驻值） |

## PM2 建议（staging / prod）

1. **API**：`daping-staging` / `daping-prod`（主进程内嵌 sync worker，需 `SYNC_WORKER_ENABLED=1`）
2. **可选独立进程**：`npm run sync:queue`（与主进程二选一，避免双跑）
3. **legacy openapi-sync**：`SYNC_USE_QUEUE_ONLY=1` 时 `collectOnce` 跳过；勿与队列双写

```bash
pm2 logs daping-staging --lines 500 | grep -E 'sync-worker|sync-lock|sync-job|sync-queue|sqlTag'
```

## 压测步骤（历史记录）

1. `node db/init.js`（含 migrate41 + schema verify）
2. 确认 ≥20 家 `sync_enabled=1` 活跃店铺
3. `SYNC_WORKER_ENABLED=1`，队列运行 **30–60 分钟**
4. 每 10 分钟：`npm run sync:audit`
5. 截图：`/admin/sync-jobs`、`/shops`、审计输出、PM2 日志

## 必观察指标

| # | 指标 | 通过标准 |
|---|------|----------|
| 1 | queued 堆积 | 运行中 queued 不无限增长 |
| 2 | running 卡住 | 无 >15min 的 running |
| 3 | sync_lock_until 残留 | audit「stale lock」为空 |
| 4 | retry_wait | 到期后变 running/success/failed |
| 5 | token_expired | 仅真实 401/token 错误 |
| 6 | 重复 active job | duplicate active 查询 **必须为空** |
| 7 | schema / SQL | 无 `Unknown column`、`schema_invalid`、worker crash |

## 手工 SQL

见 `backend/db/migrations/sync-stability-phase1.sql`；推荐 `npm run sync:audit`。

## Prod 上线前置条件（全部满足）

- [ ] 使用 tag **`staging-sync-stability-phase2-validated-v1`** 或之后含 migrate41 + shop_id 修复的 commit
- [ ] `node db/init.js` 成功，`sync:audit` → schema verify **PASS**
- [ ] staging 验收结论 8 条与上表一致（尤其 concurrency=1 时 dashboard 正常）
- [ ] prod `.env` 六项变量与上文 **Prod 上线** 块一致，**`SYNC_WORKER_CONCURRENCY=1`**
- [ ] 确认无 openapi-sync / collectOnce 与队列 **双跑**
- [ ] 上线后 10 分钟内执行 `sync:audit` 与 PM2 grep（无 schema/SQL 错误）

## 回滚

见 `docs/sync-stability-rollback.md`（queue-only 快速回滚）。

```env
SYNC_USE_QUEUE_ONLY=0
SYNC_WORKER_ENABLED=0
```

```bash
pm2 restart daping-staging --update-env
# prod: pm2 restart daping-prod --update-env
```

恢复 legacy OpenAPI 同步：重新启用 `tiktok-openapi-sync` / `npm run openapi:sync` 进程（`SYNC_USE_QUEUE_ONLY=0` 后 `collectOnce` 恢复）。
