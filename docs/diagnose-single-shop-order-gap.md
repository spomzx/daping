# 单店订单差异诊断脚本

## 用途

对比 **TikTok 平台后台单店订单数**、**OpenAPI 按市场日历日拉取**、**MySQL 入库**、**大屏 locked valid 口径**，定位「平台 131 单 vs 大屏 70 单」类差异的根因。

只读，不写库、不改 KPI contract / worker / deploy。

## 命令（在 staging 服务器执行）

```bash
cd /home/admin/daping-staging/backend

# 按租户 + 市场匹配唯一店铺
node scripts/diagnose-single-shop-order-gap.js --tenant-id=6 --market=MY --date=2026-05-25

# 已知内部 shop_id（shops.id）
node scripts/diagnose-single-shop-order-gap.js --tenant-id=6 --shop-id=31 --date=2026-05-25

# 可选：填入平台后台显示的订单数，便于归因
node scripts/diagnose-single-shop-order-gap.js --tenant-id=6 --market=MY --date=2026-05-25 --platform-orders=131
```

若 `--market=MY` 匹配到多个店铺，脚本会列出 `matched_shops` 并退出，需追加 `--shop-id`。

## 输出字段说明

| 区块 | 含义 |
|------|------|
| `matched_shop` | 诊断店铺：内部 `shop_id`、`platform_shop_id`、`shop_cipher_present` |
| `api_diagnosis` | OpenAPI `create_time_ge/lt`（市场 UTC+8/+7 自然日），分页最多 20 页 |
| `mysql_diagnosis` | 大屏事件时间窗（`paid_at` → `created_at_platform` → `created_at`）内按 `analytics_status` / `order_status` 统计 |
| `dashboard_metrics` | `--date` 对应 **custom** 日窗 + `analytics_status=valid`；含 `dashboard_live_today_valid_count`（服务器本地 today，可能与 `--date` 不同） |
| `gap_analysis.possible_reason` | 归因代码（如 `platform_all_vs_dashboard_valid`、`api_pagination_cap_possible_truncation`） |

## 常见归因对照

1. **平台全量 vs 大屏 valid**：`platform_all_vs_dashboard_valid` + MySQL `mysql_all` >> `mysql_valid`。
2. **cancelled / unpaid / sample**：看 `mysql_by_analytics_status` 与 `api_analytics_breakdown_derived`。
3. **API 分页截断**：`api_pagination_cap_hit=true`（20 页 × page_size）。
4. **入库漏单**：`api_vs_mysql_missing_count` > 0 且 sample id 在 API 不在 MySQL。
5. **时区/事件时间**：`mysql_outside_date_count` > 0 或 `create_time_in_api_window_but_event_outside_dashboard`。
6. **店铺映射错误**：API 有单但 `api_vs_mysql_missing` 且其他 shop 有同 id（看 `api_in_mysql_other_window_*`）。
7. **多店未指定 shop_id**：`ambiguous_shop_requires_shop_id`。

## 入库漏单验收（修复后）

```bash
node scripts/diagnose-order-persist-gap.js --tenant-id=6 --shop-id=28 --date=2026-05-25
node scripts/diagnose-order-persist-gap.js --tenant-id=6 --shop-id=28 --date=2026-05-25 --write
```

通过标准：`missing_orders_after_sync = 0`，且 `page_breakdown` 中每页 `persisted` 等于 `raw_orders`。

## 约束

- `diagnose-single-shop-order-gap` 默认只读；persist 修复验收用 `diagnose-order-persist-gap --write`。
- 禁止清订单、改 `orderFilter` / KPI 模块。
- Cursor 环境无 staging MySQL，验收须在服务器执行。
