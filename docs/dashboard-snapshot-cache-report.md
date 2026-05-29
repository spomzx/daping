# Dashboard JSON Snapshot Cache 实施报告

## 1. 新增 / 修改文件清单

| 文件 | 说明 |
|------|------|
| `backend/lib/dashboardSnapshotCache.js` | **新增** JSON snapshot 读写、路径构建、TTL、清理 |
| `backend/lib/dashboardCache.js` | 接入 memory → table → snapshot → MySQL 优先级 |
| `backend/lib/dashboardRefreshScheduler.js` | 每轮 cycle 顺带 snapshot cleanup |
| `backend/lib/dashboardPerfProbe.js` | 日志增加 `refreshPending` |
| `backend/server.js` | 启动时注册 snapshot 清理调度 |
| `frontend/src/lib/dashboardTrendCache.ts` | 3–5s 补拉、`refreshPending` 保留上一帧 |
| `frontend/src/GmvCompareTrendPanel.tsx` | 已有 displayChart + 更新中（前序补丁） |
| `frontend/src/components/OrderVolumeChart.tsx` | 同上 |
| `frontend/src/i18n/zh.json` / `en.json` / `th.json` | `chart.trendUpdating` |
| `docs/dashboard-snapshot-cache-report.md` | 本报告 |

存储目录（运行时生成，已在 `.gitignore` 的 `backend/storage/` 下）：

```
backend/storage/dashboard-snapshot/
  tenant-{tenantId}/
    summary/
    shop-ranking/
    product-ranking/
    gmv-compare/
    order-volume/
```

## 2. 接入 endpoint 清单

| endpoint | snapshot 目录 | 纳入 |
|----------|---------------|------|
| `summary` | `summary/` | ✅ |
| `ranking` | `shop-ranking/` | ✅ |
| `product-ranking` | `product-ranking/` | ✅ |
| `gmv-compare` | `gmv-compare/` | ✅ |
| `order-volume` | `order-volume/` | ✅ |
| `orders`（实时订单） | — | ❌ 禁止 |
| `trend`（内部别名） | 同 gmv/order-volume 策略 | 随 endpoint 名 |

## 3. 读取优先级

```
memory cache
  → dashboard table cache（MySQL 汇总表）
  → JSON snapshot（本地文件）
  → MySQL loader（唯一事实源）
```

趋势端点（`gmv-compare` / `order-volume`）细化：

1. memory  
2. table 未过期  
3. **snapshot 未过期**  
4. table-stale / 维度 table-stale  
5. **snapshot-stale**（有数据则返回 + `refreshPending`）  
6. 仍无数据 → `pending` + 后台刷新（禁止空图占位当唯一响应）  
7. 后台/MySQL 完成后写入 memory + table + snapshot  

非趋势端点：memory → table → snapshot（fresh/stale）→ MySQL；snapshot-stale 时后台刷新。

## 4. TTL 规则

由 `snapshotTtlMs(contract)` 控制，可用环境变量覆盖：

| timeRange | 默认 TTL | 环境变量 |
|-----------|----------|----------|
| today | 90s | `DASHBOARD_SNAPSHOT_TTL_TODAY_MS` |
| yesterday | 5min | `DASHBOARD_SNAPSHOT_TTL_YESTERDAY_MS` |
| last7 | 10min | `DASHBOARD_SNAPSHOT_TTL_LAST7_MS` |
| last30 | 30min | `DASHBOARD_SNAPSHOT_TTL_LAST30_MS` |
| custom | 5–30min（按天数动态） | — |

文件名含 `filterHash`（cacheKey SHA256 前 6 位），示例：

`tenant-6/gmv-compare/gmv-compare_last7_paid_ALL_all_7b1c5c.json`

## 5. cleanup 规则

- 保留最长 **30 天**（`DASHBOARD_SNAPSHOT_RETENTION_DAYS`，默认 30）
- **进程启动**时执行一次 `cleanupDashboardSnapshotCache()`
- **每 24h** 再执行一次（`startDashboardSnapshotCleanupScheduler`）
- refresh scheduler 每 **120s cycle** 结束时也可触发清理（与 table purge 同轮）
- 删除依据：文件 `mtime` 或 JSON 内 `generatedAt` 早于 cutoff
- 解析失败 / 坏文件：读取时删除并记 `cacheSource=snapshot-invalid`
- 清理失败仅 `console.warn`，不影响接口

## 6. 环境变量（staging 建议）

