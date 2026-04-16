'use strict';

const { cagr } = require('./finMath');

// ─── Shared helpers (mirror financial-strength-prompt.js) ─────────────────────

function _latest(series) {
  if (!Array.isArray(series)) return null;
  return series.filter(s => s.value != null).at(-1)?.value ?? null;
}

function _latestEntry(series) {
  if (!Array.isArray(series)) return null;
  return series.filter(s => s.value != null).at(-1) ?? null;
}

/**
 * Return last n entries that have non-null values, mapped to { quarter, value, fiscal_year }.
 * Quarter label: "Q2'25"
 */
function _qSeries(series, n = 10) {
  if (!Array.isArray(series)) return [];
  return series.filter(s => s.value != null).slice(-n).map(s => ({
    quarter:     `${s.quarter}'${String(s.fiscal_year ?? '').slice(-2)}`,
    value:       s.value,
    fiscal_year: s.fiscal_year,
    qLabel:      s.quarter, // raw e.g. "Q2"
  }));
}

/**
 * YoY growth (%) against same quarter of prior year.
 * Searches backwards up to 6 positions for matching quarter label.
 * Falls back to sequential prior entry if no match found.
 */
function _sameQtrYoy(series) {
  if (series.length < 2) return null;
  const curr   = series[series.length - 1];
  const qLabel = curr.quarter.split("'")[0]; // "Q2"
  for (let i = series.length - 2; i >= Math.max(0, series.length - 6); i--) {
    if (series[i].quarter.split("'")[0] === qLabel) {
      const prev = series[i].value;
      if (!prev || prev === 0) return null;
      return parseFloat(((curr.value - prev) / Math.abs(prev) * 100).toFixed(1));
    }
  }
  const prev = series[series.length - 2].value;
  if (!prev || prev === 0) return null;
  return parseFloat(((curr.value - prev) / Math.abs(prev) * 100).toFixed(1));
}

/**
 * Deep merge two objects.  `a` (local) wins on leaf conflicts; `b` fills gaps where `a` has null/undefined.
 * Arrays from `a` always win outright (no element-level merging).
 */
