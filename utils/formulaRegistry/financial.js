'use strict';

/**
 * Financial metric resolver — single source of truth for every financial KPI,
 * DB-driven (Kpi + KpiRelationship tables, see prisma/schema.prisma) instead
 * of hardcoded compute() functions. See utils/formulaRegistry/registryCache.js
 * for how definitions are loaded/cached, and expressionEvaluator.js for the
 * formula grammar (arithmetic + CAGR/AVG/SUM/DELTA/MAX/MIN).
 *
 * resolveMetric(abbr, ctx) is the single enforcement point for all metrics —
 * async, self-fetching (via a resolutionContext, see resolutionContext.js).
 *
 * Resolution order per abbr:
 *   1. Cycle guard (a formula referencing itself, directly or transitively).
 *   2. Company-group variant override (KpiRelationship relationship_type
 *      'variant_for_group') — e.g. BFSI companies resolve a different abbr
 *      entirely for EBIT/EBIT_MARGIN/FCF.
 *   3. Raw leaf (formula_expression null) → resolutionContext.getCurrentValue.
 *      Formula (formula_expression set) → expressionEvaluator.evaluate,
 *      recursing back into resolveMetric for every referenced abbr.
 *   4. Fallback chain (Kpi.fallback_abbrs) — first non-null wins.
 *
 * A Kpi's own `frequency` (if set) is fixed and overrides the calling
 * context's frequency for that definition and everything it references —
 * this is what lets e.g. a TTM_* metric always resolve at quarterly
 * granularity regardless of whether the caller is building an annual or
 * quarterly view. Definitions with frequency == null inherit the caller's
 * requested frequency.
 */

const { evaluate, collectReferences } = require('./expressionEvaluator');
const { getDefinition, getRelationships, getRegistrySnapshot } = require('./registryCache');
const { cagrFromSeries, averageFromSeries, sumFromSeries } = require('./math');

async function _resolveVariantOverride(abbr, resCtx) {
  const rels = await getRelationships(abbr, 'variant_for_group');
  for (const rel of rels.sort((a, b) => a.display_order - b.display_order)) {
    if (!rel.company_group_slug || !rel.related_kpi_abbr) continue;
    if (await resCtx.isCompanyInGroup(rel.company_group_slug)) return rel.related_kpi_abbr;
  }
  return null;
}

/**
 * Point-in-time resolution of an abbr at a specific historical period index
 * within a whole-registry raw series map (every raw abbr's array padded to
 * the same period list, see resolutionContext.getSeriesMap). Used so
 * CAGR()/AVG()/SUM() can aggregate a *formula*-derived value across history
 * (e.g. ROCE_3Y_AVG averaging ROCE, itself a formula), not just a raw abbr's
 * own stored series.
 *
 * Deliberately narrower than the main async resolveMetric: plain arithmetic
 * over bare refs / raw-with-fallback chains, plus CAGR/SUM (only) windowed
 * over the SAME seriesMap/index space as the outer walk — correct with no
 * date-alignment logic needed, because the referenced abbr's own history at
 * each index k comes from this same per-frequency period list (including
 * daily-native abbrs like PRICE/MCAP_SNAPSHOT, which resolutionContext.js's
 * getProwessSeriesMap now resamples onto that exact list too). AVG/DELTA
 * remain unsupported mid-walk — no current formula needs them here, and
 * still resolve to null at that index rather than throwing, same as before.
 */
async function _resolveAtIndex(abbr, seriesMap, i, visiting) {
  if (visiting.has(abbr)) return null;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(abbr);

  const def = await getDefinition(abbr);
  if (!def) return null;

  let value;
  if (def.isRaw) {
    value = seriesMap[abbr]?.[i]?.value ?? null;
  } else if (!def.ast) {
    value = null;
  } else {
    value = await evaluate(def.ast, {
      resolveRef:       (refAbbr) => _resolveAtIndex(refAbbr, seriesMap, i, nextVisiting),
      resolveAggregate: async (fnName, refAbbr, window) => {
        if (fnName !== 'CAGR' && fnName !== 'SUM') return null;
        const points = [];
        for (let k = 0; k <= i; k++) {
          points.push({ value: await _resolveAtIndex(refAbbr, seriesMap, k, nextVisiting) });
        }
        return fnName === 'CAGR' ? cagrFromSeries(points, window) : sumFromSeries(points, window);
      },
      resolveDelta: async () => null,
    });
  }

  if (value == null && def.fallback_abbrs?.length) {
    for (const fbAbbr of def.fallback_abbrs) {
      const fb = await _resolveAtIndex(fbAbbr, seriesMap, i, nextVisiting);
      if (fb != null) return fb;
    }
  }
  return value;
}

