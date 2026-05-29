# Dashboard 缓存预热（Phase-1.1）

## 目的

服务启动后异步预热常用契约组合，使 **首次** 打开 `/legacy?orderFilter=paid` 也能命中 Phase-1 memory cache（`cache=hit`）。

不预热 `orders`（实时列表，不缓存）。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHBOARD_CACHE_WARMUP_ENABLED` | `1` / `true` / `yes` / `on` 启用 | **关闭** |
| `DASHBOARD_CACHE_WARMUP_TENANTS` | 逗号分隔租户 ID，如 `6` 或 `6,7` | 空 = 不预热 |
| `DASHBOARD_CACHE_WARMUP_DELAY_MS` | listen 后延迟毫秒 | `8000` |
| `DASHBOARD_CACHE_WARMUP_CONCURRENCY` | 并发预热任务数（1～4） | `2` |

**默认不自动预热**：未同时配置 `ENABLED=1` 与 `TENANTS` 时无任何动作。

## Staging 示例

```bash
export DASHBOARD_CACHE_WARMUP_ENABLED=1
export DASHBOARD_CACHE_WARMUP_TENANTS=6
export DASHBOARD_CACHE_WARMUP_DELAY_MS=8000
export DASHBOARD_CACHE_WARMUP_CONCURRENCY=2
# 重启 PM2 / node backend
```

## 预热矩阵（每租户 15 次 loader）

| orderFilter | endpoints |
|-------------|-----------|
| paid, all, valid | summary, ranking, product-ranking, gmv-compare, order-volume |

固定：`shopId=all`，`market=ALL`，`timeRange=today`，`groupBy=hour`（compare / order-volume）。

## 日志

重启后**无论是否启用**，都应先看到环境行（便于排查 PM2 未注入变量）：

```
[dashboard-cache-warmup] env enabled=1 parsed=1 tenants=6 delayMs=8000 concurrency=2
[dashboard-cache-warmup] scheduled delayMs=8000 tenants=6 ...
[dashboard-cache-warmup] start tenants=6 jobs=15 concurrency=2
[dashboard-cache-warmup] endpoint=summary tenant=6 orderFilter=paid durationMs=... success
[dashboard-cache-warmup] done jobs=15
```

未启用时：

```
[dashboard-cache-warmup] env enabled= parsed=0 tenants=(none) delayMs=8000 concurrency=2
[dashboard-cache-warmup] skipped reason=disabled
```

Hook 挂载于 `backend/server.js`：`app.listen` 回调 + `listening` 事件（单进程 PM2 worker）。

## 验收

1. 配置环境变量并重启 staging。
2. 等待 `delayMs + warmup` 完成（日志 `done`）。
3. **首次** 打开 `/legacy?orderFilter=paid`，PM2 日志应见 `cache=hit`（ranking / gmv-compare 等）。
4. `orders` 仍为 `cache=miss` 或无 cache 行（不预热）。
5. `/shops`、`/dashboard` 功能无回归。
