# Dashboard 性能检测专项报告

**类型**：只读检测 / 探测工具（非业务修复）  
**分支/代码基线**：`feature/tenant-safety-lock`（含 analytics_status 筛选与 perf-probe）  
**检测环境**：staging（现象描述）+ 仓库静态分析  
**日期**：2026-05-23  
**禁止项**：未改 prod / nginx / PM2 deploy；未恢复旧链路

---

## 执行摘要

| 维度 | 结论 |
|------|------|
| **主因判定** | **A. SQL / 订单状态结构化问题为主**（staging 若仍见 `usedStatusField=o.order_status+o.raw_json` 则为**未部署**仓库最新 `mysqlDashboardOrdersFilterClause`） |
| 次要因素 | **B. 轮询 + cache 策略**（today 下 summary/ranking 10s 轮询 + orders-changed 5s 强制 bypass 叠加 miss） |
| sync worker | **C 为次要**：独立 PM2 进程，共用 MySQL，可能抢 IO/连接，需 A/B |
| 前端重复 | **D 为次要**：筛选切换会 abort 重拉 6 路，无 `Promise.all` 阻塞首屏，但并发峰值高 |

**最优先应修的 3 点（建议顺序，非本次实施）：**

1. **staging 部署 `mysqlDashboardOrdersFilterClause`**（`analytics_status` 主筛 + `DASHBOARD_FILTER_LEGACY_ORDER_STATUS_FALLBACK=0` + 确认 `analytics_status` 无 NULL）  
2. **降低 paid/valid 路径 cache miss 风暴**（orders-changed 已限 primary 5s / secondary 30s；避免 `forceRefresh` 常规轮询）  
3. **product-ranking / gmv-compare 与首屏解耦**（已延迟 3s/5s；staging 需确认前端 dist 已更新）

---

## 一、前端轮询与请求触发（静态分析）

### 1.1 当前轮询频率表（`timeRange=today`）

| 模块 | 端点 | 频率 | 实现位置 |
|------|------|------|----------|
| **orders** | `/api/dashboard/orders` | **10s** | `ordersPollScheduler.ts` `ORDERS_POLL_INTERVAL_MS` |
| **summary** | `/api/dashboard/summary` | **10s** | `LegacyDashboardPage.tsx` `setInterval(loadContractSummary, 10_000)` |
| **ranking** | `/api/dashboard/ranking` | **10s** | 独立 `useEffect` `setInterval(loadShopRankingPanel, 10_000)` |
| **product-ranking** | `/api/dashboard/product-ranking` | **无定时轮询** | 首屏 **+3s** 延迟一次；筛选变更重拉 |
| **gmv-compare** | `/api/dashboard/gmv-compare` | **无定时轮询** | `fetchEnabled` 在 **+5s** 后；`liveRefreshNonce` 最多 30s/次 |
| **order-volume** | `/api/dashboard/order-volume` | **无定时轮询** | 同上 |
| 时钟 UI | — | 1s | `setInterval(updateNow, 1000)`（无 API） |
| 汇率 | `/api/exchange-rate` | 10min | `setInterval(fetchRate, 600_000)` |

`timeRange≠today`：summary 轮询 **5min**；ranking **无** interval。

### 1.2 触发来源矩阵

| 触发 | summary | ranking | orders | product-ranking | gmv-compare | order-volume |
|------|---------|---------|--------|-----------------|-------------|--------------|
| 页面加载 / 筛选变更 | 立即 | 立即 | 立即（scheduler filter） | +3s | +5s（charts ready） | +5s |
| orders 列表变化 | force 5s 节流 | force 5s 节流 | 自身 10s poll | 30s 节流 | 30s nonce | 30s nonce |
| 10s 定时器 | ✓ | ✓ | ✓（poll） | — | — | — |
| `forceRefresh` / `cacheBypass` | 仅 `{ force: true }` | 仅 force | 否 | 否（图表已去掉 force bypass） | 否 | 否 |

### 1.3 重复请求 / 并发

