'use strict';

/**
 * Financial metric registry — single source of truth for every financial KPI.
 *
 * Computation types:
 *   'formula'  — single-period: compute(kpiMap) → number|null
 *   'cagr'     — time-series:  CAGR from first → last non-null value in series
 *   'average'  — time-series:  arithmetic mean over a window of periods
 *   'delta'    — two-period:   compute(currKpiMap, prevKpiMap) → number|null
 *
 * resolveMetric(id, context) is the single enforcement point for all types.
 * resolveKpi(abbr, kpiMap)   is a backward-compatible alias for 'formula' type.
 */

const REGISTRY = {};

function def(id, meta) {
  REGISTRY[id] = { id, ...meta };
}

// Bulk-register entries that don't reference REGISTRY in their compute functions
for (const e of [...require('./financialEntries.a'), ...require('./financialEntries.b')]) {
  def(e.id, e);
}

// ── Entries whose compute() references REGISTRY — registered after bulk load ──

def('EBITDA_MARGIN', {
  computationType: 'formula',
  name:    'EBITDA Margin',
  unit:    '%',
  formula: '(PBT + FIN_COST + DEP_AMORT) / REV_OP × 100',
  inputs:  ['PBT', 'FIN_COST', 'DEP_AMORT', 'REV_OP'],
  compute(m) {
    const rev    = m.REV_OP ?? m.TOTAL_INCOME;
    const ebitda = m.EBITDA ?? REGISTRY.EBITDA.compute(m);
    if (ebitda == null || !rev) return null;
    return (ebitda / rev) * 100;
  },
});

def('EBIT_MARGIN', {
  computationType: 'formula',
  name:    'EBIT Margin / PPOP Margin',
  unit:    '%',
  formula: {
    standard: '(PBT + FIN_COST) / REV_OP × 100',
    bfsi:     '(REV_OP − EMP_EXP − OTH_EXP − DEP_AMORT) / REV_OP × 100',
  },
  inputs: {
    standard: ['PBT', 'FIN_COST', 'REV_OP'],
    bfsi:     ['REV_OP', 'EMP_EXP', 'OTH_EXP', 'DEP_AMORT'],
  },
  compute(m, context = {}) {
    const rev  = m.REV_OP ?? m.TOTAL_INCOME;
    const ebit = m.EBIT ?? REGISTRY.EBIT.compute(m, context);
    if (ebit == null || !rev) return null;
    return (ebit / rev) * 100;
  },
});

def('NET_DEBT_EBITDA', {
  computationType: 'formula',
  name:    'Net Debt / EBITDA',
  unit:    'x',
  formula: 'NET_DEBT / EBITDA',
  inputs:  ['NET_DEBT', 'EBITDA'],
  compute(m) {
    const nd     = m.NET_DEBT ?? REGISTRY.NET_DEBT.compute(m);
    const ebitda = m.EBITDA   ?? REGISTRY.EBITDA.compute(m);
    if (nd == null || ebitda == null || ebitda === 0) return null;
    return nd / ebitda;
  },
});

def('CFO_EBITDA_PCT', {
  computationType: 'formula',
  name:    'CFO / EBITDA %',
  desc:    'Cash conversion quality — what fraction of EBITDA becomes operating cash flow',
  unit:    '%',
  formula: 'CFO / EBITDA × 100',
  inputs:  ['CFO', 'EBITDA'],
  compute(m) {
    const ebitda = m.EBITDA ?? REGISTRY.EBITDA.compute(m);
    if (m.CFO == null || ebitda == null || ebitda === 0) return null;
    return (m.CFO / ebitda) * 100;
  },
});

def('CASH_CONVERSION', {
  computationType: 'formula',
  name:    'Cash Conversion',
  desc:    'FCF as a percentage of PAT — measures how much reported profit converts to free cash',
  unit:    '%',
  formula: 'FCF / PAT × 100',
  inputs:  ['FCF', 'PAT'],
  compute(m, context = {}) {
    const fcf = m.FCF != null ? m.FCF : _resolveFormula(REGISTRY.FCF, m, context).value;
    if (fcf == null || m.PAT == null || m.PAT === 0) return null;
    return (fcf / m.PAT) * 100;
  },
});

// ── Resolution internals ──────────────────────────────────────────────────────

function _resolveRaw(entry, kpiMap) {
  const val = kpiMap[entry.id] ?? null;
  return {
    value:  val,
    source: val != null ? 'stored' : 'no_data',
    name:   entry.name,
  };
}