function deepMerge(a, b) {
  if (!a || typeof a !== 'object') return a ?? b;
  if (!b || typeof b !== 'object') return a ?? b;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && a.length ? a : b;
  const out = { ...b };
  for (const key of Object.keys(a)) {
    const av = a[key];
    const bv = b[key];
    if (av == null) {
      // keep b's value
    } else if (typeof av === 'object' && !Array.isArray(av) && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(av, bv);
    } else {
      out[key] = av;
    }
  }
  return out;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function _fmtCr(val) {
  if (val == null || isNaN(val)) return null;
  return `₹${parseFloat(val.toFixed(0)).toLocaleString('en-IN')} Cr`;
}

function _pf(val, dp = 1) {
  if (val == null || isNaN(val)) return null;
  return parseFloat(val.toFixed(dp));
}

// ─── 1. Operating Leverage ────────────────────────────────────────────────────

function computeOperatingLeverage(rawBatchAll, derivedBatchAll) {
  const revOpQ   = _qSeries(rawBatchAll?.REV_OP);
  const ebitQ    = _qSeries(derivedBatchAll?.EBIT);
  const empExpQ  = _qSeries(rawBatchAll?.EMP_EXP);
  const othExpQ  = _qSeries(rawBatchAll?.OTH_EXP);
  const depAmortQ= _qSeries(rawBatchAll?.DEP_AMORT);

  // DOL chart — compute YoY growth for each quarter vs same quarter prior year
  const dolChartData = [];
  for (let i = 1; i < revOpQ.length; i++) {
    const curr = revOpQ[i];
    const qLabel = curr.quarter.split("'")[0];
    // find same quarter in previous positions
    let prevRev = null;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (revOpQ[j].quarter.split("'")[0] === qLabel) { prevRev = revOpQ[j].value; break; }
    }
    if (!prevRev || prevRev === 0) continue;

    let prevEbit = null;
    const ebitCurr = ebitQ.find(e => e.quarter === curr.quarter);
    if (!ebitCurr) continue;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (ebitQ[j]?.quarter.split("'")[0] === qLabel) { prevEbit = ebitQ[j].value; break; }
    }
    if (!prevEbit || prevEbit === 0) continue;

    const revGrowth  = _pf((curr.value - prevRev) / Math.abs(prevRev) * 100);
    const ebitGrowth = _pf((ebitCurr.value - prevEbit) / Math.abs(prevEbit) * 100);
    const dol        = revGrowth !== 0 ? _pf(ebitGrowth / revGrowth, 2) : null;
    dolChartData.push({ quarter: curr.quarter, revenue_growth: revGrowth, ebit_growth: ebitGrowth, dol });
  }

  // Fixed cost lines (latest quarter vs prior same quarter)
  const fixedCostLines = [];
  const costItems = [
    { label: 'Employee Cost', series: empExpQ },
    { label: 'Other Expenses', series: othExpQ },
    { label: 'D&A', series: depAmortQ },
  ];
  for (const { label, series } of costItems) {
    if (!series.length || !revOpQ.length) continue;
    const latestIdx = revOpQ.length - 1;
    const latestRev = revOpQ[latestIdx]?.value;
    const latestCost = series[series.length - 1]?.value;
    if (!latestRev || latestCost == null) continue;
    const currentPct = _pf(latestCost / latestRev * 100);

    // find prior same-quarter rev and cost
    const latestQLabel = revOpQ[latestIdx].quarter.split("'")[0];
    let priorPct = null;
    for (let i = latestIdx - 1; i >= Math.max(0, latestIdx - 5); i--) {
      if (revOpQ[i].quarter.split("'")[0] === latestQLabel) {
        const priorRev  = revOpQ[i].value;
        const priorCost = series[i]?.value;
        if (priorRev && priorCost != null) {
          priorPct = _pf(priorCost / priorRev * 100);
        }
        break;
      }
    }
    const changeBps = (currentPct != null && priorPct != null)
      ? Math.round((currentPct - priorPct) * 100)
      : null;
    fixedCostLines.push({ label, current_pct: currentPct, prior_pct: priorPct, change_bps: changeBps });
  }

  // Totals
  const totalCurrentPct = fixedCostLines.reduce((s, r) => s + (r.current_pct ?? 0), 0);
  const totalPriorPct   = fixedCostLines.reduce((s, r) => s + (r.prior_pct ?? 0), 0);
  const totalChangeBps  = (totalCurrentPct && totalPriorPct)
    ? Math.round((totalCurrentPct - totalPriorPct) * 100)
    : null;

  // Revenue and EBIT YoY metrics
  const revGrowthYoy  = _sameQtrYoy(revOpQ);
  const ebitGrowthYoy = _sameQtrYoy(ebitQ);
  const leverageSpread = (revGrowthYoy != null && ebitGrowthYoy != null)
    ? _pf(ebitGrowthYoy - revGrowthYoy)
    : null;

  // Verdict
  let status = 'neutral';
  if (leverageSpread != null) {
    if (leverageSpread > 1)  status = 'positive';
    if (leverageSpread < -1) status = 'negative';
  }
  const labelMap = {
    positive: 'Positive Operating Leverage',
    neutral:  'Breakeven Operating Leverage',
    negative: 'Negative Operating Leverage',
  };
  const tagMap = {
    positive: 'EBIT growing faster than Revenue',
    neutral:  'EBIT and Revenue growing in tandem',
    negative: 'EBIT growing slower than Revenue',
  };

  const allStatuses = ['negative', 'neutral', 'positive'];
  const all_verdicts = allStatuses.map(s => ({
    status:     s,
    label:      labelMap[s],
    ...(s === status ? { is_current: true } : {}),
  }));

  return {
    fixed_cost_equation: 'Fixed Costs = Employee + D&A + Other Expenses',
    dol_chart_data: dolChartData,
    fixed_cost_lines: fixedCostLines,
    total_fixed_costs: {
      current_pct: _pf(totalCurrentPct),
      prior_pct:   _pf(totalPriorPct),
      change_bps:  totalChangeBps,
      note:        null, // LLM fills this
    },
    metrics: {
      revenue_growth_yoy: {
        label:  'Revenue Growth YoY',
        value:  revGrowthYoy != null ? `${revGrowthYoy > 0 ? '+' : ''}${revGrowthYoy}%` : 'N/A',
        change: revGrowthYoy != null ? `${revGrowthYoy > 0 ? '+' : ''}${revGrowthYoy}%` : 'N/A',
      },
      ebit_growth_yoy: {
        label:  'EBIT Growth YoY',
        value:  ebitGrowthYoy != null ? `${ebitGrowthYoy > 0 ? '+' : ''}${ebitGrowthYoy}%` : 'N/A',
        change: ebitGrowthYoy != null ? `${ebitGrowthYoy > 0 ? '+' : ''}${ebitGrowthYoy}%` : 'N/A',
      },
      leverage_spread: {
        label: 'Leverage Spread',
        value: leverageSpread != null ? `${leverageSpread > 0 ? '+' : ''}${leverageSpread}pp` : 'N/A',
      },
    },
    verdict: {
      status,
      label:       labelMap[status],
      tag:         tagMap[status],
      description: null, // LLM fills this
    },
    all_verdicts,
  };
}

