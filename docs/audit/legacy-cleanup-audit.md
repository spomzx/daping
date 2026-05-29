# Legacy / Deprecated 清理审计（dashboard-contract）

**分支**: `feature/legacy-cleanup-audit`  
**日期**: 2026-05-19  
**标签**: `legacy-cleanup-audit-stable`（提交后打 tag）

## 目标

避免实时大屏与 dashboard-contract 混用旧 analytics / cache / compare KPI，导致主卡 GMV 与右侧趋势卡不一致。

## 验收命令

```bash
# 前端
cd frontend && npm run build

# 后端
cd backend
npm run check:dashboard-contract   # DASHBOARD_TENANT_ID=6 需 MySQL
npm run check:no-dashboard-legacy
```

## 修改文件列表

| 文件 | 变更 |
|------|------|
| `frontend/src/GmvCompareTrendPanel.tsx` | War-Room 专用：KPI 仅 `summaryKpi`；曲线仅 dashboard gmv-compare series |
| `frontend/src/legacy/LegacyDashboardPage.tsx` | 拉取 `/api/dashboard/summary`；主卡与趋势卡共用 KPI |
| `frontend/src/lib/dashboardSummaryKpi.ts` | 新增 summary KPI 解析与 DEV 一致性 warn |
| `frontend/src/lib/normalizeGmvCompareResponse.ts` | 拆分 `normalizeGmvCompareSeriesOnly` vs analytics 全量 |
| `frontend/src/analytics/AnalyticsGmvCompareTrendPanel.tsx` | 新增：仅数据总览，允许 analytics gmv-compare KPI |
| `frontend/src/AnalyticsPage.tsx` | 改用 `AnalyticsGmvCompareTrendPanel` |
| `frontend/src/components/dashboard/gmvCompareFetch.ts` | Deprecated 注释 |
| `backend/scripts/check-no-dashboard-legacy.js` | 新增静态检查 |
| `backend/package.json` | `check:no-dashboard-legacy` |
| `docs/audit/legacy-cleanup-audit.md` | 本文档 |
| `docs/deprecated-list.md` | 增补 D39+ |
| `docs/data-source-policy.md` | 增补 War-Room GMV 规则 |

## 删除文件列表

无（遵循「不确定不硬删」）。

## 隔离 / 新增文件

| 路径 | 说明 |
|------|------|
| `frontend/src/analytics/AnalyticsGmvCompareTrendPanel.tsx` | analytics 专区，禁止 war-room import |
| `frontend/src/lib/dashboardSummaryKpi.ts` | 统一 summary KPI |
| `backend/scripts/check-no-dashboard-legacy.js` | CI/发布前静态门禁 |

## 保留但 Deprecated

| 路径 | 保留原因 | 禁止引用方 |
|------|----------|------------|
| `backend/routes/legacyDashboardRoutes.js` | 旧 `/api/dashboard` war-room 聚合（cache 可选） | SaaS `/api/dashboard/summary` 等 contract 路由 |
| `backend/modules/analytics/*` | 数据总览、历史报表 | `frontend/src/legacy/*`、`GmvCompareTrendPanel.tsx` |
| `frontend/src/components/dashboard/gmvCompareFetch.ts` | 历史 analytics 封装 | 实时大屏 |
| `backend/scripts/check-saas-routes.js` | 冒烟含 analytics 路由 | — |
| `orders-cache.json` / `gmv-cache.json` | 运维/legacy 迁移 | `backend/modules/dashboard/*` |

## 禁止引用规则

1. **实时大屏**（`LegacyDashboardPage`、`GmvCompareTrendPanel`、`RealtimeOrdersPanel`）  
   - GMV KPI：**仅** `GET /api/dashboard/summary`  
   - GMV 曲线：**仅** `GET /api/dashboard/gmv-compare` 的 `today`/`yesterday` points  
   - 订单：**仅** `GET /api/dashboard/orders`  
   - **禁止** `/api/analytics/*`、`trendFallback`、`gmvCompare.summary.*` 作 KPI  

2. **数据总览**（`AnalyticsPage`、`analytics/*`）  
   - 允许 `/api/analytics/gmv-compare` 与 compare summary KPI  
   - 必须在文件头注释标明「非实时大屏」  

3. **后端 dashboard 模块**  
   - 仅 `buildDashboardWhere` + `usdGmv` USD 口径  
   - 禁止 `analyticsSvc`、禁止读 cache/json  

4. **日志**  
   - 允许：`[dashboard-contract]`  
   - 禁止：`[dashboard-filter]`、`[analytics-query]`（大屏路径）  

## dashboard-time-filter 移除（2026-05-19 补丁）

- `ordersDashboardFromCache.buildOrdersDashboardPayload`：MySQL 契约预过滤时跳过 `createTime` 二次截断；`[dashboard-time-filter]` 仅允许 `DASHBOARD_LEGACY_TIME_FILTER_LOG=1` 时 warn。
- `legacyDashboardRoutes`：不再 `logDashboardContract('summary')` 冒充契约 summary。
- `mysqlDashboardOrdersService`：拉单改用 `buildDashboardWhere`（与 summary 同口径）。
- `LegacyDashboardPage`：停用 `GET /api/dashboard?`，统一 `summary` + `ranking` + `product-ranking` 契约 API。

## 后续删除计划

| 项 | 条件 |
|----|------|
| `legacyDashboardRoutes` 主读 cache | 大屏 100% 切 contract summary + 弃用 `/api/dashboard` 聚合 |
| `gmvCompareFetch.ts` | 无引用后删除 |
| `Analytics` 与 `dashboard` compare 双实现 | 后端统一 compare 服务后合并 |

## 风险说明

- 主卡仍请求 legacy `/api/dashboard` 做店铺/商品/排行；**GMV 数字**已优先 `summary` USD，与右侧趋势卡对齐。  
- `summary` 暂无 `compare.previousGmv` 时，右侧「昨日同期」KPI 显示 **—**（曲线仍有昨日线）。  
- Staging 需执行 `check:dashboard-contract` 与 `check:no-dashboard-legacy` 后方可认为发布合格。

## 下一阶段

- 主卡完全脱离 `/api/dashboard` cache 聚合，仅 contract 子接口  
- 可选：summary 增加 `compare` 字段供昨日同期 KPI，无需第二请求  
