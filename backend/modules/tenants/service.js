'use strict';

const planSvc = require('./planService');
const { parseListQuery, validatePatchBody } = require('./validator');

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 */
async function getTenantById(pool, tenantId) {
  const plan = await planSvc.getTenantPlan(pool, tenantId);
  return plan;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {Record<string, unknown>} rawQuery
 */
async function listTenants(pool, rawQuery = {}) {
  const query = parseListQuery(rawQuery);
  return planSvc.listTenantsPaged(pool, query);
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {Record<string, unknown>} body
 * @param {number | null} updatedBy
 */
async function updateTenant(pool, tenantId, body, updatedBy = null) {
  const validated = validatePatchBody(body);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error };
  }
  return planSvc.updateTenantPlan(pool, tenantId, validated.patch, {
    updated_by: updatedBy,
  });
}

module.exports = { getTenantById, listTenants, updateTenant };
