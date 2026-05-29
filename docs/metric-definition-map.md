# 指标口径定义地图（Phase 2）

> **KPI 硬锁**：今日订单数 / 今日 GMV → `backend/modules/dashboard/todayMetricsQuery.js`  
> 详见 [`data-source-policy.md`](./data-source-policy.md)、[`kpi-contract.md`](./kpi-contract.md)

## 时间口径（当前 vs 目标）

| 规则 | 当前实现 | 目标 |
|------|----------|------|
| 入库时间 | TikTok 原始时间存 `orders` | ✅ 保持 |
| 统计时区 | `dashboardTimeRange.js` **服务器本地自然日** | 按店铺 `market` 时区（待 P4） |
| 前端展示 | 浏览器本地 `dashboardBounds.ts` 生成 `startDate/endDate` | 展示可本地化，**区间由后端 timeWindow 返回** |
| today/yesterday/7d/30d | 后端 `normalizeRange` + `getTimeRangeBounds` | ✅ 禁止前端自算 SQL 窗口 |
| timeWindow 元信息 | 部分 debug/`time_window` 字段 | **所有统计 API 必须返回完整 timeWindow** |

### timeWindow 目标结构（尚未全接口落地）

```json
{
  "market": "TH",
  "timezone": "Asia/Bangkok",
  "startAt": "2026-05-28T00:00:00+07:00",
  "endAt": "2026-05-28T15:30:00+07:00",
  "displayRange": "today",
  "serverNow": "2026-05-28T16:00:00+07:00",
  "browserDisplayAllowed": true
}
```

---

## 指标登记

### 1. 今日 GMV

| 项 | 值 |
|----|-----|
| API | `GET /api/dashboard/summary` |
| SQL/Service | `todayMetricsQuery` → `queryTodayMetricsTenantTotal` |
| Frontend | `LegacyDashboardPage` → `fetchDashboardSummary`；`parseDashboardSummaryKpi` |
| 表 | `orders` |
| 时间 | `timeRange=today`，`orderAnalyticsEventTimeExpr` |
| 过滤 | tenant + `buildShopScopeWhere` + market + shopId |
| 重复算法 | ❌ 无（LOCKED） |
| 合并 | 不需要 |
| 锁定 | ✅ **是** |

### 2. 昨日 GMV

| 项 | 值 |
|----|-----|
| API | `GET /api/dashboard/gmv-compare`（曲线）；summary 若 `timeRange=yesterday` |
| SQL/Service | `gmvCompareQuery` / `getTodayYesterdayIntradayCompareEpochBounds` |
| Frontend | `GmvCompareTrendPanel` |
| 表 | `orders` |
| 时间 | yesterday 自然日 或 compare 分时 |
| 过滤 | 同 dashboard contract |
| 重复算法 | ⚠️ analytics `gmv-compare` 并行 |
| 合并 | **建议** 与 analytics 合并 |
| 锁定 | compare 曲线可锁；昨日 KPI 走 TMQ + yesterday range |

### 3. 今日订单数

| 项 | 值 |
|----|-----|
| API | `GET /api/dashboard/summary` |
| SQL/Service | `todayMetricsQuery` — `COUNT(DISTINCT o.id)` |
| Frontend | 同今日 GMV |
| 表 | `orders` |
| 时间/过滤 | 同今日 GMV |
| 重复算法 | ❌ |
| 锁定 | ✅ **是** |

### 4. 今日商品销量排行

| 项 | 值 |
|----|-----|
| API | `GET /api/dashboard/product-ranking` |
| SQL/Service | `productRankingQuery.js` |
| Frontend | `LegacyDashboardPage` → `fetchDashboardProductRanking` |
| 表 | `orders`, `order_items` |
| 时间 | dashboard contract（通常 today） |
| 过滤 | tenant/shop/market |
| 重复算法 | ⚠️ `/api/analytics/top-products`（hours 窗） |
| 合并 | 作战室 vs SaaS 总览 **不同产品场景**，登记双轨 |
| 锁定 | dashboard 轨 🔒 |

### 5. 店铺销售排行

