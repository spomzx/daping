# 环境变量说明

本文档描述与部署相关的关键环境变量。示例值见 `backend/.env.example`。

## 同步队列（Phase-4.2）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SYNC_WORKER_ENABLED` | `0` | `1` 时主进程启动 sync scheduler + worker |
| `SYNC_USE_QUEUE_ONLY` | `0` | `1` 禁用 legacy `collectOnce`，仅队列写库 |
| `SYNC_WORKER_CONCURRENCY` | **`1`** | 并行 worker 数；**prod 必须为 1** |
| `SYNC_JOB_RETRY_ENABLED` | `1` | 失败 job 是否进入 retry_wait |
| `SYNC_LOCK_TIMEOUT_MS` | `600000` | 店铺锁超时（毫秒） |
| `SYNC_SCHEDULER_INTERVAL_MS` | `30000` | 入队扫描间隔（毫秒） |

### `SYNC_WORKER_CONCURRENCY` 约束

- **默认与 prod：`1`**
- **仅 staging 压测** 可临时设为 `3`；压测结束必须改回 `1` 并重启 PM2
- **prod 禁止 `3`**（及任何 >1 的常驻值）：与 dashboard 共用 MySQL，并发 3 会导致 gmv-compare / summary / orders 明显变慢

Prod 上线必须设置：

```env
SYNC_WORKER_ENABLED=1
SYNC_USE_QUEUE_ONLY=1
SYNC_WORKER_CONCURRENCY=1
SYNC_JOB_RETRY_ENABLED=1
SYNC_LOCK_TIMEOUT_MS=600000
SYNC_SCHEDULER_INTERVAL_MS=30000
```

详见：`docs/sync-phase42-pressure-test.md`。

## 数据库

见 `backend/.env.example` 中 `DB_*`、`JWT_*`、`PORT` 等。
