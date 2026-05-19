#!/usr/bin/env bash
# Phase 2-1: 只读数据源审计（grep only，不修改任何业务文件）
# 用法: bash scripts/audit/check-data-sources.sh [项目根目录，默认为脚本上两级]

set -u

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT" || exit 1

echo "=============================================="
echo " Phase 2-1 Data Source Audit (read-only grep)"
echo " Root: $ROOT"
echo " Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)"
echo "=============================================="
echo

# 排除第三方与构建产物
EXCLUDE_DIRS='node_modules|dist|\.git|storage\.local\.bak'
GREP_OPTS=(--color=never -rIn
  --exclude-dir=node_modules
  --exclude-dir=dist
  --exclude-dir=.git
)

# 关键词 -> 分类
declare -A KEYWORDS
KEYWORDS=(
  ["orders-cache"]="legacy_cache"
  ["gmv-cache"]="legacy_cache"
  ["orders-cache.json"]="legacy_cache"
  ["gmv-cache.json"]="legacy_cache"
  ["dashboard.db"]="sqlite"
  ["better-sqlite3"]="sqlite"
  ["sqlite"]="sqlite"
  ["fs.readFile"]="filesystem"
  ["fs.writeFile"]="filesystem"
  ["readJsonSafe"]="filesystem"
  ["storage/"]="storage_path"
  ["shops.json"]="legacy_shops_json"
  ["orders.json"]="legacy_json"
  ["gmv.json"]="legacy_json"
  ["sync-status"]="sync_misc"
  ["exchange-rate"]="exchange_rate"
  ["exchange_rates"]="mysql_exchange"
  ["legacy"]="legacy_marker"
  ["fallback"]="fallback_marker"
  ["DASHBOARD_DATA_SOURCE"]="env_toggle"
  ["isMysqlPrimaryDashboard"]="mysql_primary_toggle"
  ["OPENAPI_SHOPS_SOURCE"]="env_toggle"
  ["tiktokOrders_"]="legacy_per_shop_json"
  ["data/dashboard.db"]="sqlite"
  ["dataSources/mock"]="mock_data"
)

section() {
  echo
  echo "----------------------------------------------"
  echo " [$1] $2"
  echo "----------------------------------------------"
}

for kw in "${!KEYWORDS[@]}"; do
  cat="${KEYWORDS[$kw]}"
  section "$cat" "keyword: $kw"
  # shellcheck disable=SC2068
  hits=$(grep "${GREP_OPTS[@]}" -E "${kw}" backend frontend scripts docs 2>/dev/null \
    | grep -Ev "/(${EXCLUDE_DIRS})/" \
    | grep -Ev "node_modules|frontend/dist/" \
    | head -n 80)
  if [ -z "$hits" ]; then
    echo "  (no hits in backend/frontend/scripts/docs)"
  else
    echo "$hits" | while IFS= read -r line; do
      echo "  $line"
    done
    total=$(grep "${GREP_OPTS[@]}" -E "${kw}" backend frontend scripts docs 2>/dev/null \
      | grep -Ev "/(${EXCLUDE_DIRS})/" \
      | grep -Ev "node_modules|frontend/dist/" \
      | wc -l | tr -d ' ')
    if [ "${total:-0}" -gt 80 ] 2>/dev/null; then
      echo "  ... truncated (total ~$total lines; showing first 80)"
    fi
  fi
done

section "summary" "Hit counts by category (backend + frontend/src + scripts, no node_modules)"
for cat in legacy_cache sqlite filesystem legacy_shops_json legacy_json sync_misc exchange_rate mysql_exchange legacy_marker fallback_marker env_toggle mysql_primary_toggle mock_data legacy_per_shop_json storage_path; do
  count=0
  for kw in "${!KEYWORDS[@]}"; do
  if [ "${KEYWORDS[$kw]}" = "$cat" ]; then
    c=$(grep "${GREP_OPTS[@]}" -E "${kw}" backend frontend/src scripts 2>/dev/null \
      | grep -Ev "node_modules|/dist/" | wc -l | tr -d ' ')
    count=$((count + c))
  fi
  done
  echo "  $cat: $count"
done

echo
echo "=============================================="
echo " Done. See docs/audit/phase2-data-source-audit.md"
echo "=============================================="
