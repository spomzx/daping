#!/usr/bin/env node
'use strict';

/**
 * TikTok OAuth 授权 URL 参数完整性诊断
 * 用法: node scripts/diagnoseTikTokOAuthUrl.js
 */

require('../loadEnv');

const { resolveAuthorizeEndpoint } = require('../tiktok-api/authRouting');
const {
  normalizeRedirectUri,
  buildTikTokAuthorizeQueryParams,
  auditAuthorizeUrl,
  buildOAuthStateToken,
  maskAuthorizeUrl,
  EXPECTED_CALLBACK_PATH,
  DEFAULT_TIKTOK_OAUTH_SCOPES,
  resolveOAuthAuthorizeScope,
  parseScopeList,
} = require('../lib/tiktokOAuthUrl');

const STAGING_CALLBACK = 'https://stag.cqchic-cq.top/api/tiktok/auth/callback';

function buildSampleAuthorizeUrl(sellerType, market) {
  const appKey = String(process.env.TIKTOK_APP_KEY || '').trim();
  const appId = String(process.env.TIKTOK_APP_ID || '').trim();
  const redirectNorm = normalizeRedirectUri(process.env.TIKTOK_REDIRECT_URI);
  if (!redirectNorm.ok) {
    return { error: redirectNorm.error, value: redirectNorm.value };
  }
  const m = sellerType === 'local' ? market : null;
  const { authorize_host, authorize_path } = resolveAuthorizeEndpoint(sellerType, m);
  const { state, payload } = buildOAuthStateToken({
    tenantId: 1,
    userId: 1,
    sellerType,
    source: 'diagnose',
    market: m,
  });
  const query = buildTikTokAuthorizeQueryParams({
    appId: appId || 'MISSING_APP_ID',
    appKey: appKey || 'MISSING_APP_KEY',
    redirectUri: redirectNorm.value,
    state,
    market: m,
    sellerType,
  });
  const u = new URL(authorize_path, `https://${authorize_host}`);
  for (const [k, v] of query.entries()) u.searchParams.set(k, v);
  const url = u.toString();
  const audit = auditAuthorizeUrl(url, redirectNorm.value);
  return {
    seller_type: sellerType,
    market: m,
    authorize_host,
    authorize_path,
    redirect_uri: redirectNorm.value,
    state_payload: payload,
    url,
    url_masked: maskAuthorizeUrl(url),
    audit,
    query_keys: [...query.keys()],
    scope: query.get('scope') || null,
    scope_list: parseScopeList(query.get('scope') || ''),
    scope_present: Boolean(query.get('scope')),
  };
}

function printSection(title, data) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(data, null, 2));
}

