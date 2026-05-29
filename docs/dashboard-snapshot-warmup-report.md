# Dashboard Snapshot Warmup 实施报告

## 1. 新增文件清单

| 文件 | 说明 |
|------|------|
| `backend/lib/dashboardSnapshotWarmScheduler.js` | **新增** 预热调度：启动 3s 后首轮 + 每 60s 滚动批次 |
| `backend/lib/dashboardSnapshotCache.js` | 存储可写自检、`snapshotWarmSkipReason` |
| `backend/server.js` | 挂载 `startDashboardSnapshotWarmScheduler()` |
| `docs/dashboard-snapshot-warmup-report.md` | 本报告 |

## 2. Warmup 策略

| 项 | 策略 |
|----|------|
| 触发 | 服务 `listening` 后 **3s** 执行首轮；之后每 **60s** 一轮（可配置） |
| 范围 | 每租户每轮最多 **90** 个任务（滚动 cursor，约 4 轮覆盖 360 组合） |
| 并发 | 默认 **2**，任务间隔 **80ms** |
| 跳过 | snapshot **未过期**（fresh / fresh-stale 余量 >20% TTL） |
| 跳过 | 同 `cacheKey` **inflight** 刷新中 |
| 跳过 | 主链路 **busy**（`isDashboardRequestBusy`）时整轮 defer |
| 加载 | `cacheBypass=1` + `refreshSource=warmup` 走现有 loader（MySQL 事实源） |
| 写入 | 仅 `writeDashboardSnapshotCache`（atomic tmp→rename） |

读取优先级**不变**：memory → table → snapshot → snapshot-stale → MySQL / pending。

## 3. 预热组合范围

**Endpoints（5）**：`summary`、`ranking`、`product-ranking`、`gmv-compare`、`order-volume`

**timeRange（4）**：`today`、`yesterday`、`last7`、`last30`

**orderFilter（3）**：`paid`、`all`、`valid`

**market（6）**：`ALL`、`TH`、`MY`、`PH`、`VN`、`SG`

**shopId**：仅 `all`

**groupBy**（趋势类）：`today`/`yesterday` → `hour`；`last7`/`last30` → `day`

**组合数**：5 × 4 × 3 × 6 × 1 = **360** / 租户

## 4. 并发 / 限流

| 环境变量 | 默认 | 含义 |
|----------|------|------|
| `DASHBOARD_SNAPSHOT_WARMUP_ENABLED` | 非 prod 且 snapshot 开启时 **on** | 总开关 |
| `DASHBOARD_SNAPSHOT_WARMUP_INTERVAL_MS` | `60000` | 轮询间隔 |
| `DASHBOARD_SNAPSHOT_WARMUP_CONCURRENCY` | `2` | 并行 worker 数（上限 4） |
| `DASHBOARD_SNAPSHOT_WARMUP_MAX_PER_ROUND` | `90` | 每轮每租户最大任务数 |
| `DASHBOARD_SNAPSHOT_WARMUP_TENANTS` | 同 `DASHBOARD_REFRESH_SCHEDULER_TENANTS` | 如 `6` |

## 5. 日志样例

```
[dashboard-snapshot] boot enabled=1 root=.../dashboard-snapshot writable=true
[dashboard-snapshot-warmup] scheduler-started tenants=6 jobsPerTenant=360 intervalMs=60000 concurrency=2 maxPerRound=90
[dashboard-snapshot-warmup] start tenant=6 batch=90 total=360 cursor=0
[dashboard-snapshot-warmup] skip fresh endpoint=gmv-compare timeRange=yesterday orderFilter=paid market=ALL tenant=6
[dashboard-snapshot-warmup] write endpoint=gmv-compare timeRange=last7 orderFilter=all market=TH tenant=6 rows=7 durationMs=842
[dashboard-snapshot-warmup] finish tenant=6 written=42 skipped=48 failed=0 durationMs=12500
[dashboard-contract] cacheSource=snapshot endpoint=gmv-compare timeRange=last7 ...
```

存储不可写时：

```
[dashboard-snapshot] storage not writable root=... error=EACCES ...
[dashboard-snapshot] boot enabled=0 root=... writable=false
```

## 6. 验收命令（staging）

```bash
# 建议 .env（勿改 prod）
DASHBOARD_SNAPSHOT_CACHE_ENABLED=1
DASHBOARD_SNAPSHOT_WARMUP_ENABLED=1
DASHBOARD_SNAPSHOT_WARMUP_TENANTS=6
DASHBOARD_TABLE_CACHE_ENABLED=1

cd /home/admin/daping-staging/frontend && npm run build
pm2 restart daping-staging

pm2 logs daping-staging --lines 300 | grep -E "dashboard-snapshot|snapshot-warmup|cacheSource=snapshot"

find /home/admin/daping-staging/backend/storage/dashboard-snapshot -type f | head -50
```

### 验收标准对照

1. build 通过  
2. pm2 restart 正常  
3. `boot enabled=1 writable=true`  
4. `snapshot-warmup start` / `write` / `finish`  
5. 目录含 summary / shop-ranking / product-ranking / gmv-compare / order-volume  
6. 切换 today↔last7、paid↔all↔valid、ALL↔TH 第二次应 `cacheSource=snapshot` 或 `snapshot-stale`  
7. last7/last30 组合经 1–2 轮 warmup 后不应长期 `snapshot-miss`  

## 7. 风险说明

| 风险 | 缓解 |
|------|------|
| MySQL 压力 | 并发 2、每轮 90、80ms 间隔、busy 时 defer |
| 磁盘权限 | 启动 writable 自检，不可写则 snapshot 全关 |
| JSON 非事实源 | 仅加速读；loader 仍来自 MySQL |
| prod 误开 | `APP_ENV=prod` 默认关闭 warmup |

## 8. 后续：是否预热单店 shopId

**建议暂不预热单店**。若预热 `shopId≠all`，组合数 × 店铺数易爆炸（数百店 → 十万级任务）。可选方案：

- 仅对「最近活跃 Top N 店铺」按需 warmup  
- 或用户选中单店后单次后台写入 snapshot  

当前阶段 **shopId=all + 6 markets × 3 filters × 4 ranges** 已覆盖大屏主路径。

---

*Warmup 只写本地 JSON snapshot，不替代 MySQL，不恢复旧 orders-cache / gmv-cache 主链路。*
