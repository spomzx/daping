# P1-C.3 Snapshot 降级审计

> **任务**：P1-C.3 Dashboard Cache 统一化  
> **结论**：SaaS 主链路不再依赖 `storage/dashboard-snapshot/` JSON 快照。

## 1. 过去 snapshot 用于哪些 endpoint

| endpoint | 目录名 | 说明 |
|----------|--------|------|
| `summary` | `summary` | 今日 KPI 汇总 |
| `ranking` | `shop-ranking` | 店铺排行 |
| `product-ranking` | `product-ranking` | 商品排行 |
| `gmv-compare` | `gmv-compare` | GMV 对比 |
| `order-volume` | `order-volume` | 订单量趋势 |

实现文件：`backend/lib/dashboardSnapshotCache.js`（读写）、`dashboardSnapshotWarmScheduler.js`（预热）、`dashboardRefreshScheduler.js`（清理）。

P1-C.2 之前，`withDashboardCache` 读顺序为：**memory → MySQL table → snapshot(fresh/stale) → loader**。

## 2. 现在是否仍在主链路

| 路径 | snapshot 读取 | snapshot 写入（主请求） |
|------|---------------|-------------------------|
| `withDashboardCache`（SaaS API） | **否** | **否**（`syncDashboardSnapshotWrite` 已空操作） |
| `serveDashboardReadonly`（只读预计算页） | **否** | **否** |
| `dashboardSnapshotWarmScheduler` | 否（仅写） | 是（运维预热，非 HTTP 主读） |
| `readDashboardSnapshotCache` | 仍存在于文件中 | — |

统一入口：`backend/modules/dashboard/cache/dashboardCacheService.js`  
固定读顺序：**memory → `dashboard_*_cache` 表 → MySQL loader**。

## 3. 结论

- **SaaS 主链路不再依赖 snapshot** 作为缓存层；miss 时直接走 table stale（趋势）或 MySQL loader。
- snapshot 模块保留并标记 `@deprecated`，供 warmup/cleanup 与紧急排障，**禁止**在 `dashboardCache.js` / `dashboardReadonlyCache.js` 主路径调用 `readDashboardSnapshotCache`。
- 验收：`auditSaasUnification.js` → `dashboardCacheUnifiedStatus.snapshotExcludedFromPrimaryReadPath === true`。