| 项 | 值 |
|----|-----|
| API | `GET /api/dashboard/ranking` |
| SQL/Service | `rankingQuery` → `queryTodayMetricsRankingRows` |
| Frontend | `fetchDashboardRanking` |
| 表 | `orders` |
| 时间 | today（默认） |
| 过滤 | tenant/shop/market |
| 重复算法 | ⚠️ analytics `top-shops` |
| 合并 | 建议 SaaS 总览改读 dashboard 或共享 service |
| 锁定 | dashboard 轨 🔒 |

### 6. 实时订单列表

| 项 | 值 |
|----|-----|
| API | `GET /api/dashboard/orders` |
| SQL/Service | `warRoomOrders.js` / `ordersQuery.js` |
| Frontend | `RealtimeOrdersPanel`（直连 fetch） |
| 表 | `orders` |
| 时间 | contract `timeRange`（常 today + live） |
| 过滤 | tenant + shop scope |
| 重复算法 | ⚠️ `/api/analytics/recent-orders`（**作战室禁止**） |
| 锁定 | ✅ War-Room 仅 dashboard |

### 7. 趋势图

| 项 | 值 |
|----|-----|
| API | `GET /api/dashboard/trend`, `/order-volume` |
| SQL/Service | `trendQuery.js`, `orderMetricsService` |
| Frontend | `OrderVolumeChart` |
| 表 | `orders` |
| 时间 | range 内分桶 |
| 过滤 | `buildLockedKpiDashboardWhere`（今日累计与 TMQ 一致） |
| 重复算法 | analytics `shop-trend` |
| 锁定 | dashboard 🔒 |

### 8. 样品订单

| 项 | 值 |
|----|-----|
| API | `GET /api/orders/list?...` + filter |
| SQL/Service | `orders/repository` + `orderFilter` 语义 |
| Frontend | `OrdersPage` |
| 表 | `orders` |
| 时间 | `hours` 24/168/720 |
| 过滤 | `analytics_status` / sample 相关字段 |
| 重复算法 | 与 dashboard `orderFilter` 需语义一致 |
| 锁定 | 订单中心独立，登记 filter 契约 |

### 9. 取消订单

| 项 | 值 |
|----|-----|
| API | 同订单列表/统计 |
| SQL/Service | `orderFilter` — cancelled 状态 |
| Frontend | `OrdersPage` |
| 表 | `orders` |
| 锁定 | 随 orders 模块 |

### 10. 授权店铺列表

| 项 | 值 |
|----|-----|
| API | `GET /api/authorizations/list`, `GET /api/shops` |
| SQL/Service | `authorizations/*`, `shops/service` |
| Frontend | `AuthorizationsPage`, `ShopMgmtPanel` |
| 表 | `shops`, `shop_auth_tokens` |
| 过滤 | tenant + shop scope |
| 重复算法 | ⚠️ `GET /api/tiktok/shops`（JSON） |
| 合并 | **废弃 tiktok/shops** |
| 锁定 | `/api/shops` 🔒 |

### 11. 店铺状态 / 同步状态

| 项 | 值 |
|----|-----|
| API | `GET /api/shops`, `/api/shops/health`, `GET /api/sync/status` |
| SQL/Service | `shopHealthService`, `sync/service` |
| Frontend | `ShopMgmtPanel`, `SyncCenterPage` |
| 表 | `shops`, `shop_sync_status`, `sync_shop_logs` |
| 锁定 | 🔒 |

### 12. 汇率换算

| 项 | 值 |
|----|-----|
| API | `GET /api/exchange-rate`, `GET /api/settings` |
| SQL/Service | `exchangeRateService`, `gmvUsdConvert` |
| Frontend | `exchangeRateFallback.ts`（localStorage 缓存展示） |
| 表 | `exchange_rates` |
| 重复算法 | 内置 fallback rate（非 JSON 文件） |
| 锁定 | GMV 换算走 DB 汇率；禁止 gmv-cache |

---

## 有效订单口径（全局）

- `analytics_status='valid'`（`orderFilter` / `filterContract`）
- UI「付款订单」= valid
- 修改须同步 KPI 诊断脚本

---

## 新增指标流程

1. 在本文档新增一节（API / SQL / 表 / 时间 / 过滤）
2. 实现于单一 service/query 模块
3. 更新 `auditSaasUnification.js` 与权限矩阵
4. 验收后标记「锁定」