- **orders**：`ordersPollScheduler` 单例去重（10s + in-flight dedupe）；**唯一** HTTP 入口。  
- **summary / ranking**：各自 `runDashboardFetchOnce` + `dashboardQueryGuard` inflight 去重；**非**同一 effect，筛选变更时**并行**发起（非 `Promise.all`，不互相 await）。  
- **筛选切换**：`statsQueryKey` / `shopRankingQueryKey` 变化 → 两个 effect 同时重跑 + orders `filter` 立即拉取 → **峰值 3+ 请求**。  
- **首屏**：summary + ranking + orders **并行**；product-ranking 3s 后；图表 5s 后 → **无 Promise.all 阻塞首屏**，但 MySQL 并发连接峰值约 **3–6**。

### 1.4 orders-changed 联动（`ordersPollScheduler.ts`）

- `DASHBOARD_PRIMARY_METRICS_REFRESH_MIN_MS = 5_000` → summary + ranking + `cacheBypass`  
- `DASHBOARD_SECONDARY_METRICS_REFRESH_MIN_MS = 30_000` → product-ranking + 图表 nonce  
- **不再**每次 orders 变化刷新全部 6 端点（已拆分）

---

## 二、后端 API 耗时探测（perf-probe）

### 2.1 启用方式（staging only）

```bash
# ecosystem / .env
DASHBOARD_PERF_PROBE=1

pm2 restart daping-staging
```

日志格式（`backend/lib/dashboardPerfProbe.js` + `dashboardCache.js` + `ordersQuery.js`）：

```text
[perf-probe] endpoint=summary filterHash=dashboard:summary:... cache=miss durationMs=... sqlMs=... rows=... tenantId=6 shopId=all market=ALL orderFilter=paid timeRange=today
```

### 2.2 如何从 pm2 聚合 P95（staging 操作）

```bash
pm2 logs daping-staging --lines 5000 | grep '\[perf-probe\]' > /tmp/perf-probe.log

# 按 endpoint + orderFilter 粗算（示例 awk，需在服务器执行）
awk -F'[= ]' '/perf-probe/ { ... }' /tmp/perf-probe.log
```

**说明**：本报告撰写时**未连接 staging MySQL/PM2**，下表为**现象 + 代码推断**，部署 probe 后请用 30min 日志替换为实测 P95。

### 2.3 推断耗时（来自用户现象 + 架构）

| endpoint | orderFilter=all (推断) | orderFilter=paid/valid (staging 旧代码) | orderFilter=paid/valid (仓库新代码预期) |
|----------|------------------------|----------------------------------------|--------------------------------------|
| summary | 几十 ms | 3–9s | <1.5s（idx_analytics + 无 raw_json） |
| ranking | 几十 ms | 3–9s | <1.5s |
| orders | 0.5–2s | 3–6s | <1.5s |
| product-ranking | — | 10–22s | 2–8s（仍最重） |
| gmv-compare | — | 12s+ | 3–8s |
| order-volume | — | 3–8s | 1–4s |

### 2.4 all vs paid vs valid 差异根因

| 路径 | WHERE 复杂度 | 索引可用性 |
|------|--------------|------------|
| **all** | 仅 tenant + 日期 + market/shop | `idx_orders_dash_tenant_*` / `idx_analytics` 友好 |
| **paid/valid（旧）** | `sqlSamplePredicate` → JSON_EXTRACT + LIKE raw_json + CASE | **几乎无法**用 `order_status`/`analytics_status` 索引 |
| **paid/valid（新）** | `analytics_status IN (...)` 或 `=` | **`idx_analytics`**、`idx_orders_dash_tenant_astatus_*` |

---

## 三、SQL EXPLAIN 检测

### 3.1 脚本（staging 执行）

```bash
cd /home/admin/daping-staging/backend
node scripts/dashboard-perf-explain.js --tenantId=6
```

覆盖 sqlTag：`summary_orders_distinct_id`、`ranking_shop_orders_distinct_id`、`realtime_orders_limit`、`trend_hour_dateformat_group`（及 orderFilter WHERE 片段）。

