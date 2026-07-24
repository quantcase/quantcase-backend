'use strict';

/**
 * DB-backed, in-memory cache of Kpi definitions (replaces the old hardcoded
 * REGISTRY population from financialEntries.a/b.js). Loaded lazily, refreshed
 * on a short TTL — no dedicated admin reload endpoint; a ~60s staleness
 * window after an admin edit is an accepted tradeoff for this tool.
 *
 * Each entry: { abbr, name, unit, description, frequency, formula_expression,
 *               ast (parsed, or null for raw), fallback_abbrs, display_order,
 *               kpi_type, denomination, raw (Kpi row) }
 */

const prisma = require('../../config/prisma');
const { parse, ExpressionError } = require('./expressionEvaluator');
const { DAILY_SERIES_FIELDS } = require('./dataFetcherMarket');

const TTL_MS = 60_000;

let _cache = null;          // Map<abbr, entry>
let _loadedAt = 0;
let _loadingPromise = null;

function _buildEntry(row) {
  let ast = null;
  if (row.formula_expression != null) {
    try {
      ast = parse(row.formula_expression);
    } catch (err) {
      // A bad formula shouldn't take down the whole registry — log and treat
      // as unresolvable (null) rather than throwing during cache load.
      // eslint-disable-next-line no-console
      console.error(`[registryCache] failed to parse formula for ${row.abbr}: ${err.message}`);
      ast = null;
    }
  }
  return {
    abbr:               row.abbr,
    name:                row.full_form,
    unit:                row.unit_label ?? null,
    description:         row.description ?? null,
    frequency:           row.frequency ?? null,
    formula_expression:  row.formula_expression ?? null,
    ast,
    fallback_abbrs:      row.fallback_abbrs ?? [],
    display_order:       row.display_order ?? 0,
    kpi_type:            row.kpi_type ?? null,
    denomination:        row.denomination ?? null,
    isRaw:               row.formula_expression == null,
  };
}

// The `kpis` table is shared with an unrelated transcript-metric-name
// dedup pipeline (scripts/dedup_kpis.js, services/kpiDedup.service.js) —
// ~23.4k rows with source:'transcript', vs. ~90 raw Prowess columns with
// source:'QE'. formulaRegistry must never load/iterate the transcript rows
// wholesale. A row is in scope here if it's a raw Prowess column (source
// 'QE') or has been given formulaRegistry-specific data (frequency /
// formula_expression) — some abbrs (e.g. EBITDA, ROE) exist in BOTH worlds:
// a transcript-dedup canonical-name row happens to share the same abbr as a
// formulaRegistry formula definition. In that case we only ever write our
// new columns (formula_expression, frequency, fallback_abbrs, unit_label,
// description, display_order) to the existing row — never `source`,
// `full_form`, `kpi_type`, etc., which the dedup pipeline owns and reads.
async function _load() {
  const kpiRows = await prisma.kpi.findMany({ where: { registry_enabled: true } });
  const map = new Map();
  for (const row of kpiRows) map.set(row.abbr, _buildEntry(row));
  _cache = map;
  _loadedAt = Date.now();
}

async function _ensureLoaded() {
  if (_cache && Date.now() - _loadedAt < TTL_MS) return;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = _load().finally(() => { _loadingPromise = null; });
  return _loadingPromise;
}

/** Warm the cache at process boot (server.js / worker.js) so the first request isn't slow. */
async function warmRegistryCache() {
  await _ensureLoaded();
}

async function getDefinition(abbr) {
  await _ensureLoaded();
  return _cache.get(abbr) ?? null;
}

/** Every registry-enabled abbr NOT backed by nse_equity_new (i.e. everything prowess_values_new might have a row for). */
// Every abbr the resolver might need to check for a *stored* value in
// prowess_values_new — not just declared-raw abbrs. Prowess itself directly
// reports some ratios Kpi otherwise treats as formula-derived (e.g. ROCE, DE,
// CR, IC via ANNUAL_OPTIONAL_COL_MAP) — resolveMetric checks "is there a
// stored value for this abbr" before falling back to computing it, for every
// abbr, matching the pre-migration REGISTRY's generic `kpiMap[entry.id] !=
// null` stored-value-wins check. One bulk query covers both cases.
//
// Daily-native membership (DAILY_SERIES_FIELDS) is a data-topology fact —
// which abbrs live in nse_equity_new — independent of Kpi.frequency, which
// is unused dead metadata now (see financial.js's top docblock).
async function getProwessRawAbbrs() {
  await _ensureLoaded();
  return [..._cache.values()]
    .filter(e => !DAILY_SERIES_FIELDS[e.abbr])
    .map(e => e.abbr);
}

/**
 * All raw-leaf abbrs sourced from nse_equity_new. Gated on isRaw as well as
 * DAILY_SERIES_FIELDS membership — an admin can give a daily-native abbr
 * (e.g. PE_DAILY) its own formula_expression, at which point the raw
 * nse_equity_new column must stop being treated as "the stored value" for
 * it, or the formula could never take effect.
 */
async function getDailyRawAbbrs() {
  await _ensureLoaded();
  return [..._cache.values()].filter(e => e.isRaw && DAILY_SERIES_FIELDS[e.abbr]).map(e => e.abbr);
}

/** Synchronous snapshot for callers that just want to list/dump the catalogue (may be empty/stale until first ensureLoaded() completes). */
function getRegistrySnapshot() {
  return _cache ? Object.fromEntries(_cache) : {};
}

/** Force-drop the cache — used by tests / scripts that write Kpi rows and need to see them immediately. */
function invalidateRegistryCache() {
  _cache = null;
  _loadedAt = 0;
}

module.exports = {
  warmRegistryCache,
  getDefinition,
  getProwessRawAbbrs,
  getDailyRawAbbrs,
  getRegistrySnapshot,
  invalidateRegistryCache,
  ExpressionError,
};