function _resolveFormula(entry, kpiMap, context = {}) {
  const { bfsi = false, prevKpiMap = null } = context;
  const stored = kpiMap[entry.id];
  if (stored != null) return { value: stored, source: 'stored' };

  const formula = entry.formula?.bfsi != null
    ? (bfsi ? entry.formula.bfsi : entry.formula.standard)
    : entry.formula;
  const inputs  = Array.isArray(entry.inputs)
    ? entry.inputs
    : (bfsi && entry.inputs.bfsi ? entry.inputs.bfsi : entry.inputs.standard);

  let resolvedMap = kpiMap;
  if (prevKpiMap) {
    const deltaDeps = inputs.filter(a => kpiMap[a] == null && REGISTRY[a]?.computationType === 'delta');
    if (deltaDeps.length) {
      resolvedMap = { ...kpiMap };
      for (const abbr of deltaDeps) {
        const depRes = _resolveDelta(REGISTRY[abbr], kpiMap, prevKpiMap);
        if (depRes.value != null) resolvedMap[abbr] = depRes.value;
      }
    }
  }

  const computed    = entry.compute(resolvedMap, context);
  const inputValues = Object.fromEntries(inputs.map(a => [a, resolvedMap[a] ?? null]));
  return {
    value:       computed,
    source:      computed != null ? 'computed' : 'computed_null',
    formula,
    inputs,
    inputValues,
    name:        entry.name,
  };
}

function _resolveCagr(entry, series, windowSize) {
  const base = { formula: entry.formula, inputs: entry.inputs, name: entry.name };
  if (!series || !series.length) return { value: null, source: 'no_data', ...base };

  const allPts = series.filter(s => s.value != null);
  if (!allPts.length) return { value: null, source: 'computed_null', ...base };

  const w   = windowSize ?? entry.defaultWindow ?? null;
  const pts = w != null ? allPts.slice(-(w + 1)) : allPts;

  const first = pts[0], last = pts.at(-1);
  const spanYears = pts.length - 1;

  if (pts.length === 1) {
    return { value: last.value, source: 'computed', ...base,
             seriesUsed: pts, spanYears: 0, window: w,
             note: 'Only one period — returning latest' };
  }
  if (first.value == null || first.value <= 0) {
    return { value: last.value, source: 'computed', ...base,
             seriesUsed: [first, last], spanYears, window: w,
             note: 'Non-positive base — returning latest' };
  }

  const cagrVal = (Math.pow(Math.abs(last.value) / first.value, 1 / spanYears) - 1)
                  * 100 * Math.sign(last.value);
  return {
    value:      parseFloat(cagrVal.toFixed(2)),
    source:     'computed',
    ...base,
    seriesUsed: [first, last],
    allPeriods: pts,
    spanYears,
    window:     w,
  };
}

function _resolveAverage(entry, series, windowSize) {
  const w    = windowSize ?? entry.defaultWindow ?? null;
  const base = { formula: entry.formula, inputs: entry.inputs, name: entry.name };
  if (!series || !series.length) return { value: null, source: 'no_data', ...base };

  const pts     = series.filter(s => s.value != null);
  const periods = w != null ? pts.slice(-w) : pts;
  if (!periods.length) return { value: null, source: 'computed_null', ...base };

  const avg = periods.reduce((s, p) => s + p.value, 0) / periods.length;
  return {
    value:      parseFloat(avg.toFixed(2)),
    source:     'computed',
    ...base,
    periods,
    windowSize: periods.length,
  };
}

function _resolveDelta(entry, kpiMap, prevKpiMap) {
  const base = { formula: entry.formula, inputs: entry.inputs, name: entry.name };
  const stored = kpiMap[entry.id];
  if (stored != null) return { value: stored, source: 'stored' };
  if (!prevKpiMap) return { value: null, source: 'no_data', ...base };

  const computed = entry.compute(kpiMap, prevKpiMap);

  const inputValues = {};
  for (const abbr of entry.inputs) {
    const c = kpiMap[abbr]     ?? null;
    const p = prevKpiMap[abbr] ?? null;
    inputValues[abbr] = { curr: c, prev: p, delta: c != null && p != null ? c - p : null };
  }

  return {
    value:       computed,
    source:      computed != null ? 'computed' : 'computed_null',
    ...base,
    inputValues,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

function resolveMetric(id, context = {}) {
  const { kpiMap = {}, prevKpiMap = null, series = null, window: windowSize = null } = context;
  const entry = REGISTRY[id];
  if (!entry) return { value: null, source: 'no_data' };

  switch (entry.computationType) {
    case 'raw':     return _resolveRaw(entry, kpiMap);
    case 'formula': return _resolveFormula(entry, kpiMap, context);
    case 'cagr':    return _resolveCagr(entry, series, windowSize);
    case 'average': return _resolveAverage(entry, series, windowSize);
    case 'delta':   return _resolveDelta(entry, kpiMap, prevKpiMap);
    default:        return { value: null, source: 'no_data' };
  }
}

function resolveKpi(abbr, kpiMap) {
  return resolveMetric(abbr, { kpiMap });
}

module.exports = { REGISTRY, resolveMetric, resolveKpi };