```bash
DASHBOARD_SNAPSHOT_CACHE_ENABLED=1
DASHBOARD_SNAPSHOT_CLEANUP_ENABLED=1
DASHBOARD_SNAPSHOT_RETENTION_DAYS=30

# 可选 TTL 微调
DASHBOARD_SNAPSHOT_TTL_TODAY_MS=90000
DASHBOARD_SNAPSHOT_TTL_YESTERDAY_MS=300000
DASHBOARD_SNAPSHOT_TTL_LAST7_MS=600000
DASHBOARD_SNAPSHOT_TTL_LAST30_MS=1800000
```

**默认策略（2025-05 修复）**：未设置 `DASHBOARD_SNAPSHOT_CACHE_ENABLED` 时，与 `DASHBOARD_TABLE_CACHE_ENABLED`（默认 `1`）对齐开启；`APP_ENV=prod` 时默认关闭。显式 `DASHBOARD_SNAPSHOT_CACHE_ENABLED=0` 可关闭。**不要修改 prod `.env`**。

可与现有配置叠加：

```bash
DASHBOARD_TABLE_CACHE_ENABLED=1
DASHBOARD_PERF_PROBE=1
```

## 7. 日志 cacheSource

`[dashboard-contract]` / perf-probe 支持：

- `memory`
- `table` / `table-stale`
- `snapshot` / `snapshot-stale` / `snapshot-miss` / `snapshot-invalid`
- `pending`（仅趋势且无 snapshot/table 旧数据）
- `db` / `db-empty`（`reason=no_trend_data`）

并输出：`endpoint`、`tenant`、`market`、`orderFilter`、`timeRange`、`shopId`、`rows`、`durationMs`、`ttlMs`、`refreshPending`。

## 8. 验收命令（staging）

```bash
# 启用后重启
DASHBOARD_SNAPSHOT_CACHE_ENABLED=1
DASHBOARD_TABLE_CACHE_ENABLED=1
DASHBOARD_PERF_PROBE=1
pm2 restart daping-staging

# 观察 snapshot 命中
pm2 logs daping-staging --lines 200 | grep -E "cacheSource=(snapshot|snapshot-stale|memory|table)"

# 确认文件生成
ls -la backend/storage/dashboard-snapshot/tenant-*/gmv-compare/
ls -la backend/storage/dashboard-snapshot/tenant-*/order-volume/

# 删除某 tenant 的 snapshot 后应回退 MySQL 并重新生成文件
rm -f backend/storage/dashboard-snapshot/tenant-6/gmv-compare/*.json

# 前端构建
cd frontend && npm run build
```

### 验收项对照

1. `npm run build` 通过  
2. `pm2 restart daping-staging` 正常  
3. today / yesterday / last7 / last30 切换不长时间空白  
4. 近 7 天订单量图不空白  
5. paid / all / valid 快速切换不旧图覆盖（abort + `shouldApplyDashboardQuery`）  
6. 日志可见 `cacheSource=snapshot` 或 `snapshot-stale`  
7. `backend/storage/dashboard-snapshot/` 有 JSON  
8. 删 snapshot 后接口仍可用（MySQL fallback）  
9. 超 30 天文件被 cleanup 删除  
10. summary/ranking 口径不变（同一 loader + filterContract）  
11. MySQL-only 主数据源原则不变  

## 9. 风险说明

| 风险 | 缓解 |
|------|------|
| JSON 被误当作事实源 | 仅作缓存层；写出来源 `source: mysql`；读路径最终仍可由 MySQL 重建 |
| 旧 orders-cache / gmv-cache 业务链路 | **未恢复**；路径与格式与旧文件完全不同 |
| 磁盘占满 | 30 天 retention + 周期 cleanup；tenant 级目录隔离 |
| 坏 JSON | 读取时删除并记 `snapshot-invalid` |
| 路径注入 | `buildDashboardSnapshotPath` 规范化 segment + `path.resolve` 校验 |
| prod 误开 | 默认 off；禁止改 prod `.env` |
| 实时 orders 一致性 | orders **不**读 snapshot |

## 10. 前端行为摘要

- `pending` / `refreshPending`：**保留上一帧** + 角标「更新中…」  
- **3–5 秒**后自动补拉当前 query  
- 仅 `db-empty` + `reason=no_trend_data` 才清空并显示空图  
- 快速筛选变更 abort 旧请求，防止旧响应覆盖新筛选  

---

*JSON snapshot 是 Dashboard 重计算结果的本地加速层，不是订单或 GMV 的主数据源。MySQL `orders` 表仍是唯一事实来源。*