/**
 * Historical series of a Kpi's value, one entry per period in
 * resCtx.getSeriesMap(freq), via the existing (unmodified) _resolveAtIndex —
 * a plain export of internal machinery _seriesForAggregate already uses, not
 * new capability. Only supports plain arithmetic over bare refs / raw-with-
 * fallback chains at each index (see _resolveAtIndex's own docs) — any
 * formula that needs CAGR/AVG/SUM/DELTA mid-walk resolves to null at every
 * index, same as _resolveAtIndex always has. That's a deliberate limit, not
 * a bug: a historical trend of an aggregate-based formula needs the
 * aggregate's own inputs resampled into the same period index, which this
 * intentionally does not attempt — see resolveFormulaSeries's callers for
 * how that's handled (raw-ingested series instead, not engine work).
 *
 * @param {string} abbr
 * @param {import('./resolutionContext').ResolutionContext} resCtx
 * @param {object} [opts]
 * @param {string} [opts.frequency] — which seriesMap to walk; defaults to resCtx.frequency
 * @returns {Promise<Array<number|null>>} one value per period, aligned to getSeriesMap's period list
 */
async function resolveFormulaSeries(abbr, resCtx, opts = {}) {
  const def = await getDefinition(abbr);
  if (!def) return [];

  // Caller intent (opts.frequency, then resCtx.frequency if the caller set
  // one at context-creation time) outranks the Kpi's own pinned frequency —
  // the pin is only a fallback DEFAULT for callers that don't say, not a
  // silent override of an explicit request (this is what makes e.g. the
  // admin preview's ?frequency= param actually take effect for a pinned
  // abbr like PRICE, instead of being unconditionally ignored).
  const freq = opts.frequency ?? resCtx.frequency ?? def.frequency ?? 'annual';
  const seriesMap = await resCtx.getSeriesMap(freq);
  const anyAbbr = Object.keys(seriesMap)[0];
  const length = anyAbbr ? seriesMap[anyAbbr].length : 0;

  const out = [];
  for (let i = 0; i < length; i++) {
    out.push(await _resolveAtIndex(abbr, seriesMap, i, new Set()));
  }
  return out;
}

async function _seriesForAggregate(refAbbr, refFreq, resCtx) {
  // Prefer a series the context already has/was seeded with — covers both
  // raw abbrs from the self-fetching context AND a caller-provided single
  // series (createSeriesOnlyContext, used when e.g. screener.controller.js
  // has already built a formula-derived abbr's series itself, such as a
  // ROCE-per-period array for ROCE_3Y_AVG).
  const direct = await resCtx.getSeries(refAbbr, refFreq);
  if (direct.length) return direct;

  const refDef = await getDefinition(refAbbr);
  if (refDef?.isRaw) return direct; // genuinely empty raw series

  // Formula-derived abbr and the context has no pre-built series for it:
  // evaluate it at every historical period from the context's raw series map
  // (only the self-fetching resolutionContext supports this).
  const seriesMap = await resCtx.getSeriesMap(refFreq);
  const anyAbbr = Object.keys(seriesMap)[0];
  const length = anyAbbr ? seriesMap[anyAbbr].length : 0;
  const points = [];
  for (let i = 0; i < length; i++) {
    points.push({ value: await _resolveAtIndex(refAbbr, seriesMap, i, new Set()) });
  }
  return points;
}

/** Most-recent of a set of {frequency, fiscal_year, quarter|date} periods — used to give a multi-term formula a single representative "as of" period. */
function _latestPeriod(periods) {
  let best = null;
  for (const p of periods) {
    if (!p) continue;
    if (!best) { best = p; continue; }
    if (p.date != null || best.date != null) {
      if ((p.date ?? '') > (best.date ?? '')) best = p;
    } else if (p.fiscal_year > best.fiscal_year || (p.fiscal_year === best.fiscal_year && (p.quarter ?? 0) > (best.quarter ?? 0))) {
      best = p;
    }
  }
  return best;
}

async function _evaluateFormula(def, freq, resCtx, visiting) {
  const periods = [];
  const value = await evaluate(def.ast, {
    resolveRef: async (refAbbr) => {
      const r = await resolveMetric(refAbbr, resCtx, { frequency: freq, _visiting: visiting });
      if (r.period) periods.push(r.period);
      return r.value;
    },
    // refFreq: the formula being evaluated (`freq`, already resolved via
    // resolveMetric/resolveFormulaSeries's own caller-outranks-pin logic)
    // always wins over the referenced abbr's own pin here — deliberately the
    // opposite emphasis from that top-level chain, but consistent with the
    // same "explicit beats stored default" rule: `freq` at this point IS an
    // explicit, already-decided value (never absent), so a referenced abbr's
    // pin (e.g. PRICE's 'daily') never gets a chance to silently win. This is
    // what lets e.g. CAGR(PRICE, 3) at 'annual' actually resample PRICE to
    // annual instead of being stuck at its own daily pin. Safe today because
    // no existing formula's CAGR/AVG/SUM/DELTA argument references an abbr
    // that also carries its own pin (verified) — if one ever does, it now
    // inherits the outer formula's frequency, not its own.
    resolveAggregate: async (fnName, refAbbr, window) => {
      const refDef = await getDefinition(refAbbr);
      const refFreq = freq ?? refDef?.frequency;
      const points = await _seriesForAggregate(refAbbr, refFreq, resCtx);
      if (fnName === 'CAGR') return cagrFromSeries(points, window);
      if (fnName === 'AVG')  return averageFromSeries(points, window);
      if (fnName === 'SUM')  return sumFromSeries(points, window);
      return null;
    },
    resolveDelta: async (refAbbr) => {
      const refDef = await getDefinition(refAbbr);
      const refFreq = freq ?? refDef?.frequency;
      const { curr, prev } = await resCtx.getCurrentAndPrevious(refAbbr, refFreq);
      return curr != null && prev != null ? curr - prev : null;
    },
  });
  return { value, period: _latestPeriod(periods) };
}

