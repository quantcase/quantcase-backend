'use strict';

const prisma = require('../config/prisma');

// Which ScreenConfig actually applies for a given company: a company-group-
// scoped variant (ScreenConfig.variant_of_key === configKey, e.g. a
// BFSI-only P&L or chart group with its own rows/items) if the company is a
// member of that variant's company_group_slug, else the base config itself.
// This is the explicit, admin-authored replacement for the old silent
// KpiRelationship 'variant_for_group' formula swap — a company in the group
// gets a whole separate, visible config, not a hidden per-row substitution.
// Shared by lib/financials.js (P&L/Balance Sheet/Cash Flow tables) and
// controllers/prowess.controller.js (chart groups) — same resolution rule
// either way. Multiple variants for the same configKey are allowed; the
// first whose group the company belongs to wins, so admin ordering of
// variant creation matters if groups ever overlap (same accepted convention
// as services/companyGroups/resolver.js#resolveConfigKeyForTicker).
//
// `options` is passed straight through to both the variants findMany and the
// base findUnique — e.g. { include: { items: {...} } } for item-based
// (chart/peer) configs; omitted for kpi_group_slug-based (table) configs.
async function resolveScreenConfig(configKey, resCtx, options = {}) {
  const variants = await prisma.screenConfig.findMany({ where: { variant_of_key: configKey }, ...options });
  for (const variant of variants) {
    if (variant.company_group_slug && await resCtx.isCompanyInGroup(variant.company_group_slug)) {
      return variant;
    }
  }
  return prisma.screenConfig.findUnique({ where: { key: configKey }, ...options });
}

module.exports = { resolveScreenConfig };
