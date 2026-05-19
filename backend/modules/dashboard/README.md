# dashboard 模块（SaaS）

MySQL-only 摘要接口，挂载于 `/api/dashboard`。

- `GET /summary` — 订单数 / GMV / 活跃店铺数
- `GET /trend` — 委托 `analytics` shop-trend
- `GET /ranking` — 委托 `analytics` top-shops

旧 war-room 全量聚合仍在 `server.js`（`/api/dashboard` 根路径等），标记 deprecated。