### 3.2 各 sqlTag 静态分析（预期 EXPLAIN 行为）

#### `summary_orders_distinct_id`

```sql
SELECT COUNT(DISTINCT o.id), ... SUM(total_amount)
FROM orders o WHERE tenant_id=? AND DATE(COALESCE(paid_at,...))=CURDATE() AND ...
GROUP BY currency, market WITH ROLLUP
```

| 场景 | 预期 |
|------|------|
| all + today | `idx_orders_dash_tenant_paid` 或 `idx_analytics` range；可能 **Using temporary**（ROLLUP） |
| paid + today（新） | `key=idx_analytics` 或 `idx_orders_dash_tenant_astatus_paid`，`rows` 显著低于全表 |
| paid（旧 raw_json） | `type=ALL` 或 index 后 **Using where** 对每行算 JSON → 扫描行数 ≈ 租户今日全量 |

#### `ranking_shop_orders_distinct_id`

- **两次查询**：orders 按 shop_id 聚合 + gmv 按 shop/currency 聚合。  
- paid 旧路径：两次均慢。  
- 新路径：可走 `tenant_id + analytics_status`。

#### `realtime_orders_limit`

- 子查询 `ORDER BY COALESCE(paid_at,...)` + `LIMIT 50`。  
- 理想：`idx_orders_dash_tenant_astatus_paid` + backward index scan。  
- 日期用 `DATE(COALESCE(...))` 可能 **无法**完整利用 `paid_at` 范围索引（函数包裹列）。

#### `product_ranking_items_join_group`

- `order_items` JOIN `orders` ON tenant+platform+platform_order_id。  
- 最重：GROUP BY 表达式 + LIMIT 500 + JS 合并。  
- 索引：`idx_order_items_tenant_platform_order` 帮助 join；仍可能 **Using temporary; Using filesort**。

#### `gmv_compare_total_pipeline`

- today/yesterday **两次**行级拉取 + 内存按小时聚合。  
- 等价于 2× 大扫描；paid 旧路径加倍灾难。

#### `trend_hour_dateformat_group`

- `DATE_FORMAT(COALESCE(paid_at,...), '%Y-%m-%d %H:00:00')` GROUP BY → 常 **无法用** paid_at 索引做 range，易全分区扫描 + temporary。

### 3.3 最慢 5 条 SQL（推断排序）

1. **product_ranking_items_join_group**（JOIN + GROUP BY 复杂表达式）— 16–22s 级  
2. **gmv_compare_total_pipeline**（双窗口全量拉行）— 12s+  
3. **ranking_shop_orders_distinct_id** ×2（paid 旧路径）— 7–9s  
4. **summary_orders_distinct_id** WITH ROLLUP（paid 旧路径）— 7–9s  
5. **trend_hour_dateformat_group** / **realtime_orders_limit**（日期函数 + 状态）— 3–9s  

### 3.4 慢的原因归纳

| 原因 | 影响 |
|------|------|
| raw_json / JSON_EXTRACT / LIKE | paid/valid/sample 旧 WHERE |
| `DATE(COALESCE(paid_at,...))` | 时间列索引失效 |
| `DATE_FORMAT(...)` 分组 | order-volume 慢 |
| WITH ROLLUP + 多币种 | summary CPU |
| 双查询 ranking / 双窗口 gmv-compare | 重复扫描 |
| 缺 `analytics_status` 回填 | 新路径退化为 NULL OR 分支 |

---

## 四、raw_json 检测

### 4.1 Dashboard 主链路（仓库当前 HEAD）

| 文件 | 用途 | 是否主 WHERE |
|------|------|--------------|
| `filterBuilder.js` | 文档：禁止 raw_json 进入默认 WHERE | **否** |
| `orderFilter.js` → `mysqlDashboardOrdersFilterClause` | `analytics_status` 主筛 | **否 raw_json** |
| `orderFilter.js` → `mysqlOrdersFilterClause` / `sqlSamplePredicate` | legacy 非 dashboard | **否**（dashboard 未引用） |
| `ordersQuery.js` | SELECT 带出 `raw_json`；`is_sample` UI 兜底 `orderIsSampleOrder` | **否**（仅响应映射，非 WHERE） |

