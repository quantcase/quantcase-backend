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
 *   2. Raw leaf (formula_expression null) → resolutionContext.getCurrentValue.
 *      Formula (formula_expression set) → expressionEvaluator.evaluate,
 *      recursing back into resolveMetric for every referenced abbr.
 *   3. Fallback chain (Kpi.fallback_abbrs) — first non-null wins.
 *
 * Frequency is ALWAYS explicit and caller-supplied (opts.frequency, or
 * resCtx.frequency for a context created with one) — there is no per-Kpi
 * pin and no implicit default anywhere in this file. A Kpi's own
 * `frequency` column (prisma/schema.prisma) is unused dead metadata as of
 * 2026-07-24: it used to silently force a formula (and everything it
 * referenced) onto a fixed cadence regardless of what the caller asked for
 * — removed because that silent override produced real wrong numbers (e.g.
 * TTM_EPS's `SUM(EPS_BASIC, 4)` summing 4 YEARS of annual EPS instead of 4
 * quarters, whenever an unpinned parent formula defaulted to 'annual' and
 * force-passed that down onto TTM_EPS's own pin-in-name-only). If neither
 * opts.frequency nor resCtx.frequency is supplied, that's a caller bug —
 * resolveMetric/resolveFormulaSeries return null rather than guessing.
 * Every screener section now gets its frequency from ScreenConfig.frequency
 * (see lib/financials.js/prowess.controller.js), and the admin preview
 * endpoint requires an explicit `?frequency=` query param.
 *
 * No abbr is ever silently substituted for another based on company group —
 * a company-group-scoped variant (e.g. a BFSI-specific formula) is a
 * different admin-authored Kpi entirely, referenced explicitly by its own
 * ScreenConfig/KpiGroup (see ScreenConfig.variant_of_key in
 * prisma/schema.prisma, resolved by lib/screenConfigResolver.js#resolveScreenConfig).
 */

const { evaluate, collectReferences } = require('./expressionEvaluator');
const { getDefinition, getRegistrySnapshot } = require('./registryCache');
const { cagrFromSeries, averageFromSeries, sumFromSeries } = require('./math');

/**
 * Point-in-time resolution of an abbr at a specific historical period index
 * within a whole-registry raw series map (every raw abbr's array padded to
 * the same period list, see resolutionContext.getSeriesMap). Used so
 * CAGR()/AVG()/SUM() can aggregate a *formula*-derived value across history
 * (e.g. ROCE_3Y_AVG averaging ROCE, itself a formula), not just a raw abbr's
 * own stored series.
 *
 * Deliberately narrower than the main async resolveMetric: plain arithmetic
 * over bare refs / raw-with-fallback chains, plus CAGR/SUM/AVG windowed over
 * the SAME seriesMap/index space as the outer walk — correct with no date-
 * alignment logic needed, because the referenced abbr's own history at each
 * index k comes from this same per-frequency period list (including
 * daily-native abbrs like PRICE/MCAP_SNAPSHOT, which resolutionContext.js's
 * getProwessSeriesMap now resamples onto that exact list too — or, for a
 * purely daily seriesMap like SMA_20's, k is just "the k-th trading day",
 * no resampling involved at all). DELTA remains unsupported mid-walk — no
 * current formula needs it here, and still resolves to null at that index
 * rather than throwing, same as before.
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
        if (fnName !== 'CAGR' && fnName !== 'SUM' && fnName !== 'AVG') return null;
        const points = [];
        for (let k = 0; k <= i; k++) {
          points.push({ value: await _resolveAtIndex(refAbbr, seriesMap, k, nextVisiting) });
        }
        if (fnName === 'CAGR') return cagrFromSeries(points, window);
        if (fnName === 'AVG')  return averageFromSeries(points, window);
        return sumFromSeries(points, window);
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
 * new capability. Supports plain arithmetic over bare refs / raw-with-
 * fallback chains, plus CAGR/SUM/AVG mid-walk (see _resolveAtIndex's own
 * docs) — DELTA still resolves to null at every index. That's a deliberate
 * limit, not a bug: DELTA needs a true previous-period lookup, which this
 * intentionally does not attempt — see resolveFormulaSeries's callers for
 * how that's handled (raw-ingested series instead, not engine work).
 *
 * @param {string} abbr
 * @param {import('./resolutionContext').ResolutionContext} resCtx
 * @param {object} [opts]
 * @param {string} [opts.frequency] — which seriesMap to walk; required (via this or resCtx.frequency)
 * @returns {Promise<Array<number|null>>} one value per period, aligned to getSeriesMap's period list; [] if no frequency was supplied
 */
async function resolveFormulaSeries(abbr, resCtx, opts = {}) {
  const def = await getDefinition(abbr);
  if (!def) return [];

  // Frequency is always caller-supplied — no Kpi-pin/'annual' default to
  // fall back on (see this file's top docblock). A caller that supplies
  // neither has a bug; return an empty series rather than guessing one.
  const freq = opts.frequency ?? resCtx.frequency;
  if (!freq) return [];
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
    // The formula being evaluated (`freq`, always an explicit, already-
    // decided value — resolveMetric never reaches here otherwise) applies
    // uniformly to every reference inside it, aggregate or not — there is no
    // per-abbr pin to consult anymore (see this file's top docblock). This is
    // what lets e.g. CAGR(PRICE, 3) at 'annual' actually resample PRICE to
    // annual instead of being stuck at some fixed cadence of its own.
    resolveAggregate: async (fnName, refAbbr, window) => {
      const points = await _seriesForAggregate(refAbbr, freq, resCtx);
      if (fnName === 'CAGR') return cagrFromSeries(points, window);
      if (fnName === 'AVG')  return averageFromSeries(points, window);
      if (fnName === 'SUM')  return sumFromSeries(points, window);
      return null;
    },
    resolveDelta: async (refAbbr) => {
      const { curr, prev } = await resCtx.getCurrentAndPrevious(refAbbr, freq);
      return curr != null && prev != null ? curr - prev : null;
    },
  });
  return { value, period: _latestPeriod(periods) };
}

