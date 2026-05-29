# Field Governance Rules v2

> 强制执行方式：代码评审 + `node backend/scripts/diagnose-field-registry.js`（staging）。  
> v1 规则仍有效：`field-governance.md`、`field-contract-map.md`。

---

## 1. 查询与 SQL

1. **禁止** Dashboard / BI 查询 `SELECT *`。  
2. **禁止** 新增 list API 使用 `SELECT *`（detail 短期 `SELECT o.*` 须标 deprecated，见 registry 诊断）。  
3. **禁止** dashboard 时间窗使用 `orders.created_at` / `orders.updated_at` 代替 `created_at_platform`。  
4. **禁止** `analytics_status = 'paid'` 出现在生产 SQL（`orderFilter=paid` 除外）。  
5. **禁止** KPI WHERE 仅依赖 `order_status` 而无 `analytics_status` 契约。

---

## 2. API 与 DTO

6. **禁止** 后端接口随意新增未登记 alias（须更新 `field-registry.md` + `dto-contracts.md`）。  
7. **禁止** 页面组件「猜字段」（`row.foo ?? row.bar` 无类型、未登记字段）。  
8. **新 DTO 必须先定义类型**（`frontend/src/types/*` 或 `lib/*Kpi*.ts`）。  
9. **禁止** dashboard query 直接返回未文档化的 DB raw 行（须经 DTO 映射）。  
10. **禁止** 多个 source-of-truth 并存于同一业务路径（见 `source-of-truth.md`）。

---

## 3. 状态与 Token

11. **`analytics_status` 只能**来自统一 contract（persist derive + `orderFilter.js` + `filterBuilder.js`）。  
12. **禁止** 前端自行推导 `token missing`（须用 API `health_*` / `is_token_valid` / `sync_status`）。  
13. **禁止** 用 `shops.status=active` 代替授权/同步健康判断。

---

## 4. 字段生命周期

14. **新 DB 字段** → 先改 `field-registry.md`，再迁移（本阶段不改库结构）。  
15. **废弃字段** → 必须写入 `deprecated-fields.md`（含 risk / replacement / migration_status）。  
16. **平台 alias**（`createTime` 等）→ 仅 ingest 边界；须进入 `allowed_alias` 白名单路径。

---

## 5. 金额与 KPI

17. **GMV 真源**：`SUM(orders.total_amount)`；禁止 `today_gmv` 写回 DB。  
18. **禁止** 非标准 `SUM(ROUND(...))` 作为默认 KPI rollup（dashboard 模块 warn）。  
19. **KPI contract 已锁定**：不得在本治理阶段修改默认 valid / paid 语义。

---

## 6. 诊断与发布

20. staging 合并前执行：  
    ```bash
    node backend/scripts/diagnose-field-registry.js
    cd frontend && npm run build
    ```  
21. `ok: false` 时禁止合并含 **critical** `high_risk_hits` 的变更。  
22. **禁止** 为通过诊断而关闭类型检查、`any`、`@ts-ignore`。  
23. **禁止** 本阶段 deploy / prod / nginx / PM2 变更。

---

## 文档索引

| 文档 | 用途 |
|------|------|
| `field-registry.md` | 全模块字段注册表 |
| `source-of-truth.md` | 真源定义 |
| `deprecated-fields.md` | 废弃字段 |
| `dto-contracts.md` | 前端可用 DTO |
| `field-governance.md` | v1 白名单精简版 |
| `field-contract-map.md` | snake ↔ camel 映射 |
