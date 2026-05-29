# 旧单页 BI 大屏（Legacy）

**代码位置**：`frontend/src/App.tsx` 内组件 `GmvDashboard`（class `war-room`）。

**路由**：`/`（登录后默认）。

**数据 API**：

- `GET /api/dashboard`
- `GET /api/dashboard/trend`
- `GET /api/dashboard/shop-ranking`
- 等

**规则**：

- 不得作为新功能开发入口。
- 不得新增对 shops.json / orders-cache 的主依赖。
- 阶段八：默认重定向到 `/analytics`，本目录可迁入抽离后的组件文件。
