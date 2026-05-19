'use strict';

const PLAN_TYPES = ['basic', 'enterprise', 'custom'];

const PLAN_PRESETS = {
  basic: { shop_limit: 10, max_users: 3 },
  enterprise: { shop_limit: 20, max_users: 10 },
};

const PLAN_TYPE_LABELS = {
  basic: '基础版',
  enterprise: '企业版',
  custom: '自定义版',
};

/**
 * @param {unknown} v
 * @returns {'basic'|'enterprise'|'custom'}
 */
function normalizePlanType(v) {
  const t = String(v ?? 'basic')
    .trim()
    .toLowerCase();
  if (t === 'enterprise') return 'enterprise';
  if (t === 'custom') return 'custom';
  if (t === 'basic') return 'basic';
  return 'basic';
}

/**
 * @param {'basic'|'enterprise'|'custom'} planType
 */
function planTypeHasPreset(planType) {
  return planType === 'basic' || planType === 'enterprise';
}

/**
 * @param {'basic'|'enterprise'|'custom'} planType
 */
function getPlanPreset(planType) {
  if (planType === 'enterprise') return PLAN_PRESETS.enterprise;
  if (planType === 'basic') return PLAN_PRESETS.basic;
  return null;
}

module.exports = {
  PLAN_TYPES,
  PLAN_PRESETS,
  PLAN_TYPE_LABELS,
  normalizePlanType,
  planTypeHasPreset,
  getPlanPreset,
};
