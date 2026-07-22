'use strict';

/**
 * Admin CRUD for the `kpis` table — covers both the original Prowess
 * ingestion flow (raw indicator + prowess_name, so ProwessUploader can match
 * new CSV columns without a code deploy) and, as of the formulaRegistry
 * migration, full generic metric *computation* (formula_expression,
 * fallback_abbrs, frequency) and *relationships* (KpiRelationship — statement
 * grouping, constituent rollups, company-group-scoped variant selection).
 *
 * Every row this module creates/updates is `registry_enabled: true` — that's
 * what makes it visible to utils/formulaRegistry's resolver (see
 * registryCache.js's docblock for why that flag exists: `abbr` is a
 * namespace shared with an unrelated transcript-metric dedup pipeline).
 */

const prisma = require('../config/prisma');
const { parse, collectReferences, ExpressionError } = require('../utils/formulaRegistry/expressionEvaluator');
const { getDefinition, invalidateRegistryCache } = require('../utils/formulaRegistry/registryCache');
const { createResolutionContext } = require('../utils/formulaRegistry/resolutionContext');
const { previewMetric } = require('../utils/formulaRegistry/financial');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Parse formula_expression (if present) and confirm every referenced abbr exists. */
async function _validateExpression(abbr, formulaExpression) {
  if (formulaExpression == null) return null;
  let ast;
  try {
    ast = parse(formulaExpression);
  } catch (err) {
    if (err instanceof ExpressionError) throw new HttpError(422, `Invalid formula for "${abbr}": ${err.message}`);
    throw err;
  }
  const refs = collectReferences(ast);
  const unknown = [];
  for (const ref of refs) {
    if (ref === abbr) continue; // caught by cycle check below with a clearer message
    const exists = await prisma.kpi.findUnique({ where: { abbr: ref }, select: { abbr: true } });
    if (!exists) unknown.push(ref);
  }
  if (unknown.length) {
    throw new HttpError(422, `Formula for "${abbr}" references unknown abbr(s): ${unknown.join(', ')}`);
  }
  return ast;
}

async function _validateFallbackAbbrs(abbr, fallbackAbbrs) {
  if (!fallbackAbbrs?.length) return;
  const unknown = [];
  for (const fb of fallbackAbbrs) {
    if (fb === abbr) throw new HttpError(422, `"${abbr}" cannot list itself in fallback_abbrs.`);
    const exists = await prisma.kpi.findUnique({ where: { abbr: fb }, select: { abbr: true } });
    if (!exists) unknown.push(fb);
  }
  if (unknown.length) throw new HttpError(422, `fallback_abbrs for "${abbr}" reference unknown abbr(s): ${unknown.join(', ')}`);
}

/**
 * A CSV column can only ever feed one abbr — ProwessUploader's dynamic
 * indicator matching (prowess_mappers/ProwessUploader.js#resolveDynamicIndicators)
 * queries the kpis table by prowess_name with no ORDER BY, so if two Kpi rows
 * share a prowess_name, only one of them silently ends up wired to that CSV
 * column on any given ingestion run — no error, no unmatchedColumns warning
 * (the column *did* match, just arbitrarily), and it isn't even stable
 * across re-uploads. Block this at creation time instead of letting it
 * surface as unexplained missing data later.
 *
 * Checked against every existing Kpi regardless of `source` — the ingestion
 * query itself doesn't filter by source, so a stray transcript-pipeline row
 * with a matching prowess_name is just as much a collision as a QE one.
 */
async function _assertProwessNameNotTaken(abbr, prowessName) {
  if (!prowessName) return;
  const existing = await prisma.kpi.findFirst({
    where: { prowess_name: prowessName, abbr: { not: abbr } },
    select: { abbr: true },
  });
  if (existing) {
    throw new HttpError(
      409,
      `prowess_name "${prowessName}" is already used by Kpi "${existing.abbr}" — use that KPI instead of creating a duplicate mapping.`
    );
  }
}

/** DFS over formula_expression refs + fallback_abbrs, starting from a candidate abbr's own edges. */
async function _wouldCreateCycle(abbr, formulaExpression, fallbackAbbrs) {
  const startRefs = new Set(fallbackAbbrs ?? []);
  if (formulaExpression) {
    try { for (const r of collectReferences(parse(formulaExpression))) startRefs.add(r); }
    catch { /* parse errors are reported separately by _validateExpression */ }
  }

  const visited = new Set([abbr]);
  const stack = [...startRefs];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === abbr) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const def = await getDefinition(cur);
    if (!def) continue;
    if (def.ast) for (const r of collectReferences(def.ast)) stack.push(r);
    for (const fb of def.fallback_abbrs ?? []) stack.push(fb);
  }
  return false;
}

