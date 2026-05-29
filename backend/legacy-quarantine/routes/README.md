# Legacy routes（已下架，仅归档）

自 P2-C 起 SaaS 主链路不再挂载以下路由；活跃替代为 `backend/routes/removedLegacyGone.js`（410）。

| 文件 | 原挂载 |
|------|--------|
| `legacyDashboardRoutes.js` | `GET /api/dashboard` 等 war-room 聚合 |
| `legacyRoutes.js` | legacy 路由注册入口 |
| `deprecatedOpsAliases.js` | `/api/shops/import-cache`、`/api/orders/reconcile` 等别名 |

本地回滚研究：复制回 `backend/routes/` 并在 `registerApiRoutes` 显式挂载（**禁止生产默认**）。
