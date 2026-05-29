# KPI Contract（锁定）

> **KPI_CONTRACT_VERSION** = `kpi-valid-v1`  
> **Git tag（staging 验收）**：`staging-kpi-contract-valid-v1-20260525`  
> 修改本契约前必须：新需求说明、新分支、新诊断脚本、新 tag。  
> **禁止**未经评审恢复 `paid` / `all` / snapshot / cache 作为 KPI 或趋势累计兜底。  
> **禁止**验收通过后直接改 prod；仅 staging 功能分支修复验证。

## 有效订单口径

| 字段 | 规则 |
|------|------|
| `orders.analytics_status` | **`valid`** = 唯一 KPI 有效订单（今日订单、GMV、排行、趋势、商品排行） |
| | **`cancelled`** = 不计入 KPI GMV、今日订单、排行、趋势 |
| | **不存在** `analytics_status='paid'` 列值；禁止 SQL 以 `paid` 作 KPI 条件 |

UI「付款订单」：`orderFilter=paid` → 后端 **`analytics_status='valid'`**（TikTok paid 语义映射，见 `backend/lib/orderFilter.js` 注释）。

## 锁定常量与 SQL 助手（唯一实现处）

文件：`backend/lib/orderFilter.js`

| 导出 | 用途 |
|------|------|
| `LOCKED_KPI_ORDER_FILTER` | 字符串 `'valid'` |
| `buildLockedKpiWhere(alias)` | `AND o.analytics_status = 'valid'` |
| `buildLockedKpiOrderCountExpr(alias)` | `COUNT(DISTINCT o.id)` |
| `buildLockedKpiGmvExpr(alias)` | valid 行 `SUM(total_amount)` |

组合 WHERE：`buildLockedKpiDashboardWhere()`（`filterContract.js`）= 时间/店铺/市场 + 上表 status。

## 必须使用锁定契约的模块

| 模块 | 入口 |
|------|------|
| 今日 KPI | `todayMetricsQuery.js` → `buildLockedKpiDashboardWhere` + `buildLockedKpi*` |
| Summary 今日 | `summaryQuery.js` → `contractForLockedKpi` → `todayMetricsQuery` |
| Ranking 今日 | `rankingQuery.js` → `contractForLockedKpi` → `todayMetricsQuery` |
| Trend / order-volume | `trendQuery.js` → **始终** `buildLockedKpiDashboardWhere` |
| 商品排行 | `productRankingQuery.js` → **始终** `buildLockedKpiDashboardWhere` |
| GMV 对比曲线 | `gmvCompareQuery.js` → `contractForLockedKpi` |
| 店铺管理今日单/GMV | `shopTodayStats.js` → `todayMetricsQuery` |

## 禁止口径

- `analytics_status='paid'`、`payment_status='paid'`
- `analytics_status <> 'cancelled'` 作为 KPI 有效条件
- `COUNT(DISTINCT o.platform_order_id)` 作为 KPI 订单数
- `orderFilter=all` 作为今日 KPI 默认兜底
- 各模块自建 KPI status WHERE（须复用 `orderFilter.js`）

## Trend 字段命名

返回 `paid_orders` / `paid_gmv` **仅 UI 命名兼容**，语义 = valid 订单数 / valid GMV。禁止再维护 `trend_paid_*_vs_valid` 双轨诊断。

## GMV 舍入（全模块锁定）

- 契约：`KPI_GMV_ROUNDING_CONTRACT = ROUND(SUM(raw_usd_amount), 2)`
- 实现：`backend/modules/dashboard/gmvUsdConvert.js` → `rollupKpiGmvFromGmvRows` / `roundKpiGmvUsd`
- 租户汇总：`todayMetricsQuery.queryTodayMetricsTenantTotal` 必须用 `rollupKpiGmvFromGmvRows(gmvRows)`，禁止 `SUM(店铺 today_gmv)`
- 趋势：`trendQuery.kpi_totals.gmv_usd` / `gmv_usd_raw_sum`；图表 `points[].gmv` 仅展示
- 缓存：无 `kpi_totals` 的 trend 缓存视为 stale（`trendPayloadHasKpiTotals`）
- 诊断：只读 `kpi_totals.gmv_usd`；GMV 容差 `<= 0.01`

## Trend 缓存 / Snapshot

- 模块：`backend/lib/dashboardTrendCache.js`
- cache key / snapshot 文件名：`orderFilter=valid`（禁止 `trend_*_paid_*`）
- 启动：`bootPurgeLegacyTrendPaidCache()` 删除历史 paid snapshot
- 诊断：`node scripts/diagnose-trend-kpi-contract.js --tenant-id=<id> --date=<YYYY-MM-DD>`

## 验收脚本（staging）

```bash
cd /home/admin/daping-staging/backend

node scripts/diagnose-order-analytics-status.js --tenant-id=6 --date=2026-05-25
# 期望: ok=true, inconsistent_modules=[]

node scripts/diagnose-today-metrics-consistency.js --tenant-id=6
# 期望: acceptance.all_consistent=true
```

## 相关文档

- [`docs/data-source-policy.md`](./data-source-policy.md) — 今日 KPI 数据源硬锁与本文链接