async function _validateNoCycle(abbr, formulaExpression, fallbackAbbrs) {
  if (await _wouldCreateCycle(abbr, formulaExpression, fallbackAbbrs)) {
    throw new HttpError(422, `"${abbr}" would create a circular reference (directly or transitively through formula_expression/fallback_abbrs).`);
  }
}

// ── Kpi CRUD ─────────────────────────────────────────────────────────────────

async function listKpis({ search, limit, includeAllSources }) {
  // Historically scoped to source:'QE' only (the Prowess-ingestion flow this
  // endpoint originally served). Now also surfaces formula-defined rows
  // regardless of source, since a handful of abbrs (EBITDA, ROE, ...)
  // intentionally keep source:'transcript' (owned by the unrelated dedup
  // pipeline) while also carrying a formulaRegistry definition — pass
  // includeAllSources to see the full registry-enabled catalogue.
  const where = {
    ...(includeAllSources ? { registry_enabled: true } : { source: 'QE' }),
    ...(search
      ? {
          OR: [
            { abbr:         { contains: search, mode: 'insensitive' } },
            { full_form:    { contains: search, mode: 'insensitive' } },
            { prowess_name: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  return prisma.kpi.findMany({
    where,
    orderBy: { abbr: 'asc' },
    take: Math.min(limit ?? 50, 200),
  });
}

async function getKpi(abbr) {
  const kpi = await prisma.kpi.findUnique({ where: { abbr } });
  if (!kpi) throw new HttpError(404, `No Kpi with abbr "${abbr}".`);
  return kpi;
}

async function createKpi({
  abbr, full_form, denomination, kpi_type, prowess_name,
  formula_expression, frequency, fallback_abbrs, unit_label, description,
}) {
  const existing = await prisma.kpi.findFirst({ where: { abbr } });
  if (existing) throw new HttpError(409, `Kpi with abbr "${abbr}" already exists.`);

  // Mirrors the `prowess_name ?? abbr` default applied below -- an
  // unspecified prowess_name still needs checking, since it silently
  // becomes `abbr` itself, which can collide with another Kpi's prowess_name.
  const effectiveProwessName = prowess_name?.trim() || abbr;
  await _assertProwessNameNotTaken(abbr, effectiveProwessName);
  await _validateExpression(abbr, formula_expression ?? null);
  await _validateFallbackAbbrs(abbr, fallback_abbrs ?? []);
  await _validateNoCycle(abbr, formula_expression ?? null, fallback_abbrs ?? []);

  const created = await prisma.kpi.create({
    data: {
      abbr,
      full_form,
      denomination: denomination ?? null,
      kpi_type: kpi_type ?? null,
      source: 'QE',
      prowess_name: effectiveProwessName,
      registry_enabled: true,
      formula_expression: formula_expression ?? null,
      frequency: frequency ?? null,
      fallback_abbrs: fallback_abbrs ?? [],
      unit_label: unit_label ?? null,
      description: description ?? null,
    },
  });
  invalidateRegistryCache();
  return created;
}

async function updateKpi(abbr, patch) {
  const existing = await prisma.kpi.findUnique({ where: { abbr } });
  if (!existing) throw new HttpError(404, `No Kpi with abbr "${abbr}".`);

  const formulaExpression = 'formula_expression' in patch ? patch.formula_expression : existing.formula_expression;
  const fallbackAbbrs     = 'fallback_abbrs'     in patch ? patch.fallback_abbrs     : existing.fallback_abbrs;

  if ('prowess_name' in patch) await _assertProwessNameNotTaken(abbr, patch.prowess_name?.trim() || null);
  await _validateExpression(abbr, formulaExpression ?? null);
  await _validateFallbackAbbrs(abbr, fallbackAbbrs ?? []);
  await _validateNoCycle(abbr, formulaExpression ?? null, fallbackAbbrs ?? []);

  const data = { registry_enabled: true };
  for (const field of [
    'full_form', 'denomination', 'kpi_type', 'prowess_name',
    'formula_expression', 'frequency', 'fallback_abbrs', 'unit_label', 'description',
  ]) {
    if (field in patch) data[field] = patch[field];
  }

  const updated = await prisma.kpi.update({ where: { abbr }, data });
  invalidateRegistryCache();
  return updated;
}

// ── Preview / formula validation (admin-facing "verify before trusting") ────

/**
 * Resolves `abbr` for a real company so admin can sanity-check a formula/fallback chain before trusting it.
 *
 * `resample_mode` is a debug-only override — lets admin compare 'average' vs
 * 'latest' for a daily-native abbr (PRICE/PE_DAILY/MCAP_SNAPSHOT) at a
 * coarser frequency without persisting anything; every abbr still resolves
 * via its fixed DAILY_RESAMPLE_MODE policy everywhere else (see
 * dataFetcherMarket.js) when this isn't passed.
 */
async function previewKpi(abbr, { symbol, frequency, resample_mode } = {}) {
  if (!symbol) throw new HttpError(422, 'symbol query param is required, e.g. ?symbol=RELIANCE');
  const kpi = await prisma.kpi.findUnique({ where: { abbr } });
  if (!kpi) throw new HttpError(404, `No Kpi with abbr "${abbr}".`);

  const ctx = createResolutionContext({
    symbol,
    ...(frequency ? { frequency } : {}),
    ...(resample_mode ? { resampleMode: resample_mode } : {}),
  });
  return previewMetric(abbr, ctx);
}

/**
 * Live syntax + reference check, meant to be called as an admin types a
 * formula (on blur/debounce) — before they've saved anything, so errors show
 * up immediately instead of only on submit. Never throws for a bad formula;
 * that's a normal "not valid yet" result, not a server error.
 */
async function validateFormula(formula_expression) {
  if (formula_expression == null || !String(formula_expression).trim()) {
    return { valid: false, error: 'Expression is empty.', referenced_abbrs: [] };
  }

  let ast;
  try {
    ast = parse(formula_expression);
  } catch (err) {
    if (err instanceof ExpressionError) return { valid: false, error: err.message, referenced_abbrs: [] };
    throw err;
  }

  const refs = collectReferences(ast);
  const referenced_abbrs = await Promise.all(refs.map(async (abbr) => {
    const row = await prisma.kpi.findUnique({ where: { abbr }, select: { full_form: true } });
    return { abbr, exists: !!row, full_form: row?.full_form ?? null };
  }));
  const unknown = referenced_abbrs.filter(r => !r.exists).map(r => r.abbr);

  return {
    valid: unknown.length === 0,
    error: unknown.length ? `Unknown abbr(s): ${unknown.join(', ')}` : null,
    referenced_abbrs,
  };
}

// ── KpiRelationship CRUD ─────────────────────────────────────────────────────

async function listRelationships(kpi_abbr, relationship_type) {
  return prisma.kpiRelationship.findMany({
    where: { kpi_abbr, ...(relationship_type ? { relationship_type } : {}) },
    orderBy: { display_order: 'asc' },
  });
}

async function createRelationship(kpi_abbr, { relationship_type, related_kpi_abbr, company_group_slug, display_order }) {
  const kpi = await prisma.kpi.findUnique({ where: { abbr: kpi_abbr } });
  if (!kpi) throw new HttpError(404, `No Kpi with abbr "${kpi_abbr}".`);

  if (related_kpi_abbr) {
    const target = await prisma.kpi.findUnique({ where: { abbr: related_kpi_abbr } });
    if (!target) throw new HttpError(422, `related_kpi_abbr "${related_kpi_abbr}" does not exist.`);
    if (related_kpi_abbr === kpi_abbr) throw new HttpError(422, `"${kpi_abbr}" cannot relate to itself.`);
  }
  if (company_group_slug) {
    const group = await prisma.companyGroup.findUnique({ where: { slug: company_group_slug } });
    if (!group) throw new HttpError(422, `company_group_slug "${company_group_slug}" does not exist.`);
  }

  const created = await prisma.kpiRelationship.create({
    data: {
      kpi_abbr, relationship_type,
      related_kpi_abbr: related_kpi_abbr ?? null,
      company_group_slug: company_group_slug ?? null,
      display_order: display_order ?? 0,
    },
  });
  invalidateRegistryCache();
  return created;
}

async function deleteRelationship(kpi_abbr, id) {
  const existing = await prisma.kpiRelationship.findUnique({ where: { id } });
  if (!existing || existing.kpi_abbr !== kpi_abbr) throw new HttpError(404, `No relationship "${id}" on "${kpi_abbr}".`);
  await prisma.kpiRelationship.delete({ where: { id } });
  invalidateRegistryCache();
}

module.exports = {
  listKpis, getKpi, createKpi, updateKpi,
  listRelationships, createRelationship, deleteRelationship,
  previewKpi, validateFormula,
  HttpError,
};
