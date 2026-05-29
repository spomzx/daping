# 实时大屏筛选联动修复

## 问题

1. 选择具体店铺后 GMV 趋势显示「暂无趋势数据」
2. 切换订单标签后实时订单列表未同步
3. 样品订单无醒目标签

## 根因

- **GMV 趋势**：`GmvCompareTrendPanel` 在无分时数据时展示空态文案；单店时 `shop_id` 需与 Analytics `resolveShopClause` 一致（优先 MySQL `shops.id`）
- **实时订单**：筛选变更时用父组件旧 `seedOrders` 覆盖列表，未立即按新 `orderFilter` 请求 `/api/dashboard/orders`
- **样品标签**：`/api/dashboard/orders` 响应未带 `is_sample`

## 修改

| 区域 | 文件 |
|------|------|
| 统一筛选 | `frontend/src/lib/dashboardFilters.ts` |
| 订单筛选工具 | `frontend/src/lib/dashboardOrderFilter.ts` |
| 大屏页 | `frontend/src/legacy/LegacyDashboardPage.tsx` |
| GMV 趋势 | `frontend/src/GmvCompareTrendPanel.tsx` |
| 实时订单 | `frontend/src/components/RealtimeOrdersPanel.tsx` |
| 后端 compare 空序列 | `backend/modules/analytics/analyticsCompareService.js` |
| 后端订单 is_sample | `backend/modules/analytics/service.js` |

## 行为

- 所有模块共用 `buildDashboardQueryParams`：`shopId` / `shop_id` / `market` / `orderFilter` / `status` / 时间范围
- GMV 趋势：无数据时仍渲染 **0 值折线**；标题追加 `｜当前店铺名`
- 实时订单：筛选变化清空列表并立即轮询；样品显示橙色 **样品** tag
- `buildEmptyPayload` 返回 24 小时 0 桶序列，避免 SQL 空结果误判

## 验收（staging）

- [ ] 全部店铺 / 单店 GMV 趋势有曲线（可为 0 线）
- [ ] 订单标签切换后实时列表与 KPI/走势图一致
- [ ] 样品订单有「样品」标签
- [ ] `npm run build` 通过
- [ ] deploy-staging 成功，PM2 无 SQL 报错