// ─── 2. Free Cash Flow ────────────────────────────────────────────────────────

function computeFreeCashFlow(rawBatchAll, derivedBatchAll, bfsi, marketCap) {
  const patSeries  = (rawBatchAll?.PAT ?? []).filter(s => s.value != null);
  const fcfSeries  = (derivedBatchAll?.FCF ?? []).filter(s => s.value != null);
  const cfoSeries  = (rawBatchAll?.CFO ?? []).filter(s => s.value != null);
  const capexSeries= (derivedBatchAll?.CAPEX ?? []).filter(s => s.value != null);
  const revSeries  = (rawBatchAll?.REV_OP ?? []).filter(s => s.value != null);

  // ── conversion_consistency ──────────────────────────────────────────────────
  const HEALTHY_THRESHOLD = 80;

  // Use last 4 quarters that have PAT; FCF may be null
  const recentPat = patSeries.slice(-4);
  const quarterly_data = recentPat.map(patEntry => {
    const qLabel = `${patEntry.quarter}'${String(patEntry.fiscal_year).slice(-2)}`;
    const fcfEntry = fcfSeries.find(
      f => f.fiscal_year === patEntry.fiscal_year && f.quarter === patEntry.quarter
    );
    const fcfVal = fcfEntry?.value ?? null;
    const pct    = (fcfVal != null && patEntry.value !== 0)
      ? _pf(fcfVal / patEntry.value * 100)
      : null;
    return { quarter: qLabel, pct };
  });

  const validPcts = quarterly_data.filter(d => d.pct != null).map(d => d.pct);
  const all_above_threshold = validPcts.length > 0 && validPcts.every(p => p >= HEALTHY_THRESHOLD);
  const floorEntry = validPcts.length > 0
    ? quarterly_data.filter(d => d.pct != null).reduce((min, d) => d.pct < min.pct ? d : min)
    : null;

  // Mark floor quarter
  const quarterly_data_with_floor = quarterly_data.map(d => ({
    ...d,
    ...(floorEntry && d.quarter === floorEntry.quarter ? { is_floor: true } : {}),
  }));

  const convStatus = all_above_threshold ? 'Consistent' : (validPcts.length === 0 ? 'Insufficient Data' : 'Partial');
  const convColor  = all_above_threshold ? 'green' : (validPcts.length === 0 ? 'yellow' : 'yellow');

  // ── growth_trajectory ───────────────────────────────────────────────────────
  const q4Fcf = fcfSeries.filter(s => s.quarter === 'Q4');
  const q4Pat = patSeries.filter(s => s.quarter === 'Q4');

  let fcfCagr = null, fcfStart = 'N/A', fcfEnd = 'N/A';
  if (q4Fcf.length >= 2) {
    const first = q4Fcf.at(0), last = q4Fcf.at(-1);
    const years = last.fiscal_year - first.fiscal_year;
    if (years > 0) {
      fcfCagr = _pf(cagr(first.value, last.value, years));
      fcfStart = _fmtCr(first.value);
      fcfEnd   = _fmtCr(last.value);
    }
  }

  let patCagr = null, patStart = 'N/A', patEnd = 'N/A';
  const periods = q4Pat.length >= 2 ? String(q4Pat.length - 1) + 'Y' : 'N/A';
  if (q4Pat.length >= 2) {
    const first = q4Pat.at(0), last = q4Pat.at(-1);
    const years = last.fiscal_year - first.fiscal_year;
    if (years > 0) {
      patCagr = _pf(cagr(first.value, last.value, years));
      patStart = _fmtCr(first.value);
      patEnd   = _fmtCr(last.value);
    }
  }

  const gtStatus = fcfCagr != null
    ? (fcfCagr >= patCagr ? 'Compounding' : 'Constrained')
    : 'Constrained';
  const gtColor  = gtStatus === 'Compounding' ? 'green' : 'yellow';

  // ── ocf_to_fcf ──────────────────────────────────────────────────────────────
  const latestCfo   = _latest(rawBatchAll?.CFO);
  const latestCapex = _latest(derivedBatchAll?.CAPEX);
  const latestFcf   = _latest(derivedBatchAll?.FCF);
  const latestRev   = _latest(rawBatchAll?.REV_OP);

  // Bars relative to OCF = 100
  const ocfBarPct   = latestCfo != null ? 100 : null;
  const capexBarPct = (latestCapex != null && latestCfo && latestCfo !== 0)
    ? _pf(Math.abs(latestCapex) / Math.abs(latestCfo) * 100)
    : null;
  const fcfBarPct   = (latestFcf != null && latestCfo && latestCfo !== 0)
    ? _pf(Math.abs(latestFcf) / Math.abs(latestCfo) * 100)
    : null;

  const capexRevPct = (latestCapex != null && latestRev && latestRev !== 0)
    ? _pf(Math.abs(latestCapex) / latestRev * 100)
    : null;
  const capexOcfPct = (latestCapex != null && latestCfo && latestCfo !== 0)
    ? _pf(Math.abs(latestCapex) / Math.abs(latestCfo) * 100)
    : null;

  let ocfStatus = 'Minimal Drag', ocfColor = 'green';
  if (capexOcfPct != null) {
    if (capexOcfPct > 60) { ocfStatus = 'Heavy Drag';    ocfColor = 'red';    }
    else if (capexOcfPct > 35) { ocfStatus = 'Moderate Drag'; ocfColor = 'yellow'; }
  }

  // ── fcf_yield ───────────────────────────────────────────────────────────────
  let yield_history = [];
  if (marketCap != null && marketCap > 0) {
    const recent = fcfSeries.slice(-6);
    yield_history = recent.map(f => {
      const yld   = _pf(f.value / marketCap * 100, 2);
      let zone = 'fair';
      if (yld != null) {
        if (yld > 5)  zone = 'attractive';
        if (yld < 2)  zone = 'expensive';
      }
      return {
        quarter: `${f.quarter}'${String(f.fiscal_year).slice(-2)}`,
        yield:   yld,
        zone,
      };
    }).filter(d => d.yield != null);
  }

  const yieldStatus = yield_history.length === 0
    ? 'Insufficient Data'
    : (yield_history.at(-1)?.zone === 'attractive' ? 'Attractive' : 'Fair Value');
  const yieldColor = yield_history.length === 0 ? 'yellow'
    : (yieldStatus === 'Attractive' ? 'green' : 'yellow');

  return {
    conversion_consistency: {
      status:               convStatus,
      status_color:         convColor,
      healthy_threshold_pct: HEALTHY_THRESHOLD,
      quarterly_data:       quarterly_data_with_floor,
      range_low:            80,
      range_high:           120,
      floor_pct:            floorEntry?.pct ?? null,
      floor_quarter:        floorEntry?.quarter ?? null,
      all_above_threshold,
    },
    growth_trajectory: {
      status:           gtStatus,
      status_color:     gtColor,
      fcf_cagr_pct:    fcfCagr,
      fcf_start:       fcfStart,
      fcf_end:         fcfEnd,
      pat_cagr_pct:    patCagr,
      pat_start:       patStart,
      pat_end:         patEnd,
      periods,
      insight_headline: null, // LLM fills
      insight_body:     null, // LLM fills
    },
    ocf_to_fcf: {
      status:           ocfStatus,
      status_color:     ocfColor,
      ocf_ttm:          _fmtCr(latestCfo),
      capex:            latestCapex != null ? _fmtCr(-Math.abs(latestCapex)) : null,
      fcf_ttm:          _fmtCr(latestFcf),
      ocf_bar_pct:      ocfBarPct,
      capex_bar_pct:    capexBarPct,
      fcf_bar_pct:      fcfBarPct,
      capex_revenue_pct: capexRevPct,
      capex_ocf_pct:    capexOcfPct,
      drag_description: null, // LLM fills
    },
    fcf_yield: {
      status:                  yieldStatus,
      status_color:            yieldColor,
      yield_history,
      compression_explanation: null, // LLM fills
    },
  };
}

