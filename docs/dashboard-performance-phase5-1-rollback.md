# Phase-5.1 Rollback

## 代码 rollback

回到 Phase-4.2 锁版本（不含 Phase-5.1 dashboard 优化）：

```bash
git fetch origin
git checkout staging-sync-stability-phase2-validated-v1
# 或：git revert <phase5-1-commit-hash>

cd frontend && npm run build
pm2 restart daping-staging --update-env
```

## 环境（保持）

```env
SYNC_WORKER_CONCURRENCY=1
SYNC_WORKER_ENABLED=1
SYNC_USE_QUEUE_ONLY=1
```

## 索引 rollback（仅列出，不自动执行）

若在 staging 已执行 `dashboard-phase5-1.sql`，可按需 **手工** DROP（prod 未执行则跳过）：

```sql
-- 执行前请确认库名与索引名（SHOW INDEX FROM orders;）
DROP INDEX idx_orders_p51_tenant_status_market_shop_time ON orders;
DROP INDEX idx_orders_p51_tenant_event_time ON orders;
DROP INDEX idx_orders_p51_tenant_market_shop ON orders;
DROP INDEX idx_order_items_p51_tenant_shop_market_order ON order_items;
DROP INDEX idx_order_items_p51_tenant_product_sku ON order_items;
```

**警告**：DROP 索引可能影响其他查询计划；仅在确认 Phase-5.1 索引导致问题时操作。

## 行为回退说明

| Phase-5.1 变更 | 回退后 |
|----------------|--------|
| gmv-compare 去重 / day 跳过 fetch | 恢复双次扫表（更慢） |
| orders 3s in-flight | 恢复每请求独立查询 |
| warmup 并发 1 + busy 跳过 | 恢复旧 warmup 并发（若旧代码读取 env） |