### 4.2 Staging 现象 vs 仓库

若 pm2 仍打印：

```text
usedStatusField=o.order_status+o.raw_json
```

则 staging 运行的是**旧** `filterContract.js`（`buildOrderFilterWhere` → `mysqlOrdersFilterClause`），**必须部署**含 `mysqlDashboardOrdersFilterClause` 的版本。

### 4.3 是否必须移除

| 场景 | 结论 |
|------|------|
| Dashboard WHERE | **必须**不使用 raw_json（已在新代码实现） |
| 入库 `deriveAnalyticsStatusFromMysqlRow` | 保留（写 `analytics_status`） |
| orders 响应 `is_sample` 展示 | 可仅依赖 `analytics_status`（优化项，非本次） |

---

## 五、索引检测（schema 定义 + 建议 SHOW INDEX）

### 5.1 orders 已有（`schema.sql`）

| 索引名 | 列 |
|--------|-----|
| `idx_orders_tenant` | tenant_id |
| `idx_analytics` | tenant_id, analytics_status, created_at_platform, market, shop_id |
| `idx_orders_dash_tenant_paid` | tenant_id, paid_at, market, shop_id |
| `idx_orders_dash_tenant_created` | tenant_id, created_at_platform, market, shop_id |
| `idx_orders_dash_tenant_status` | tenant_id, order_status, created_at_platform |
| `idx_orders_dash_tenant_astatus_paid` | tenant_id, analytics_status, paid_at |
| `idx_orders_dash_tenant_astatus_created` | tenant_id, analytics_status, created_at_platform |
| `idx_orders_dash_tenant_shop_astatus_paid` | tenant_id, shop_id, analytics_status, paid_at |
| `idx_orders_dash_tenant_market_astatus_paid` | tenant_id, market, analytics_status, paid_at |
| `idx_orders_dash_tenant_shop_status_paid` | tenant_id, shop_id, order_status, paid_at |
| `idx_orders_dash_tenant_market_status_paid` | tenant_id, market, order_status, paid_at |

### 5.2 order_items 已有

| 索引名 | 列 |
|--------|-----|
| `idx_order_items_order` | order_id |
| `idx_order_items_tenant_platform_order` | tenant_id, platform, platform_order_id |
| `idx_order_items_tenant_order_id` | tenant_id, order_id |
| `idx_order_items_product` / `sku` | product_id, sku_id |

### 5.3 staging 必做验证

```sql
SHOW INDEX FROM orders;
SHOW INDEX FROM order_items;
SELECT orderFilter, COUNT(*) FROM (
  SELECT analytics_status FROM orders WHERE tenant_id=6 LIMIT 100000
) t;  -- 或: SELECT COUNT(*) FROM orders WHERE analytics_status IS NULL;
```

若 `migrateDashboardPerf43` / `migrateOrders25AnalyticsStatus` 未跑，索引与列可能缺失。

### 5.4 重复/无效索引风险

- `idx_orders_tenant` 为 `idx_analytics` 前缀子集 → 可保留（单列查询仍有用）。  
- `idx_orders_created` 与 dash 索引部分重叠 → 低优先级合并。  
- **关键**：paid/valid 应走 **`idx_analytics` 或 `idx_orders_dash_tenant_astatus_paid`**，而非仅 `order_status` 单列索引。

---

## 六、Cache 检测

### 6.1 today TTL（`dashboardCache.js`）

| endpoint | TTL |
|----------|-----|
| summary | 5s |
| ranking | 5s |
| product-ranking | 30s |
| gmv-compare | 30s |
| order-volume | 30s |
| orders | **无** mem cache（3s in-flight dedupe only） |

### 6.2 cache key 组成