// ─── 3. Working Capital ───────────────────────────────────────────────────────

function computeWorkingCapital(rawBatchAll) {
  const rev    = rawBatchAll?.REV_OP      ?? [];
  const recv   = rawBatchAll?.TRADE_RECV  ?? [];
  const inv    = rawBatchAll?.INVENTORY   ?? [];
  const pay    = rawBatchAll?.TRADE_PAY   ?? [];
  const mat    = rawBatchAll?.COST_MAT    ?? [];
  const purch  = rawBatchAll?.PURCH_STOCK ?? [];
  const invChgS= rawBatchAll?.INV_CHG     ?? [];

  const n = rev.length;
  const computed = [];
  for (let i = 0; i < n; i++) {
    const r = rev[i];
    if (!r?.value) continue;
    const annRev = r.value * 4;
    const cogs   = ((mat[i]?.value ?? 0) + (purch[i]?.value ?? 0) + (invChgS[i]?.value ?? 0)) * 4;
    const rcv = recv[i]?.value, iiv = inv[i]?.value, tpv = pay[i]?.value;
    const dso = rcv != null ? _pf(rcv / annRev * 365) : null;
    const dio = iiv != null && cogs > 0 ? _pf(iiv / cogs * 365) : null;
    const dpo = tpv != null && cogs > 0 ? _pf(tpv / cogs * 365) : null;
    const ccc = (dso != null && dio != null && dpo != null) ? _pf(dso + dio - dpo) : null;
    const wc  = (rcv ?? 0) + (iiv ?? 0) - (tpv ?? 0);
    const wc_pct = r.value > 0 ? _pf(wc / r.value * 100) : null;
    computed.push({
      quarter: `${r.quarter}'${String(r.fiscal_year ?? '').slice(-2)}`,
      dso, dio, dpo, ccc, wc_pct,
    });
  }

  const rows_data = computed.slice(-6); // last 6 quarters max
  const quarters  = rows_data.map(r => r.quarter);

  const rows = [
    { key: 'dso', label: 'DSO (days)', values: rows_data.map(r => r.dso) },
    { key: 'dio', label: 'DIO (days)', values: rows_data.map(r => r.dio) },
    { key: 'dpo', label: 'DPO (days)', values: rows_data.map(r => r.dpo) },
    { key: 'ccc', label: 'CCC (days)', values: rows_data.map(r => r.ccc) },
  ];

  const trend_chart_data = rows_data.map(r => ({ quarter: r.quarter, wc_pct: r.wc_pct }));

  // Verdict from CCC trend (first vs last)
  const cccVals = rows_data.map(r => r.ccc).filter(v => v != null);
  let verdict_badge = 'Stable';
  let verdict_color = 'yellow';
  if (cccVals.length >= 2) {
    const diff = cccVals.at(-1) - cccVals.at(0);
    if (diff < -2)  { verdict_badge = 'Improving Efficiency'; verdict_color = 'green'; }
    else if (diff > 2) { verdict_badge = 'Deteriorating Efficiency'; verdict_color = 'red'; }
  }

  // Auto-generate signals
  const signals = [];
  const dsoVals = rows_data.map(r => r.dso).filter(v => v != null);
  if (dsoVals.length >= 2) {
    const dsoDiff = dsoVals.at(-1) - dsoVals.at(0);
    if (dsoDiff > 5)       signals.push({ label: 'DSO rising — watch', color: 'yellow' });
    else if (dsoDiff < -5) signals.push({ label: 'DSO improving', color: 'green' });
  }
  if (cccVals.length >= 2) {
    const cccDiff = cccVals.at(-1) - cccVals.at(0);
    if (cccDiff < -2)      signals.push({ label: 'CCC improving', color: 'green' });
    else if (cccDiff > 2)  signals.push({ label: 'CCC deteriorating', color: 'red' });
  }
  const dpoVals = rows_data.map(r => r.dpo).filter(v => v != null);
  if (dpoVals.length >= 2) {
    const dpoDiff = dpoVals.at(-1) - dpoVals.at(0);
    if (dpoDiff > 5)       signals.push({ label: 'DPO expanding (positive)', color: 'green' });
    else if (dpoDiff < -5) signals.push({ label: 'DPO compressing — watch', color: 'yellow' });
  }

  return {
    quarters,
    rows,
    trend_chart: {
      title:          'WC as % of Revenue',
      data:           trend_chart_data,
      verdict_badge,
      verdict_color,
    },
    signals,
    insight: null, // LLM fills
  };
}