/**
 * @param {string} abbr
 * @param {import('./resolutionContext').ResolutionContext} resCtx
 * @param {object} [opts]
 * @param {string} [opts.frequency] — overrides resCtx.frequency for this call (used internally for recursion)
 * @param {Set<string>} [opts._visiting] — internal cycle guard
 * @returns {Promise<{ value: number|null, source: string, [fallbackAbbr]: string, period: ({frequency, fiscal_year, quarter}|{frequency: 'daily', date}|null) }>}
 */
async function resolveMetric(abbr, resCtx, opts = {}) {
  const def = await getDefinition(abbr);
  if (!def) return { value: null, source: 'no_data' };

  // Explicit caller intent outranks the Kpi's own pinned frequency — the pin
  // is a fallback default for callers that don't say, not a silent override
  // of a request (see resolveFormulaSeries's identical chain for the full
  // rationale).
  const freq = opts.frequency ?? resCtx.frequency ?? def.frequency ?? 'annual';

  const visiting = opts._visiting ?? new Set();
  if (visiting.has(abbr)) return { value: null, source: 'cycle_detected' };
  const nextVisiting = new Set(visiting);
  nextVisiting.add(abbr);

  let result;

  const variantAbbr = await _resolveVariantOverride(abbr, resCtx);
  const storedValue = variantAbbr && variantAbbr !== abbr ? null : await resCtx.getCurrentValue(abbr, freq);

  if (variantAbbr && variantAbbr !== abbr) {
    result = await resolveMetric(variantAbbr, resCtx, { frequency: freq, _visiting: nextVisiting });
  } else if (storedValue != null) {
    // Stored-value-wins, for raw AND formula-type abbrs alike — Prowess
    // itself directly reports some ratios (ROCE, DE, CR, IC, ...) that Kpi
    // otherwise treats as formula-derived; a stored value always pre-empts
    // computing one, matching the pre-migration REGISTRY's behavior.
    result = { value: storedValue, source: 'stored', period: await resCtx.getCurrentPeriod(abbr, freq) };
  } else if (def.isRaw) {
    result = { value: null, source: 'no_data' };
  } else if (!def.ast) {
    // formula_expression set but failed to parse at cache-load time, or a
    // purely organizational "header" Kpi (no formula, no raw data — e.g. a
    // statement_of grouping root) with nothing to resolve.
    result = { value: null, source: 'no_data' };
  } else {
    const { value, period } = await _evaluateFormula(def, freq, resCtx, nextVisiting);
    result = { value, source: value != null ? 'computed' : 'computed_null', period: value != null ? period : null };
  }

  if (result.value == null && def.fallback_abbrs?.length) {
    for (const fbAbbr of def.fallback_abbrs) {
      const fb = await resolveMetric(fbAbbr, resCtx, { frequency: freq, _visiting: nextVisiting });
      if (fb.value != null) { result = { value: fb.value, source: 'fallback', fallbackAbbr: fbAbbr, period: fb.period ?? null }; break; }
    }
  }

  return result;
}

/**
 * Admin-facing "verify this formula" helper — resolves `abbr` exactly like
 * resolveMetric (same function, no separate code path to drift from
 * production), plus a one-level trace of each abbr directly referenced in
 * its formula_expression, so an admin can see not just the final number but
 * what it was built from. Nested formulas are not traced recursively — one
 * level is enough to sanity-check a formula; a full recursive trace would
 * turn this into a debugger rather than a quick preview.
 *
 * @param {string} abbr
 * @param {import('./resolutionContext').ResolutionContext} resCtx
 */
async function previewMetric(abbr, resCtx) {
  const def = await getDefinition(abbr);
  if (!def) return { abbr, value: null, source: 'no_data', formula_expression: null, frequency: null, period: null, trace: [] };

  const result = await resolveMetric(abbr, resCtx);

  const trace = [];
  if (def.ast) {
    for (const refAbbr of collectReferences(def.ast)) {
      const r = await resolveMetric(refAbbr, resCtx);
      trace.push({ abbr: refAbbr, value: r.value, source: r.source, fallbackAbbr: r.fallbackAbbr ?? null, period: r.period ?? null });
    }
  }

  return {
    abbr,
    value: result.value,
    source: result.source,
    fallbackAbbr: result.fallbackAbbr ?? null,
    // For 'computed' this is the most-recent period among the formula's
    // direct references (see _latestPeriod) — a reasonable "as of" for
    // display, not a guarantee every term landed on that same period.
    period: result.period ?? null,
    formula_expression: def.formula_expression,
    frequency: def.frequency,
    trace,
  };
}

module.exports = { resolveMetric, previewMetric, resolveFormulaSeries, getRegistrySnapshot };
