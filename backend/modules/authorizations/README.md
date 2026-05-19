# Authorizations 模块（占位）

授权数据在 MySQL：

- `shop_auth_tokens` — access_token、refresh_token、raw_auth_json.shop_cipher
- `shops.auth_status`、`shops.last_authorized_at`

OAuth 流程：`server.js` `/api/tiktok/auth/*` + `modules/shops/oauthMysqlPersist.js`

**阶段五目标**：独立「授权明细」API + 前端页，统一命名，不读 shops.json。
