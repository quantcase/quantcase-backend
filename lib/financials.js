'use strict';

const prisma        = require('../config/prisma');
const {
  resolveProwessName, fetchAnnualBatch, fetchQuarterlyBatch, resolveMetric, resolveFormulaSeries,
  createResolutionContext, createFlatContext, createSeriesOnlyContext, getDefinition,
} = require('../utils/formulaRegistry');
const { fetchMarketSnapshot, fetchMonthlyClose } = require('../utils/formulaRegistry/dataFetcherMarket');
const { cagr: mathCagr } = require('../utils/formulaRegistry/math');

const ALL_ABBRS = [
  'REV_OP', 'TOTAL_INCOME', 'TOTAL_OPEX', 'EBIT', 'OTH_INC',
  'FIN_COST', 'DEP_AMORT', 'PBT', 'PAT', 'EPS_BASIC', 'EPS_DILUTED', 'TAX_EXP',
  'EQ_SHARE_CAP', 'RES_SURPLUS', 'BORR_TOTAL', 'DEBT_LT', 'DEBT_ST',
  'TOTAL_LIAB', 'ASSET_PPE', 'ASSET_CWIP', 'INV_NONCURR', 'TOTAL_ASSETS',
  'CFO', 'CFI', 'CFF', 'NET_WORTH',
  'CURR_ASSETS', 'CURR_LIAB', 'OTH_ASSET_NC', 'PROV_LT', 'PROV_ST',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r2(v) {
  return v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
}

function roundTo(v, decimals) {
  if (v == null || isNaN(v)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function roundCagr(s, e, y) {
  const v = mathCagr(s, e, y);
  return v != null ? Math.round(v) : null;
}

const ONE_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

// Every windowed*/ttmGrowthField helper below returns { value, error }: `value`
// is the normal number|null the response schema always had, and `error` (null
// when the value is fine) is a human-readable reason surfaced separately —
// see assembleWindowed() — instead of overloading `value` with a string.

// CAGR over an ascending annual series, routed through the registry's windowed
// CAGR entries (e.g. REV_CAGR_5Y). A window needs `windowYears + 1` annual points
// (start + end); when the company doesn't have that much history yet, report how
// much it actually has instead of silently computing a shorter, mislabeled span.
async function windowedCagr(series, windowYears, metricId) {
  const pts = series.filter((s) => s.value != null);
  if (pts.length < windowYears + 1) {
    return { value: null, error: pts.length >= 2 ? `Only ${pts.length - 1}Y of data available` : null };
  }
  const res = await resolveMetric(metricId, createSeriesOnlyContext({ series }));
  return { value: r2(res.value), error: null };
}

// Multi-year average over an ascending annual series (e.g. ROE_5Y_AVG), routed
// through the registry. A window needs `windowYears` annual points.
async function windowedAverage(series, windowYears, metricId) {
  const pts = series.filter((s) => s.value != null);
  if (pts.length < windowYears) {
    return { value: null, error: pts.length >= 1 ? `Only ${pts.length}Y of data available` : null };
  }
  const res = await resolveMetric(metricId, createSeriesOnlyContext({ series }));
  return { value: r2(res.value), error: null };
}

// Stock price CAGR over the last `windowYears`, sliced by date out of one
// long-lookback monthly-close fetch. Filters null-close bars (recently-listed
// tickers carry leading null-close months before trading actually started) —
// using them unfiltered silently turns the CAGR into NaN, which then serializes
// as JSON null and looks identical to "no data".
function windowedStockCagr(monthlyClose, windowYears) {
  const bars = (monthlyClose || []).filter((r) => r.close != null);
  if (bars.length < 2) return { value: null, error: null };

  // Anchor the cutoff to the latest bar's own month (not "today") so it lands
  // exactly on a month boundary — anchoring to Date.now() instead would usually
  // fall mid-month and exclude the correct boundary bar, quietly shortening the
  // window by up to a month.
  const last      = bars[bars.length - 1];
  const sinceDate = new Date(last.month);
  sinceDate.setUTCFullYear(sinceDate.getUTCFullYear() - windowYears);

  const withinWindow = bars.filter((r) => new Date(r.month) >= sinceDate);
  const first         = withinWindow[0] ?? bars[0];

  const elapsedYears = (new Date(last.month) - new Date(first.month)) / ONE_YEAR_MS;
  if (elapsedYears < windowYears * 0.9) {
    return {
      value: null,
      error: elapsedYears > 0 ? `Only ${Math.round(elapsedYears * 10) / 10}Y of data available` : null,
    };
  }
  // Annualize over the actual elapsed span, not the nominal window — keeps the
  // math correct even when it's off by a few days from the requested window.
  return { value: roundCagr(parseFloat(first.close), parseFloat(last.close), elapsedYears), error: null };
}

// Sum of exactly 4 consecutive quarters from a registry-shaped quarterly abbr
// array (ascending, one entry per known period). Requires all 4 to be non-null —
// a partial window (e.g. only 1 of the 4 "prior" quarters exists) would silently
// understate the prior-year TTM and produce a misleading growth rate.
function sumQuarters(byAbbr, abbr, offset) {
  const arr = byAbbr[abbr];
  if (!arr) return null;
  const end = arr.length - offset;
  if (end < 4) return null;
  const vals = arr.slice(end - 4, end).map((r) => (r.value != null ? r2(r.value) : null));
  if (vals.some((v) => v == null)) return null;
  return r2(vals.reduce((s, v) => s + v, 0));
}

// TTM growth = CAGR of a 2-point [priorTTM, currentTTM] series over 1 year —
// mathematically identical to a YoY growth rate, so it reuses the registry's
// plain (unwindowed) CAGR entry instead of a bespoke formula.
async function ttmGrowthField(curr, prior, cagrEntryId, quartersAvailable) {
  if (curr != null && prior != null) {
    const res = await resolveMetric(cagrEntryId, createSeriesOnlyContext({ series: [{ value: prior }, { value: curr }] }));
    return { value: r2(res.value), error: null };
  }
  return {
    value: null,
    error: quartersAvailable > 0 ? `Only ${quartersAvailable} quarter${quartersAvailable === 1 ? '' : 's'} of data available` : null,
  };
}

// Assembles one salesGrowth/profitGrowth/roe/stockPriceCagr response bucket:
// every key keeps its plain number|null value (unchanged response schema), and
// an `error` sibling collects the reasons for whichever keys came back null —
// omitted entirely when nothing needs explaining.
function assembleWindowed(entries) {
  const out = {};
  const error = {};
  for (const [key, res] of entries) {
    out[key] = res.value;
    if (res.error) error[key] = res.error;
  }
  if (Object.keys(error).length) out.error = error;
  return out;
}

// ─── Financials Singleton ─────────────────────────────────────────────────────

class Financials {
  constructor() {
    if (Financials.instance) return Financials.instance;
    Financials.instance = this;
  }

  async analyze(symbol) {
    // ── 1. Resolve company name ───────────────────────────────────────────────
    const companyName = await resolveProwessName(prisma, symbol);

    // ── 2. Fetch all data in parallel ─────────────────────────────────────────
    const now       = Date.now();
    const tenYrsAgo = new Date(now - 10 * 365 * 24 * 60 * 60 * 1000);

    // resCtx backs the ScreenConfig-driven P&L/Balance Sheet/Cash Flow tables
    // below (3.3 of the screener-config rework) plus the ROE/PB_TTM/valuation
    // swaps in _buildMetrics/_buildValuation — the exact same resolveMetric
    // path GET /admin/kpis/:abbr/preview uses, so these numbers are
    // guaranteed to match what admin sees there.
    //
    // byAnnualAbbr/byQtrAbbr (via the older ALL_ABBRS-scoped fetch) still
    // separately back _buildTTM/_buildMetrics' CAGR/growth calculations,
    // which are unchanged by this pass — a deliberate, minor duplicate-query
    // tradeoff (two overlapping bulk fetches instead of unifying onto resCtx
    // everywhere) rather than restructuring code the plan didn't ask to touch.
    const resCtx = createResolutionContext({ symbol });

    // Longest lookback only — 1y/3y/5y windows are sliced from this by date,
    // so a young stock reports exactly how much history it actually has.
    const [byAnnualAbbr, byQtrAbbr, marketSnap, monthlyCloseRows] = await Promise.all([
      fetchAnnualBatch(prisma, symbol, ALL_ABBRS),
      fetchQuarterlyBatch(prisma, symbol, ALL_ABBRS),
      fetchMarketSnapshot(prisma, symbol),
      fetchMonthlyClose(prisma, symbol, { since: tenYrsAgo }),
    ]);

    // Annual: Q4 full-year rows from audited annual CSV
    // Quarterly: individual quarter rows from quarterly CSV
    const annualPL = this._filterAnnual(byAnnualAbbr);
    const mktCapCr = marketSnap?.market_cap_cr ?? null;

    const [
      pnlQuarterly, pnlAnnual, balanceSheetAnnual, balanceSheetQuarterly,
      cashFlowAnnual, cashFlowQuarterly, ttm, metrics, valuation,
    ] = await Promise.all([
      this._buildTableFromKpiGroup('financials.pnl.quarterly', resCtx, 'quarterly'),
      this._buildTableFromKpiGroup('financials.pnl.annual', resCtx, 'annual'),
      this._buildTableFromKpiGroup('financials.balance-sheet.annual', resCtx, 'annual'),
      this._buildTableFromKpiGroup('financials.balance-sheet.quarterly', resCtx, 'quarterly'),
      this._buildTableFromKpiGroup('financials.cashflow.annual', resCtx, 'annual'),
      this._buildTableFromKpiGroup('financials.cashflow.quarterly', resCtx, 'quarterly'),
      this._buildTTM(byQtrAbbr, mktCapCr),
      this._buildMetrics(annualPL, byQtrAbbr, monthlyCloseRows, resCtx),
      this._buildValuation(mktCapCr, resCtx),
    ]);

    return {
      symbol,
      exchange:  'NSE',
      currency:  'INR',
      unit:      'INR_CRORES',
      timestamp: new Date().toISOString(),

      standardized: {
        quarterly:         pnlQuarterly,
        annual:            pnlAnnual,
        balanceSheet:      { annual: balanceSheetAnnual, quarterly: balanceSheetQuarterly },
        cashFlow:          cashFlowAnnual,
        cashFlowQuarterly,
        ttm,
        metrics,
        valuation,
      },
    };
  }

  // ── Generic KpiGroup-driven table builder (P&L / Balance Sheet / Cash Flow
  // all share this) — replaces the old ScreenConfigItem-driven version.
  // ScreenConfig.kpi_group_slug points at a KpiGroup branch (e.g.
  // "pnl-statement--annual"); its direct children become top-level rows, and
  // any of THEIR children (e.g. Fixed Assets' component assets) become
  // nested `children` rows -- admin manages the row list/hierarchy entirely
  // through /admin/kpi-groups now, not per-item CRUD. Every value still
  // comes from resolveFormulaSeries against the same resCtx every other
  // registry consumer (including admin's preview endpoint) reads from, so a
  // row here can never silently diverge from what admin sees there.
  //
  // Precision is page-level only (config.decimal_places) -- no per-row
  // override, by design (kept simple; see git history if per-row precision
  // is ever needed again).
  async _buildTableFromKpiGroup(configKey, resCtx, freq) {
    const config = await prisma.screenConfig.findUnique({ where: { key: configKey } });
    if (!config?.kpi_group_slug) return { periods: [], rows: [] };

    const group = await prisma.kpiGroup.findUnique({
      where:   { slug: config.kpi_group_slug },
      include: { children: { orderBy: { display_order: 'asc' }, include: { children: { orderBy: { display_order: 'asc' } } } } },
    });
    if (!group || !group.children.length) return { periods: [], rows: [] };

    const seriesMap  = await resCtx.getSeriesMap(freq);
    const anyAbbr     = Object.keys(seriesMap)[0];
    const rawPeriods  = anyAbbr ? seriesMap[anyAbbr] : [];

    let periodEntries = rawPeriods.map((p) => ({ fiscal_year: p.fiscal_year, quarter: p.quarter }));
    if (config.periods_shown) periodEntries = periodEntries.slice(-config.periods_shown);
    const sliceFrom = rawPeriods.length - periodEntries.length;

    const labels = periodEntries.map((p) =>
      freq === 'annual' ? this._fyLabel(p.fiscal_year) : `${p.quarter} ${p.fiscal_year}`
    );

    const rows = (await Promise.all(
      group.children.map((node) => this._buildGroupRow(node, resCtx, freq, sliceFrom, config.decimal_places))
    )).filter(Boolean);

    return { periods: labels, rows };
  }

  async _buildGroupRow(node, resCtx, freq, sliceFrom, decimals) {
    if (node.company_group_slug && !(await resCtx.isCompanyInGroup(node.company_group_slug))) return null;

    const def       = await getDefinition(node.kpi_abbr);
    const rawValues = await resolveFormulaSeries(node.kpi_abbr, resCtx, { frequency: freq });
    const values    = rawValues.slice(sliceFrom).map((v) => roundTo(v, decimals));

    const row = { key: node.kpi_abbr, label: node.label, values };
    if (def?.denomination === 'percentage') row.format = 'percent';

    if (node.children?.length) {
      const childRows = (await Promise.all(
        node.children.map((c) => this._buildGroupRow(c, resCtx, freq, sliceFrom, decimals))
      )).filter(Boolean);
      if (childRows.length) {
        row.children = childRows;
        row.meta = { expandable: true };
      }
    }
    return row;
  }

  // ── Period helpers ─────────────────────────────────────────────────────────

  // Prowess stores Q4 as the full-year figure; use those for annual view
  _filterAnnual(byAbbr) {
    // Collect all unique (fiscal_year, quarter) pairs that have Q4 entries
    const periods = new Set();
    for (const rows of Object.values(byAbbr)) {
      for (const r of rows) {
        if (r.quarter === 'Q4') periods.add(`${r.fiscal_year}|${r.quarter}`);
      }
    }
    // Build per-period objects sorted by fiscal year
    return [...periods]
      .sort()
      .map((key) => {
        const [fiscal_year, quarter] = key.split('|');
        const obj = { fiscal_year, quarter, _label: this._fyLabel(fiscal_year) };
        for (const [abbr, rows] of Object.entries(byAbbr)) {
          const r = rows.find((x) => x.fiscal_year === fiscal_year && x.quarter === quarter);
          if (r) obj[abbr] = this._toCr(r);
        }
        return obj;
      });
  }

  _fyLabel(fiscal_year) {
    // fiscal_year like "FY2024" → "FY24"
    if (!fiscal_year) return null;
    const m = fiscal_year.match(/\d+/);
    return m ? `FY${m[0].slice(-2)}` : fiscal_year;
  }

  _toCr(row) {
    if (!row) return null;
    return r2(row.value);
  }

  // ── TTM ──────────────────────────────────────────────────────────────────

  async _buildTTM(byAbbr, mktCapCr) {
    // Sum last 4 quarterly entries for each KPI
    const ttm = (abbr) => {
      const arr = byAbbr[abbr];
      if (!arr || arr.length === 0) return null;
      const last4 = arr.slice(-4);
      const vals  = last4.map((r) => this._toCr(r)).filter((v) => v != null);
      if (vals.length === 0) return null;
      return r2(vals.reduce((s, v) => s + v, 0));
    };

    const revTtm  = ttm('REV_OP') ?? ttm('TOTAL_INCOME');
    const patTtm  = ttm('PAT');
    const taxTtm  = ttm('TAX_EXP');
    const pbtTtm  = ttm('PBT') ?? (patTtm != null && taxTtm != null ? r2(patTtm + taxTtm) : null);
    const fcTtm   = ttm('FIN_COST');
    const daTtm   = ttm('DEP_AMORT');
    const ebitdaRes = await resolveMetric('EBITDA', createFlatContext({ kpiMap: { PBT: pbtTtm, FIN_COST: fcTtm, DEP_AMORT: daTtm } }));
    const ebitdaTtm = r2(ebitdaRes.value);
    const epsTtm  = ttm('EPS_BASIC') ?? ttm('EPS_DILUTED');

    return { revenue: revTtm, ebitda: ebitdaTtm, netProfit: patTtm, eps: epsTtm };
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  async _buildMetrics(annualPeriods, quarterlyByAbbr, monthlyClose, resCtx) {
    // Ascending {value, fiscal_year} series — same shape the registry's cagr/
    // average resolvers expect (see screener.controller.js's epsSeriesAsc).
    const revSeries    = annualPeriods.map((p) => ({ value: p['REV_OP'] ?? p['TOTAL_INCOME'] ?? null, fiscal_year: p.fiscal_year }));
    const profitSeries = annualPeriods.map((p) => ({ value: p['PAT'] ?? null, fiscal_year: p.fiscal_year }));
    // Resolved via the registry (ROE = PAT/NET_WORTH*100) instead of hand-computed
    // — same resolveFormulaSeries path _buildTableFromConfig uses, aligned by
    // index to annualPeriods since both ultimately read the same fetchAnnualBatch
    // query underneath (resCtx.getSeriesMap('annual') and _filterAnnual's byAbbr).
    const roeValues = await resolveFormulaSeries('ROE', resCtx, { frequency: 'annual' });
    const roeSeries = annualPeriods.map((p, i) => ({ value: roeValues[i] ?? null, fiscal_year: p.fiscal_year }));

    // TTM growth: current trailing-4-quarter sum vs the prior trailing-4-quarter sum.
    const revTtmCurr    = sumQuarters(quarterlyByAbbr, 'REV_OP', 0) ?? sumQuarters(quarterlyByAbbr, 'TOTAL_INCOME', 0);
    const revTtmPrior   = sumQuarters(quarterlyByAbbr, 'REV_OP', 4) ?? sumQuarters(quarterlyByAbbr, 'TOTAL_INCOME', 4);
    const patTtmCurr    = sumQuarters(quarterlyByAbbr, 'PAT', 0);
    const patTtmPrior   = sumQuarters(quarterlyByAbbr, 'PAT', 4);
    const quartersAvail = (quarterlyByAbbr['REV_OP'] ?? quarterlyByAbbr['TOTAL_INCOME'] ?? []).filter((r) => r.value != null).length;

    const [
      salesGrowth3y, salesGrowth5y, salesGrowth10y, salesGrowthTtm,
      profitGrowth3y, profitGrowth5y, profitGrowth10y, profitGrowthTtm,
      roe3y, roe5y, roe10y,
    ] = await Promise.all([
      windowedCagr(revSeries, 3, 'REV_CAGR_3Y'),
      windowedCagr(revSeries, 5, 'REV_CAGR_5Y'),
      windowedCagr(revSeries, 10, 'REV_CAGR_10Y'),
      ttmGrowthField(revTtmCurr, revTtmPrior, 'REV_CAGR', quartersAvail),
      windowedCagr(profitSeries, 3, 'PAT_CAGR_3Y'),
      windowedCagr(profitSeries, 5, 'PAT_CAGR_5Y'),
      windowedCagr(profitSeries, 10, 'PAT_CAGR_10Y'),
      ttmGrowthField(patTtmCurr, patTtmPrior, 'PAT_CAGR', quartersAvail),
      windowedAverage(roeSeries, 3, 'ROE_3Y_AVG'),
      windowedAverage(roeSeries, 5, 'ROE_5Y_AVG'),
      windowedAverage(roeSeries, 10, 'ROE_10Y_AVG'),
    ]);

    return {
      salesGrowth: assembleWindowed([
        ['3y',  salesGrowth3y],
        ['5y',  salesGrowth5y],
        ['10y', salesGrowth10y],
        ['ttm', salesGrowthTtm],
      ]),
      profitGrowth: assembleWindowed([
        ['3y',  profitGrowth3y],
        ['5y',  profitGrowth5y],
        ['10y', profitGrowth10y],
        ['ttm', profitGrowthTtm],
      ]),
      roe: {
        ...assembleWindowed([
          ['3y',  roe3y],
          ['5y',  roe5y],
          ['10y', roe10y],
        ]),
        last: roeSeries.length && roeSeries.at(-1).value != null ? r2(roeSeries.at(-1).value) : null,
      },
      stockPriceCagr: assembleWindowed([
        ['1y',  windowedStockCagr(monthlyClose, 1)],
        ['3y',  windowedStockCagr(monthlyClose, 3)],
        ['5y',  windowedStockCagr(monthlyClose, 5)],
        ['10y', windowedStockCagr(monthlyClose, 10)],
      ]),
    };
  }

  // ── Valuation ─────────────────────────────────────────────────────────────

  async _buildValuation(mktCapCr, resCtx) {
    // Every value below resolves through the registry (resCtx), the same
    // path GET /admin/kpis/:abbr/preview uses — no more locally re-derived
    // market-cap/net-worth math.
    //
    // NET_WORTH/EPS_BASIC specifically use resolveFormulaSeries(...).at(-1)
    // rather than resolveMetric's current-value path — resolveMetric's
    // getCurrentValue walks backward through a raw leaf's OWN series for the
    // first non-null value, and only ever consults fallback_abbrs if NO value
    // exists anywhere in history. That silently returns a stale figure when
    // only the latest period has a gap (confirmed live: RELIANCE's raw
    // EPS_BASIC is null for FY2024/FY2025 but has a real FY2022 value —
    // resolveMetric('EPS_BASIC',...) returns that 3-year-stale 92 instead of
    // FY2025's EPS_DILUTED-fallback value of 51.47). resolveFormulaSeries
    // resolves each period independently, so its last element correctly
    // applies the fallback AT the true latest period instead. This is a
    // real, pre-existing resolveMetric behavior (not introduced by this
    // rework) that likely affects other current-value callers too — flagged
    // separately, fixed here only for the two fields this task touches.
    const [peRes, pbRes, evRes, evEbitdaRes, evRevenueRes, divYieldRes, nwSeries, epsSeries] = await Promise.all([
      resolveMetric('PE_DAILY', resCtx),
      resolveMetric('PB_TTM', resCtx),
      resolveMetric('ENTERPRISE_VALUE', resCtx),
      resolveMetric('EV_EBITDA', resCtx),
      resolveMetric('EV_REVENUE', resCtx),
      // Registry-enabled but zero source data anywhere in prowess_values_new
      // (verified) -- resolves null until real data is ingested. No CSV fallback.
      resolveMetric('DIVIDEND_YIELD', resCtx),
      resolveFormulaSeries('NET_WORTH', resCtx, { frequency: 'annual' }),
      resolveFormulaSeries('EPS_BASIC', resCtx, { frequency: 'annual' }),
    ]);

    return {
      marketCap:       mktCapCr,
      enterpriseValue: r2(evRes.value),
      peRatio:         r2(peRes.value),
      forwardPE:       null,
      pbRatio:         r2(pbRes.value),
      evToEbitda:      r2(evEbitdaRes.value),
      evToRevenue:     r2(evRevenueRes.value),
      dividendYield:   r2(divYieldRes.value),
      bookValue:       r2(nwSeries.at(-1) ?? null),
      eps:             r2(epsSeries.at(-1) ?? null),
    };
  }
}

const financials = new Financials();
module.exports = financials;