function buildDiagnosis(envRaw, redirectNorm, cross, local) {
  const conclusions = [];
  const raw = String(envRaw || '').trim();
  if (/^http:\/\//i.test(raw)) {
    conclusions.push(
      'P0: TIKTOK_REDIRECT_URI 使用 http，代码已强制 https；请改为 https://stag.cqchic-cq.top/api/tiktok/auth/callback 并与 Partner 后台一致',
    );
  }
  if (!redirectNorm.ok) {
    conclusions.push(`P0: redirect_uri 无效 — ${redirectNorm.error}`);
    return conclusions;
  }
  if (redirectNorm.value !== STAGING_CALLBACK) {
    conclusions.push(
      `注意: 规范化后 callback 为 ${redirectNorm.value}，与期望 staging 地址 ${STAGING_CALLBACK} 不一致（若环境非 staging 可忽略）`,
    );
  }
  if (!process.env.TIKTOK_APP_ID || !process.env.TIKTOK_APP_KEY) {
    conclusions.push('P0: 缺少 TIKTOK_APP_ID 或 TIKTOK_APP_KEY，无法完成授权');
  }
  for (const label of ['cross_border', 'local_TH']) {
    const row = label === 'cross_border' ? cross : local;
    if (row.error) continue;
    const { audit, authorize_host } = row;
    if (audit.issues.includes('forbidden_host_globalselling')) {
      conclusions.push(`${label}: 授权 host 含 globalselling，需修复路由配置`);
    }
    if (audit.issues.length === 0 && process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_KEY) {
      conclusions.push(
        `${label}: URL 参数完整（service_id/app_key/response_type=code/redirect_uri/state）；若浏览器仍只进 Seller Center 首页且无授权确认：`,
      );
      conclusions.push('  → 优先核对 Partner 后台 Redirect URL 是否与 redirect_uri 逐字一致（HTTPS、无尾斜杠、无 query）');
      conclusions.push('  → 核对 service_id(app_id) 与 app_key 是否属于支持该 seller_type 的应用');
      if (label === 'cross_border') {
        conclusions.push('  → 跨境卖家账号是否已绑定该 Partner 应用；应用是否开通跨境授权');
      } else {
        conclusions.push('  → 本土 TH 应用与市场是否匹配；可尝试 TIKTOK_OAUTH_REDIRECT_QUERY_NAME=redirect_url（旧 Partner 链路）');
      }
      if (!row.scope_present) {
        conclusions.push('  → 授权 URL 缺少 scope；默认应带 seller.authorization.info,seller.order.info,seller.shop.info');
      } else if (row.scope_list && !row.scope_list.includes('seller.order.info')) {
        conclusions.push('  → scope 未包含 seller.order.info，授权后可能无法拉单');
      }
    }
  }
  const redirectParam = process.env.TIKTOK_OAUTH_REDIRECT_QUERY_NAME || 'redirect_uri';
  conclusions.push(`当前 OAuth redirect 查询参数名: ${redirectParam}（兼容旧链路可设 redirect_url 或 TIKTOK_OAUTH_INCLUDE_REDIRECT_URL=1）`);
  return conclusions;
}

async function main() {
  const envRaw = process.env.TIKTOK_REDIRECT_URI;
  const redirectNorm = normalizeRedirectUri(envRaw);

  printSection('环境变量', {
    TIKTOK_APP_ID_present: Boolean(String(process.env.TIKTOK_APP_ID || '').trim()),
    TIKTOK_APP_KEY_present: Boolean(String(process.env.TIKTOK_APP_KEY || '').trim()),
    TIKTOK_REDIRECT_URI_raw: envRaw || null,
    TIKTOK_OAUTH_REDIRECT_QUERY_NAME: process.env.TIKTOK_OAUTH_REDIRECT_QUERY_NAME || 'redirect_uri',
    TIKTOK_OAUTH_SCOPE: process.env.TIKTOK_OAUTH_SCOPE || null,
    TIKTOK_OAUTH_SCOPE_DISABLED: process.env.TIKTOK_OAUTH_SCOPE_DISABLED || null,
    resolved_oauth_scope: resolveOAuthAuthorizeScope(),
    default_oauth_scope: DEFAULT_TIKTOK_OAUTH_SCOPES,
    expected_staging_callback: STAGING_CALLBACK,
    expected_callback_path: EXPECTED_CALLBACK_PATH,
  });

  printSection('redirect_uri 规范化', redirectNorm);

  const cross = buildSampleAuthorizeUrl('cross_border', null);
  const local = buildSampleAuthorizeUrl('local', 'TH');

  printSection('cross_border 授权 URL', {
    ...cross,
    url: cross.url_masked || cross.url,
  });

  printSection('local TH 授权 URL', {
    ...local,
    url: local.url_masked || local.url,
  });

  const paramCheck = {
    cross_border: cross.audit?.checks,
    local_TH: local.audit?.checks,
    cross_border_issues: cross.audit?.issues,
    local_TH_issues: local.audit?.issues,
    redirect_uri_https: redirectNorm.ok && redirectNorm.https,
    env_has_http: /^http:\/\//i.test(String(envRaw || '')),
    callback_matches_env: redirectNorm.ok,
  };
  printSection('参数完整性检查', paramCheck);

  const conclusions = buildDiagnosis(envRaw, redirectNorm, cross, local);
  printSection('诊断结论', { conclusions });
}

main().catch((e) => {
  console.error('[diagnoseTikTokOAuthUrl] fatal', e);
  process.exit(1);
});
