# 锁定基线（daping-staging Clean Baseline）

**版本**：SaaS 数据中台 Phase 2 — 统一数据源与模块边界  
**日期**：2026-05-28  
**环境**：仅 `daping-staging`；**禁止修改 prod**

---

## 1. Clean Baseline 声明

当前仓库（`daping-staging` 精简后）为后续所有开发的**唯一基线**：

- SaaS 主链路已挂载 `saasMysqlOnlyMiddleware`
- Legacy dashboard 聚合路由已 410（`removedLegacyGone.js`）
- 今日 KPI 锁定于 `todayMetricsQuery.js`
- `server.js` 仅保留启动、中间件、模块挂载、TikTok OAuth、汇率、健康检查

任何「恢复旧文件以兼容」的 PR **一律拒绝**。

---

## 2. 禁止项（纪律）

| 禁止 | 说明 |
|------|------|
| 恢复 legacy/cache/sqlite/json fallback | 包括 `orders-cache`, `gmv-cache`, `shops.json`, `dashboard.db` |
| 修改 prod / nginx / PM2 / deploy / rollback 脚本 | 本阶段不涉及基础设施 |
| 大范围 UI 重构 | 仅统一数据与边界 |
| 无记录直接改 main | 必须先 feature 分支或 tag |
| 在 `server.js` 新增业务接口 | 必须进 `backend/modules/*` |
| 前端自行计算统计 SQL 时间窗 | 必须后端 `timeWindow` |

---

## 3. 已锁定模块（无新需求不得重构）

| 模块/文件 | 锁定内容 |
|-----------|----------|
| `modules/dashboard/todayMetricsQuery.js` | 今日订单数、今日 GMV |
| `modules/dashboard/filterContract.js` | Dashboard WHERE 契约 |
| `routes/registerApiRoutes.js` | SaaS 路由挂载表 |
| `lib/saasMysqlOnly.js` | MySQL-only 门禁 |
| `modules/orders/*`（list/stats） | 订单中心读路径 |
| `modules/shops/*`（MySQL 列表） | 店铺主数据 |
| `docs/data-source-policy.md` | KPI 策略 |

---

## 4. 新增功能规则

1. **必须**进入对应 `backend/modules/<domain>/`
2. **必须**先登记 [`metric-definition-map.md`](./metric-definition-map.md)
3. **必须**更新 [`api-permission-matrix.md`](./api-permission-matrix.md)
4. **必须**通过 `node backend/scripts/auditSaasUnification.js`
5. Frontend 新业务调用 **必须**经 `frontend/src/services/api/`

---

## 5. 验收命令（staging）

```bash
cd /home/admin/daping-staging   # 或本地仓库根目录

node backend/scripts/auditSaasUnification.js

cd frontend && npm run build

cd ../backend && npm install

# 服务器上（本仓库开发机可跳过 PM2）
pm2 restart daping-staging
pm2 logs daping-staging --lines 100

curl -s http://127.0.0.1:3081/api/health
```

有 token 时抽检：`/api/dashboard/summary`、`/api/dashboard/orders`、`/api/shops`、`/api/dashboard/product-ranking`、`/api/exchange-rate`、`/api/authorizations/list`。

---

## 6. 本阶段完成定义

- [x] 数据源地图、模块边界、指标口径、权限矩阵文档
- [x] `auditSaasUnification.js` 可执行
- [ ] 全部 legacy 运行时引用清零（**tiktok/shops JSON 仍待 P2**）
- [ ] 全 API 返回标准 `timeWindow`（**P4**）
- [ ] gmv-compare 双实现合并（**P1**）

**是否进入下一阶段**：当 P1（compare 合并）+ P2（server 汇率/shops 迁移）+ 前端 service 收敛完成后，方可进入功能开发阶段。

---

## 7. 相关文档索引

- [`saas-unification-map.md`](./saas-unification-map.md)
- [`module-boundary-map.md`](./module-boundary-map.md)
- [`metric-definition-map.md`](./metric-definition-map.md)
- [`api-permission-matrix.md`](./api-permission-matrix.md)
- [`data-source-policy.md`](./data-source-policy.md)