// ─── 4. Capital Structure ─────────────────────────────────────────────────────

function computeCapitalStructure(rawBatchAll, derivedBatchAll) {
  // Q4-only series for annual history
  const q4Only = series => (series ?? []).filter(s => s.value != null && s.quarter === 'Q4');

  const cashQ4     = q4Only(rawBatchAll?.CASH_EQUIV);
  const debtLtQ4   = q4Only(rawBatchAll?.DEBT_LT);
  const debtStQ4   = q4Only(rawBatchAll?.DEBT_ST);
  const patQ4      = q4Only(rawBatchAll?.PAT);
  const divPayQ4   = q4Only(rawBatchAll?.DIV_PAYOUT);
  const eqCapQ4    = q4Only(rawBatchAll?.EQ_SHARE_CAP);
  const resQ4      = q4Only(rawBatchAll?.RES_SURPLUS);
  const capexQ4    = q4Only(derivedBatchAll?.CAPEX);
  const cfoQ4      = q4Only(rawBatchAll?.CFO);
  const roeDerived = (derivedBatchAll?.ROE ?? []).filter(s => s.value != null && s.quarter === 'Q4');

  const latestCash  = _latest(rawBatchAll?.CASH_EQUIV);
  const latestDebtLt= _latest(rawBatchAll?.DEBT_LT);
  const latestDebtSt= _latest(rawBatchAll?.DEBT_ST);
  const grossDebt   = (latestDebtLt ?? 0) + (latestDebtSt ?? 0);
  const netCash     = latestCash != null ? latestCash - grossDebt : null;

  // Balance sheet status
  let bsStatus = 'Leveraged', bsColor = 'red';
  if (netCash != null) {
    if (netCash > 0)           { bsStatus = 'Net Cash Company'; bsColor = 'green'; }
    else if (grossDebt < 50)   { bsStatus = 'Near-Zero Debt';  bsColor = 'green'; }
    else                        { bsStatus = 'Moderate Debt';   bsColor = 'yellow'; }
  }

  const cashBarPct = 100;
  const debtBarPct = (latestCash && latestCash > 0 && grossDebt >= 0)
    ? Math.min(100, _pf(grossDebt / latestCash * 100))
    : null;

  // Timeline from Q4 history (last 3 entries + mark latest as current)
  const timelineQ4 = cashQ4.slice(-3);
  const timeline = timelineQ4.map((entry, i) => ({
    label:      `FY${String(entry.fiscal_year).slice(-2)}`,
    value:      _fmtCr(entry.value),
    ...(i === timelineQ4.length - 1 ? { is_current: true } : {}),
  }));

  // Debt trajectory bars — Q4 annual (DEBT_LT + DEBT_ST)
  const debtYearMap = {};
  for (const entry of debtLtQ4) {
    const fy = entry.fiscal_year;
    if (!debtYearMap[fy]) debtYearMap[fy] = { lt: null, st: null };
    debtYearMap[fy].lt = entry.value;
  }
  for (const entry of debtStQ4) {
    const fy = entry.fiscal_year;
    if (!debtYearMap[fy]) debtYearMap[fy] = { lt: null, st: null };
    debtYearMap[fy].st = entry.value;
  }
  const sortedFys = Object.keys(debtYearMap).sort().slice(-4); // keep as strings to match map keys
  const debtBars = sortedFys.map((fy, i) => {
    const { lt, st } = debtYearMap[fy] ?? { lt: null, st: null };
    const total = (lt ?? 0) + (st ?? 0);
    return {
      label:      `FY${String(fy).slice(-2)}`,
      value:      _pf(total),
      is_current: i === sortedFys.length - 1,
    };
  });

  const peakBar   = debtBars.reduce((max, b) => (b.value > (max?.value ?? -Infinity) ? b : max), null);
  const currBar   = debtBars.at(-1);
  const reductionPct = (peakBar && currBar && peakBar.value > 0 && peakBar.label !== currBar.label)
    ? _pf((peakBar.value - currBar.value) / peakBar.value * 100)
    : null;

  // Debt trajectory status
  let dtStatus = 'Stable', dtColor = 'green';
  if (reductionPct != null && reductionPct > 20)  { dtStatus = 'Deleveraging';  dtColor = 'green'; }
  else if (debtBars.length >= 2) {
    const first = debtBars.at(0)?.value ?? 0;
    const last  = debtBars.at(-1)?.value ?? 0;
    if (last > first * 1.3)  { dtStatus = 'Rising Debt';    dtColor = 'red';    }
    else if (last > first * 1.1) { dtStatus = 'Gradually Rising'; dtColor = 'yellow'; }
    else if (last < first)      { dtStatus = 'Declining Debt';  dtColor = 'green';  }
    else                         { dtStatus = 'Stable Low Debt'; dtColor = 'green';  }
  }

  // Equity allocation rows — one per Q4 year
  const eqRows = [];
  const patYearMap = Object.fromEntries(patQ4.map(e => [e.fiscal_year, e.value]));
  const divYearMap = Object.fromEntries(divPayQ4.map(e => [e.fiscal_year, e.value]));
  const eqFys = patQ4.map(e => e.fiscal_year).sort().slice(-3); // string sort is fine for YYYY
  const lastEqFy = eqFys.at(-1);
  for (const fy of eqFys) {
    const pat = patYearMap[fy];
    const div = divYearMap[fy] ?? 0;
    if (!pat || pat === 0) continue;
    const paidPct  = Math.min(100, Math.max(0, Math.round(div / pat * 100)));
    const keptPct  = 100 - paidPct;
    eqRows.push({
      label:     `FY${String(fy).slice(-2)}`,
      kept_pct:  keptPct,
      paid_pct:  paidPct,
      ...(fy === lastEqFy ? { is_current: true } : {}),
    });
  }

  // Total equity = latest EQ_SHARE_CAP + RES_SURPLUS
  const latestEqCap  = _latest(rawBatchAll?.EQ_SHARE_CAP);
  const latestRes    = _latest(rawBatchAll?.RES_SURPLUS);
  const totalEquity  = (latestEqCap != null && latestRes != null) ? latestEqCap + latestRes : null;
  const latestRoe    = _latest(roeDerived) ?? _latest(derivedBatchAll?.ROE);

  // Payout trend
  const divVals = divPayQ4.slice(-2).map(e => e.value);
  const payoutTrend = divVals.length >= 2
    ? (divVals.at(-1) > divVals.at(0) ? 'Rising' : divVals.at(-1) < divVals.at(0) ? 'Falling' : 'Stable')
    : 'Stable';
  const payoutDir = payoutTrend === 'Rising' ? 'up' : payoutTrend === 'Falling' ? 'down' : 'flat';

  let eaStatus = 'Moderate', eaColor = 'yellow';
  if (latestRoe != null) {
    eaStatus = latestRoe >= 15 ? 'Compounding' : latestRoe >= 12 ? 'Adequate' : 'Below Par';
    eaColor  = latestRoe >= 15 ? 'green' : latestRoe >= 12 ? 'yellow' : 'yellow';
  }

  // Capex intensity metrics
  const latestCapex = _latest(derivedBatchAll?.CAPEX);
  const latestRev   = _latest(rawBatchAll?.REV_OP);
  const latestCfo   = _latest(rawBatchAll?.CFO);

  const capexRevPct = (latestCapex != null && latestRev && latestRev !== 0)
    ? _pf(Math.abs(latestCapex) / latestRev * 100)
    : null;
  const capexOcfPct = (latestCapex != null && latestCfo && latestCfo !== 0)
    ? _pf(Math.abs(latestCapex) / Math.abs(latestCfo) * 100)
    : null;

  // Bar pcts — capex/rev scaled against 15% max; capex/ocf against 100%
  const capexRevBarPct = capexRevPct != null ? Math.min(100, _pf(capexRevPct / 15 * 100)) : null;
  const capexOcfBarPct = capexOcfPct != null ? Math.min(100, _pf(capexOcfPct)) : null;

  let ciStatus = 'Moderate', ciColor = 'yellow';
  if (capexRevPct != null) {
    if (capexRevPct < 5)  { ciStatus = 'Asset-Light';  ciColor = 'green'; }
    else if (capexRevPct > 12) { ciStatus = 'Heavy';  ciColor = 'red'; }
  }

  return {
    balance_sheet: {
      status:            bsStatus,
      status_color:      bsColor,
      cash_investments:  _fmtCr(latestCash),
      cash_bar_pct:      cashBarPct,
      gross_debt:        _fmtCr(grossDebt),
      debt_bar_pct:      debtBarPct,
      net_cash:          netCash != null ? _fmtCr(netCash) : null,
      timeline,
      insight: null, // LLM fills
    },
    debt_trajectory: {
      status:          dtStatus,
      status_color:    dtColor,
      bars:            debtBars,
      peak_debt:       peakBar ? _fmtCr(peakBar.value) : null,
      peak_label:      peakBar?.label ?? null,
      current_debt:    currBar ? _fmtCr(currBar.value) : null,
      current_label:   currBar?.label ?? null,
      reduction_pct:   reductionPct != null ? `${reductionPct}%` : null,
      reduction_label: reductionPct != null
        ? (reductionPct === 0 ? 'Flat (immaterial)' : `${reductionPct}% reduction from peak`)
        : null,
      insight: null, // LLM fills
    },
    equity_allocation: {
      status:               eaStatus,
      status_color:         eaColor,
      rows:                 eqRows,
      total_equity:         totalEquity != null ? _fmtCr(totalEquity) : null,
      total_equity_sublabel: 'Book value (latest FY)',
      roe:                  latestRoe != null ? `${_pf(latestRoe)}%` : null,
      roe_sublabel:         latestRoe != null && latestRoe < 12 ? 'Below 12% threshold' : null,
      payout_trend:         payoutTrend,
      payout_trend_direction: payoutDir,
      payout_sublabel:      null, // LLM fills
      insight:              null, // LLM fills
    },
    capex_intensity: {
      status:      ciStatus,
      status_color: ciColor,
      metrics: [
        {
          label:     'Capex / Revenue',
          value:     capexRevPct != null ? `${capexRevPct}%` : 'N/A',
          bar_pct:   capexRevBarPct,
          max_label: '~15% peak',
          note:      null, // LLM fills
          status:    capexRevPct != null
            ? (capexRevPct < 5 ? 'green' : capexRevPct > 12 ? 'red' : 'yellow')
            : 'yellow',
        },
        {
          label:   'Capex / OCF',
          value:   capexOcfPct != null ? `${capexOcfPct}%` : 'N/A',
          bar_pct: capexOcfBarPct,
          note:    null, // LLM fills
          status:  capexOcfPct != null
            ? (capexOcfPct < 40 ? 'green' : capexOcfPct > 70 ? 'red' : 'yellow')
            : 'yellow',
        },
      ],
      note: null, // LLM fills
    },
  };
}

// ─── Master export ────────────────────────────────────────────────────────────

/**
 * Compute all four financial strength extras sub-sections from pre-fetched DB data.
 * No DB calls — all data comes from the metrics object already assembled by buildFinancialStrengthSection.
 *
 * @param {object} rawBatchAll     - last 10 quarters of raw KPIs (keyed by abbr)
 * @param {object} derivedBatchAll - last 10 quarters of derived KPIs (keyed by abbr)
 * @param {boolean} bfsi
 * @param {number|null} marketCap  - in Cr
 * @returns {{ operating_leverage, free_cash_flow, working_capital, capital_structure }}
 */
function computeFinancialStrengthExtras(rawBatchAll, derivedBatchAll, bfsi = false, marketCap = null) {
  return {
    operating_leverage: computeOperatingLeverage(rawBatchAll, derivedBatchAll),
    free_cash_flow:     computeFreeCashFlow(rawBatchAll, derivedBatchAll, bfsi, marketCap),
    working_capital:    bfsi ? null : computeWorkingCapital(rawBatchAll),
    capital_structure:  computeCapitalStructure(rawBatchAll, derivedBatchAll),
  };
}

module.exports = { computeFinancialStrengthExtras, deepMerge };
