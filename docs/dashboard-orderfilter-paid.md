# Dashboard orderFilter：paid 与 valid 慢点说明

## paid SQL（`mysqlOrdersFilterClause`，别名 `o`）

```sql
AND NOT (sample_predicate)
AND NOT (TRIM(o.order_status) IN (...unpaid statuses...))
AND (
  (TRIM(o.order_status) IN (...valid statuses...))
  OR (cancelled_predicate)
)
AND TRIM(COALESCE(o.order_status,'')) <> ''
```

含义：有效订单 ∪ 已取消订单，排除样品、未付款。

## valid 相对 all 更慢的原因（仅记录，未改口径）

| 维度 | all | valid |
|------|-----|-------|
| cancelled 谓词 | 无 | `NOT (cancelled_predicate)` |
| sample 谓词 | 无 | `NOT (sample_predicate)`（含 raw_json / JSON） |
| order_status | 无 | `IN (...)` 有效枚举 |

## 筛选切换

- 页面唯一 `orderFilter` 状态在 `LegacyDashboardPage`。
- 切换时 `resetDashboardQueriesForOrderFilter`：各 endpoint abort + 清空 dedupe + `filterGeneration++`。
- 子模块用 `shouldApplyDashboardFilterGeneration` 防止旧 filter 回写。