`dashboard:{endpoint}:{tenant}:{shop}:{market}:{orderFilter}:{timeRange}:{start}:{end}[:extra]`

- **不含** `cacheBust` / `forceRefresh`（仅 bypass 时跳过读缓存）。  
- `extra`：ranking limit/sort、product limit、gmv groupBy 等 → 合理。

### 6.3 forceRefresh 来源

| 来源 | 影响 |
|------|------|
| `withTodayLiveQueryParams(..., { force: true })` | summary/ranking orders-changed |
| 常规 10s 轮询 | **不**带 force → 应 hit 5s TTL |
| 图表 | 已移除 `liveRefreshNonce` → force bypass |

### 6.4 cache miss 风暴是否存在？

**是（条件下）**：

1. 筛选切换 → 新 filterHash → 全端点 miss（预期）  
2. orders-changed 每 5s → summary/ranking **bypass**（预期，但叠加 SQL 慢则 3–9s）  
3. today TTL 5s + 10s 轮询 → 每 10s 至少 1 次 miss（预期）  
4. **paid/valid SQL 慢** → 每次 miss 拖垮 3–9s（主因）  
5. warmup 60s 仅 summary/ranking → 不预热 product/gmv

**同一 filterHash 30s 内 product-ranking/gmv 应 hit**：若仍 miss，检查是否带 `cacheBypass` 或进程多实例缓存不共享（PM2 cluster >1）。

---

## 七、Sync Worker 影响

| 项 | 结论 |
|----|------|
| 进程 | `daping-staging`（API）与 `tiktok-openapi-sync`（`ecosystem.config.js`）**分离** |
| MySQL | **共用**同一 `DB_*` 连接池配置（不同进程 = 不同 pool 实例） |
| tick | OpenAPI sync 脚本内周期 collect；`sync-worker` bootstrap 视 `SYNC_USE_QUEUE` 而定 |
| invalid app_key 重试 | 需 `pm2 logs tiktok-openapi-sync` 人工确认；会占连接与 CPU |
| 对 dashboard 影响 | 同步高峰可能拉高 buffer pool / disk IO → P95 变差 |
| A/B 建议 | `pm2 stop tiktok-openapi-sync` 10min，对比 `[perf-probe]` P95 |

---

## 八、验收清单（staging 操作员）

- [ ] 部署含 `mysqlDashboardOrdersFilterClause` 的后端  
- [ ] `node db/init.js` 或 migrate43 + migrate25  
- [ ] `DASHBOARD_PERF_PROBE=1` + 强刷大屏 10min 采集日志  
- [ ] `node scripts/dashboard-perf-explain.js --tenantId=6`  
- [ ] 确认日志 `usedStatusField=o.analytics_status`（非 `+raw_json`）  
- [ ] paid/valid 首次 miss P95 < 3s  

---

## 九、总结论

**主结论：A（SQL / 订单状态结构化）为主，B（轮询/cache）为放大器。**

- staging 日志 `usedStatusField=o.order_status+o.raw_json` 表明 **paid/valid 仍在扫 raw_json**（旧部署或未跑迁移）。  
- 仓库已改为 **`analytics_status` 索引友好路径**；部署后应出现 `usedStatusField=o.analytics_status`。  
- 轮询 10s + 5s bypass 在 SQL 快时可接受；SQL 慢时表现为 **3–9s + cache miss 风暴**。  
- sync worker 与前端重复请求为 **次要**，用于 A/B 验证。

---

## 附录：检测产物

| 产物 | 路径 |
|------|------|
| perf-probe 日志模块 | `backend/lib/dashboardPerfProbe.js` |
| 接入点 | `backend/lib/dashboardCache.js`、`backend/modules/dashboard/ordersQuery.js` |
| EXPLAIN 脚本 | `backend/scripts/dashboard-perf-explain.js` |
| 本报告 | `docs/dashboard-performance-probe-report.md` |

启用 probe **不改变 API 响应**，仅多打 `[perf-probe]` 日志行。