/**
 * @param {string} abbr
 * @param {import('./resolutionContext').ResolutionContext} resCtx
 * @param {object} [opts]
 * @param {string} [opts.frequency] — required (via this or resCtx.frequency); overrides resCtx.frequency for this call (used internally for recursion)
 * @param {Set<string>} [opts._visiting] — internal cycle guard
 * @returns {Promise<{ value: number|null, source: string, [fallbackAbbr]: string, period: ({frequency, fiscal_year, quarter}|{frequency: 'daily', date}|null) }>}
 */
async function resolveMetric(abbr, resCtx, opts = {}) {
  const def = await getDefinition(abbr);
  if (!def) return { value: null, source: 'no_data' };

  // Frequency is always caller-supplied — no Kpi-pin/'annual' default (see
  // this file's top docblock). A caller that supplies neither has a bug;
  // null is the correct, non-glitchy answer rather than guessing one.
  const freq = opts.frequency ?? resCtx.frequency;
  if (!freq) return { value: null, source: 'frequency_required' };

  const visiting = opts._visiting ?? new Set();
  if (visiting.has(abbr)) return { value: null, source: 'cycle_detected' };
  const nextVisiting = new Set(visiting);
  nextVisiting.add(abbr);

  let result;

  if (def.isRaw) {
    // No formula_expression at all -- the only possible source is whatever
    // Prowess directly reported for this abbr. Formula-having abbrs never
    // fall into this branch, even if Prowess ALSO reports a raw value for
    // the same abbr (e.g. DE, alongside its BORR_TOTAL/NET_WORTH formula) --
    // admin's formula is an explicit, deliberate choice and always wins once
    // set; it's never silently overridden by a stored value. Matches
    // _resolveAtIndex's isRaw-gated logic exactly, so a series (screener
    // tables) and a single current-value lookup (admin preview) can never
    // disagree about which one an abbr resolves through.
    const storedValue = await resCtx.getCurrentValue(abbr, freq);
    result = storedValue != null
      ? { value: storedValue, source: 'stored', period: await resCtx.getCurrentPeriod(abbr, freq) }
      : { value: null, source: 'no_data' };
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

/** 'C'/'S'/null (from resCtx.getSourceType) -> the human label an admin actually wants to see. */
function _sourceTypeLabel(code) {
  if (code === 'C') return 'consolidated';
  if (code === 'S') return 'standalone';
  return null;
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
 * Also surfaces `source_type` ('consolidated'/'standalone'/null) — every raw
 * Prowess-backed abbr for a given company+frequency comes from the SAME
 * prowess_values_new source_type (fetchAnnualBatch/fetchQuarterlyBatch decide
 * this once per company, not per abbr — see dataFetcherCore.js), so this is a
 * single company/frequency-level fact, not a per-value one. It's null for
 * daily-native abbrs (PRICE/PE_DAILY/MCAP_SNAPSHOT, backed by nse_equity_new,
 * not prowess_values_new) and whenever the company has no data at all for
 * that frequency. This is purely a "which one did I actually get" readout —
 * admin still can't choose standalone vs consolidated; today's resolver
 * always prefers consolidated, falling back to standalone only when a
 * company has zero consolidated rows.
 *
 * `resCtx.frequency` is required (the caller — admin.kpis.service.js's
 * previewKpi — must have been given an explicit `?frequency=`; there is no
 * per-Kpi pin or 'annual' default to fall back on, see this file's top
 * docblock). Every reference in the trace resolves at that SAME frequency,
 * not each abbr's own — matching exactly how resolveMetric evaluates the
 * real formula, so the trace never shows a different number than what the
 * top-level value was actually built from.
 *
 * @param {string} abbr
 * @param {import('./resolutionContext').ResolutionContext} resCtx
 */
async function previewMetric(abbr, resCtx) {
  const def = await getDefinition(abbr);
  if (!def) return { abbr, value: null, source: 'no_data', source_type: null, formula_expression: null, frequency: null, period: null, trace: [] };

  const freq = resCtx.frequency;
  if (!freq) return { abbr, value: null, source: 'frequency_required', source_type: null, formula_expression: def.formula_expression, frequency: null, period: null, trace: [] };

  const result = await resolveMetric(abbr, resCtx);
  const sourceType = _sourceTypeLabel(await resCtx.getSourceType?.(freq) ?? null);

  const trace = [];
  if (def.ast) {
    for (const refAbbr of collectReferences(def.ast)) {
      const r = await resolveMetric(refAbbr, resCtx);
      const refSourceType = _sourceTypeLabel(await resCtx.getSourceType?.(freq) ?? null);
      trace.push({ abbr: refAbbr, value: r.value, source: r.source, source_type: refSourceType, fallbackAbbr: r.fallbackAbbr ?? null, period: r.period ?? null });
    }
  }

  return {
    abbr,
    value: result.value,
    source: result.source,
    source_type: sourceType,
    fallbackAbbr: result.fallbackAbbr ?? null,
    // For 'computed' this is the most-recent period among the formula's
    // direct references (see _latestPeriod) — a reasonable "as of" for
    // display, not a guarantee every term landed on that same period.
    period: result.period ?? null,
    formula_expression: def.formula_expression,
    // The frequency this preview actually resolved at (caller-supplied) —
    // not a Kpi-level pin, since there is no such thing anymore.
    frequency: freq,
    trace,
  };
}

module.exports = { resolveMetric, previewMetric, resolveFormulaSeries, getRegistrySnapshot };
