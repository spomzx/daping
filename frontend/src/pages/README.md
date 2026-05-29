# 前端页面（阶段三）

| 页面 | 组件 | 路由 | API |
|------|------|------|-----|
| 数据总览 | `AnalyticsPage`（`saasMode`） | `/dashboard` | `/api/analytics/*` |
| 店铺管理 | `ShopMgmtPage` | `/shops` | `/api/shops/*` |
| 用户管理 | `UserMgmtPage` | `/users` | `/api/users/*` |
| 订单中心 | `PlaceholderPage` | `/orders` | 待接 `/api/orders` |
| 授权明细 | `PlaceholderPage` | `/authorizations` | `/api/authorizations` |
| 同步中心 | `PlaceholderPage` | `/sync` | `/api/sync/*` |
| 日志中心 | `PlaceholderPage` | `/logs` | `/api/logs` |
| 系统设置 | `PlaceholderPage` | `/settings` | `/api/settings` |
| 登录 | `LoginPage` | `/login` | `/api/auth/*` |
| 旧大屏 | `GmvDashboard` @deprecated | `/legacy` | `/api/dashboard*`（Legacy 层） |

> `/reconcile` 已废弃（阶段十），无独立页面；直链重定向 `/dashboard`。

布局：`components/layout/SaasLayout.tsx` + `config/saasNav.ts`。

API 封装：`services/api/*`（逐步从页面迁出 fetch）。

路由入口：`App.tsx` → `AppShell`；登录后默认 `/dashboard`。
