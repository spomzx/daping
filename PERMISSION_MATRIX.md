# GMV SaaS 大屏 — 最终权限矩阵（锁版）

本文档为**唯一标准**：三角色 `super_admin` | `admin` | `viewer`；历史角色在 JWT / DB / 中间件中经 `normalizeRoleFromDb` 映射后参与鉴权（如 `platform_admin` → `super_admin`，`tenant_owner` / `tenant_admin` → `admin`，`tenant_viewer` → `viewer`）。

---

## 1. 角色定义

| 角色 | 说明 |
|------|------|
| `super_admin` | 平台管理员：全平台数据与用户、跳过 tenant / dashboard shop gate（与实现中 `isPlatformAdmin` 语义一致，仅指超管） |
| `admin` | 客户管理员：仅本 tenant |
| `viewer` | 普通用户：只读 |

---

## 2. 能力矩阵（摘要）

| 能力 | super_admin | admin | viewer |
|------|:-------------:|:-----:|:------:|
| 顶部：通知 | ✅ | ❌ | ❌ |
| 顶部：数据分析 | ✅ | ✅ | ✅ |
| 顶部：用户管理 | ✅ | ✅ | ❌ |
| 顶部：管理店铺（抽屉/路由） | ✅ | ✅ | ❌ |
| 顶部：TikTok OAuth 跳转 | ✅ | ✅ | ❌（仅只读提示） |
| 顶部：汇率 / 退出 | ✅ | ✅ | ✅ |
| MySQL `/api/shops` 列表 | 全平台 | 本 tenant | 本 tenant（只读 GET） |
| MySQL 店铺写操作 | ✅（按店铺 `tenant_id` 落库） | 本 tenant | ❌ 403 |
| `/api/operation-logs` | ✅ 全平台 | ❌ 403 | ❌ 403 |
| `/api/notifications` | ✅ | ❌ 403 | ❌ 403 |
| `/api/billing`、`/api/queue` | ✅ | ✅ | ❌ 403 |
| `/api/orders/reconcile` | ✅ | ✅ | ❌ 403 |
| TikTok 文件店铺 `GET /api/tiktok/shops` | ✅ | ✅ | ✅（需登录 + full access） |
| `GET /api/tiktok/auth/start` | ✅（`?token=` 或 Bearer） | ✅ | ❌ 403 |
| `POST /api/tiktok/shops/:id/enable|disable`、`collect-now` | ✅ | ✅ | ❌ 403 |
| Analytics / Dashboard 读 | 全平台（超管 `skipTenant` / 跳过 shop gate） | 本 tenant | 本 tenant 只读 |

---

## 3. 用户管理

| 动作 | super_admin | admin | viewer |
|------|:-------------:|:-----:|:------:|
| 列表用户 | 全部 | 本 tenant，**不含** `super_admin` / `platform_admin` | ❌（路由层拒绝） |
| 创建用户 | admin / viewer | 仅 viewer | ❌ |
| 禁用 / 重置密码 | ✅ | 本 tenant 内规则内 | ❌ |
| 删除用户 | ✅（含另一超管，**不可删最后一个活跃超管**） | 仅 viewer | ❌ |
| 删除自己 | 全员禁止 | 全员禁止 | — |

---

## 4. 实现对照（代码入口）

| 区域 | 说明 |
|------|------|
| `backend/lib/roles.js` | 规范化角色、`isSuperAdmin` / `isPlatformAdmin` / `isAdminFamily` / `isReadOnlyRole` |
| `backend/middlewares/authRequired.js` | JWT；`authRequiredAllowQueryToken` 供 OAuth 浏览器跳转 `?token=` |
| `backend/middlewares/requireRole.js` | 角色校验（含历史别名展开） |
| `backend/middlewares/denyViewerManagement.js` | viewer 禁止管理类写接口（users 模块全局） |
| `backend/modules/users/service.js` | 列表过滤、删除最后一个 `super_admin` 保护 |
| `backend/modules/shops/service.js` | `listAllShops` / `getShopByIdGlobal` |
| `backend/modules/shops/controller.js` | 超管按店铺真实 `tenant_id` 更新与记操作日志 |
| `backend/modules/logs/routes.js` | 仅 `super_admin` |
| `backend/modules/logs/service.js` | `listOperationLogsAll` 全平台 |
| `backend/modules/notifications/routes.js` | 仅 `super_admin` |
| `backend/modules/billing/routes.js`、`queue/routes.js` | `admin` + `super_admin` |
| `backend/modules/orders/routes.js` | reconcile：`admin` + `super_admin` |
| `backend/server.js` | TikTok auth/shops/enable/disable/collect-now 鉴权链 |
| `frontend/src/authRole.ts` | 前端规范化 + `platform_admin` → `super_admin` |
| `frontend/src/App.tsx` | 通知铃铛仅超管、OAuth URL 带 token、通知路由守卫 |
| `frontend/src/ShopMgmtPanel.tsx` | 操作日志 UI 仅超管（与后端一致） |

---

## 5. 路由约定

- 店铺管理前端路由统一为 **`/shops`**（无 `/shop-manage` 混用）。

---

## 6. i18n

权限相关展示文案需在 **中文 / English / ไทย** 三套 JSON 中各自完整配置（见 `frontend/src/i18n/*.json`），避免单条内混用多语言。

---

## 7. 验收清单（与任务书对齐）

1. `super_admin`：全平台用户、店铺、dashboard、analytics、logs、notifications。  
2. `admin`：用户列表无超管、无其他 tenant；无通知、无 operation-logs API。  
3. `viewer`：无用户管理、无店铺管理、无 OAuth；管理类 POST/PATCH/DELETE 返回 **403**。  
4. `npm run build`（前端）通过。
