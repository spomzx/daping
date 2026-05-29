# 数据源策略（阶段十锁定 + 今日 KPI 硬锁）

> **【LOCKED】KPI CONTRACT**（`KPI_CONTRACT_VERSION=kpi-valid-v1`）：见 [`docs/kpi-contract.md`](./kpi-contract.md)。  
> 有效订单唯一口径：`analytics_status='valid'`；UI「付款订单」= valid。  
> 修改 summary / ranking / todayMetrics / **trend** / **productRanking** / gmv-compare 前必读；验收后禁止改 prod，须新分支 + 新 tag。

## 【LOCKED】今日订单数与今日 GMV

| 规则 | 说明 |
|------|------|
| **唯一聚合模块** | `backend/modules/dashboard/todayMetricsQuery.js` |
| **订单数** | `COUNT(DISTINCT o.id)`（`dashboardOrderCountExpr`） |
| **GMV** | 同 WHERE 下按币种 `SUM(total_amount)` → `convertToUSDSync` → **USD** |
| **时间窗** | `timeRange=today` 与 dashboard 契约一致（`buildDashboardWhere`，非 snapshot） |
| **不变量** | `today_orders <= 0` ⇒ `today_gmv = 0`；禁止 0 单正 GMV |

### 必须走 todayMetricsQuery 的消费方

| 场景 | 入口 |
|------|------|
| 店铺管理列表今日单/GMV | `enrichShopsListWithTodayStats` → `shopTodayStats` → **todayMetricsQuery** |
| 实时大屏 summary（今日） | `summaryQuery` → `queryTodayMetricsTenantTotal` |
| 店铺排行（今日） | `rankingQuery` → `queryTodayMetricsRankingRows` |
| GMV/订单趋势（今日累计） | `trendQuery` → **buildLockedKpiDashboardWhere**（与上表同口径） |
| GMV 对比分时曲线 | `gmvCompareQuery` → **contractForLockedKpi** |
| 健康刷新写回 `last_*` | `shopHealthRefreshService` + **todayMetricsQuery** 聚合 |

### 禁止作为「今日实时」数据源

- `dashboard-snapshot` / `storage/dashboard-snapshot/**`
- `orders-cache.json` / `gmv-cache.json`
- `dashboard_summary_cache` 表（仅预热/降级，**不得**单独提供今日 GMV 而订单走别路）
- `shops.last_gmv_amount` / `shops.last_order_count` **单独**展示（仅作写回缓存，列表 API 必须带 `today_*`）

### API 失败与展示

- 订单/OpenAPI **读取失败** → 健康/同步列显示 **「同步异常」**（`sync_failed` / `sync_stale`）
- **禁止**将 `[read-sync-shops]`、MySQL 不可用等基础设施错误标为 **授权异常**
- **授权异常**仅由 token / refresh_token / app_key / app_secret / sign / OAuth 鉴权失败触发（`shopAuthErrorClassifier` 严格分类）
- **无订单** → `today_orders=0`、`today_gmv=0`、健康 **今日无单** / **正常**；**不等于**授权异常

### 修改流程

1. 改 `todayMetricsQuery.js`
2. 同步更新本文档
3. staging 执行：
   - `node scripts/diagnose-order-analytics-status.js --tenant-id=<id> --date=<YYYY-MM-DD>`
   - `node scripts/diagnose-today-metrics-consistency.js --tenant-id=<id>`
4. 验收：`diagnose-dashboard-shop-scope.js`、前端三处（店铺管理 / 大屏 / 排行 / **趋势图累计**）数值一致

---

## Staging 验收环境

预发验收以 **daping-staging**（PM2：`daping-staging`、`tiktok-openapi-sync`）为准。其它目录下旧 `daping` 进程或 **better-sqlite3** 日志不属于 staging 验收范围。

## SaaS 主数据源

| 域 | 来源 | API 示例 |
|----|------|----------|
| 店铺 | MySQL `shops` | `GET /api/shops` |
| 订单 | MySQL `orders` | `GET /api/orders/*` |
| 同步 | MySQL `sync_shop_logs` | `GET /api/sync/*` |
| 授权 | MySQL `shops` + `shop_auth_tokens` | `GET /api/authorizations/*` |
| 看板汇总 | MySQL | `GET /api/dashboard/*` |
| 分析 | MySQL | `GET /api/analytics/*` |
| 汇率 | MySQL `exchange_rates` → 实时 API → 内置 fallback | `GET /api/settings` |
| 用户/权限 | MySQL | `GET /api/users` |

**禁止**：SaaS 路由读取 `orders-cache.json`、`shops.json`、`gmv-cache.json`。

### 实时大屏 GMV（War-Room）

| 展示 | 唯一 API | 说明 |
|------|----------|------|
| 主卡 GMV、右侧趋势卡「今日 GMV」 | `GET /api/dashboard/summary` → `gmv`（USD） | `todayMetricsQuery`（今日窗） |
| 右侧 GMV 曲线 | `GET /api/dashboard/gmv-compare` → `today`/`yesterday` points | **禁止**用 compare `summary.todayTotal` 作 KPI |
| 实时订单 | `GET /api/dashboard/orders` | 禁止 `/api/analytics/recent-orders` |

静态门禁：`npm run check:no-dashboard-legacy`（backend）。

## Legacy / 运维（cache/json）

| 文件 | 允许用途 |
|------|----------|
| `orders-cache.json` | `/legacy`、worker 写盘（deprecated）；运维 rebuild |
| `shops.json` | `OPENAPI_SHOPS_SOURCE=json` 紧急回滚 |
| `gmv-cache.json` | 仅 legacy 大屏；迁移脚本 |

## 禁止事项

1. 新 SaaS 功能不得 `readJsonSafe` 读上述三文件作今日 KPI。
2. 不得将 cache 作为 SaaS API 的 silent fallback。
3. 不得订单数与 GMV 使用不同 SQL/缓存来源。

## 相关文档

- `docs/deprecated-list.md`
- `docs/api-map.md`
- `docs/database-map.md`
