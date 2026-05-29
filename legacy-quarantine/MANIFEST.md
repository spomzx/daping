# Legacy Quarantine Manifest

登记 / 隔离已从 SaaS 主链路剥离的模块。**生产默认不挂载、不引用。**

详细清理记录见：`CLEANUP-2026-05-25.md`。

## 物理位置

| 目录 | 内容 |
|------|------|
| `backend/legacy-quarantine/routes/` | 旧 `legacyDashboardRoutes` / `deprecatedOpsAliases` |
| `backend/legacy-quarantine/scripts/` | 一次性 diagnose / migrate / audit 脚本 |
| `legacy-quarantine/frontend/` | 无引用的 deprecated 前端（`gmvCompareFetch.ts` 等） |
| `legacy-quarantine/docs/` | 历史审计草稿 |

## 仍在原路径、仅登记（有 ops/工具引用）

| 原路径 | 用途 |
|--------|------|
| `backend/tiktok-api/ordersDashboardFromCache.js` | transform / ops；非 dashboard 主读 |
| `backend/modules/shops/importCacheShops.js` | ops import-cache |
| `backend/modules/orders/orderCacheRebuildService.js` | ops rebuild-cache |
| `backend/lib/ordersCachePath.js` | cache 路径常量 |

## SaaS Dashboard 唯一读源

- MySQL `orders` / `order_items` / `shops` / `exchange_rates`

## 紧急回滚（仅本地/staging 研究）

```env
# 需自行恢复 legacy-quarantine/routes → backend/routes 并改 registerApiRoutes
ENABLE_LEGACY_DASHBOARD_ROUTES=1
```
