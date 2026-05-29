# 旧 JSON 店铺源（Legacy）

| 文件 | 角色 |
|------|------|
| `backend/storage/shops.json` | 历史 token；`OPENAPI_SHOPS_SOURCE=json` 回滚 |
| `backend/storage.local.bak/shops.json` | 归档备份 |

主源：`backend/lib/readSyncShops.js` → MySQL `shops` + `shop_auth_tokens`。

导入：`node backend/scripts/importLegacyShopsJson.js --tenant_id=1`
