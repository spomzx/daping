# 大屏筛选 shop_id 联动修复

## 根因

TikTok `platform_shop_id` 常为长数字字符串。`resolveShopApiId` 与 `resolveShopClause` 曾将其当作 MySQL `shops.id` 查询，导致 `invalidShop`，进而：

- `/api/dashboard/orders` 返回空列表
- `/api/analytics/gmv-compare` 返回全 0 序列

而 legacy `/api/dashboard?shopId=` 按 `platform_shop_id` 过滤，KPI/排行仍正常。

## 修复

1. **后端** `analyticsFilter.resolveShopClause`：纯数字先查 `shops.id`，未命中再按 `platform_shop_id` 解析。
2. **前端** `resolveShopApiId`：合并 `/api/shops` + GMV/排行店铺目录；长数字默认作 platform id；catalog 命中时返回 MySQL `shops.id`。
3. **统一参数**：`buildDashboardQueryParams` 输出 `shop_id`；legacy 主接口额外 `shopId`（platform）。
4. **实时订单**：移除 `seedOrders`；仅轮询 `/api/dashboard/orders`；`warRoomOrders` 传递 `range/startDate/endDate`。
5. **调试日志**：`[dashboard-filter] endpoint=orders|trend shop_id=… orderFilter=… count|points=…`

## 订单状态筛选（后续）

`backend/modules/dashboard/filterBuilder.js` 导出 `buildOrderFilterWhere`，与 legacy `orderMatchesOrderFilter` 同口径（`order_status` + `raw_json`），替代仅按 `analytics_status = ?` 的 Analytics 条件。`getShopTrend` 已补订单筛选。

## 验收要点

选店 **CQ Chic Jewelry** 后：KPI、排行、实时订单、GMV 趋势订单量一致；切换订单类型筛选四模块同步。
