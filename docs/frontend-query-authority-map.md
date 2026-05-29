# Frontend Query Authority Map

## dashboardQueryStore 字段

`frontend/src/stores/dashboardQueryStore.ts` 统一管理以下跨页面查询字段：

- `market`：市场（`ALL/TH/PH/MY/SG/VN`）
- `range`：统一窗口（`today/7d/30d`）
- `orderFilter`：订单筛选（`all/valid/unpaid/sample/cancelled`）
- `shopId`：店铺范围（`all` 或指定店铺）
- `timezone`：展示/请求时区（IANA 或 `UTC`）
- `timeWindow`：页面展示用时间窗口回显

## 各页面 query 来源

- `dashboard (LegacyDashboardPage)`：读取 `useDashboardQueryStore()`；请求参数由 `buildDashboardQueryParams()` 统一构造，再按 dashboard 场景补充 `timeRange/startDate/endDate`。
- `analytics (AnalyticsPage)`：读取 `useDashboardQueryStore()`；列表与趋势请求通过 `buildDashboardQueryParams()` 组装。
- `orders (OrdersPage)`：读取 `useDashboardQueryStore()`；`/api/orders/list` 与 `/api/orders/stats` 参数由 `buildDashboardQueryParams()` 统一生成。
- `recent-orders`：前端通过 analytics API 封装调用，错误文案统一为“最近订单暂时不可用，请稍后刷新”；调试日志保留原始 `analytics_http_xxx` code。

## Legacy 字段映射

- legacy `paid` 映射为 store `valid`（`orderFilterFromLegacy()`）。
- legacy `marketRegion=all` 映射为 store `market=ALL`。
- legacy `shopId=all` 保持一致。

## 暂未完全统一字段与原因

- `yesterday/custom`（以及 `customStart/customEnd`）仍保留在 `LegacyDashboardPage` 局部状态。
- 原因：当前 store 仅定义标准窗口 `today/7d/30d`，自定义日期区间是 legacy 大屏特有能力；为避免改动后端时间契约，暂采用“store 统一基础筛选 + 局部补充时间边界”的方案。

## 约束（后续）

- 新页面不得新增局部 query authority（`market/range/orderFilter/shopId/timezone`）。
- 所有页面请求参数必须经 `buildDashboardQueryParams()` 构造，不允许手写 `?market=&range=&orderFilter=&status=`。
