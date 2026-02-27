'use strict';

/**
 * FinHelper — financial KPI calculation utility
 *
 * Layers:
 *  1. Math primitives   — pure static functions (growth, CAGR, margin, ratio, average)
 *  2. KPI resolver      — extracts value from Summary.kpis JSON, falls back through substitute_kpis
 *  3. Per-call extractors — thin wrappers that call resolveKpi for each of the 8 indicators
 *  4. Stock aggregators — time series + latestGrowth + CAGR across all periods for a ticker
 *  5. Industry aggregators — revenue CAGR and OPM growth averaged across all peers
 *  6. Generic ratio    — resolves two KPIs and returns their ratio (per period or single)
 *  7. Prefetch helper  — single 3-query DB fetch of all indicator data, frontend-ready shape
 *
 * Usage:
 *   const helper = new FinHelper(prisma);
 *   const data   = await helper.prefetchStockKpis('RELIANCE');
 */

const DAYS_PER_QUARTER = 365.25 / 4; // ~91.31

// Primary KPIs for the 9 tracked indicators
const INDICATOR_ABBRS = {
  revenue:         { primary: 'REV',    label: 'Revenue',                    unit: 'INR'        },
  opm:             { primary: 'OPM',    label: 'Operating Profit Margin',     unit: 'percentage' },
  roce:            { primary: 'ROCE',   label: 'Return on Capital Employed',  unit: 'percentage' },
  borrowings:      { primary: 'DEBT',   label: 'Borrowings',                  unit: 'INR'        },
  fcf:             { primary: 'FCF',    label: 'Free Cash Flow',              unit: 'INR'        },
  ccc:             { primary: 'CCC',    label: 'Cash Conversion Cycle',       unit: 'days'       },
  interest:        { primary: 'INTEXP', label: 'Interest Expense',            unit: 'INR'        },
  activeCustomers: { primary: 'CUST',   label: 'Active Customers',            unit: 'units'      },
  eps:             { primary: 'EPS',    label: 'Earnings Per Share',          unit: 'INR'        },
};

class FinHelper {
  /**
   * @param {import('@prisma/client').PrismaClient} prisma
   */
  constructor(prisma) {
    this.prisma = prisma;
    /** @type {Map<string, string[]>} session-scoped substitute cache */
    this._substituteCache = new Map();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 1 — Math primitives (pure, static)
  // ─────────────────────────────────────────────────────────────────────────────

  /** Period-over-period growth rate (%) */
  static growth(current, prev) {
    if (prev == null || prev === 0 || current == null) return null;
    return ((current - prev) / Math.abs(prev)) * 100;
  }

  /** Compound annual growth rate (%) over `years` */
  static cagr(initial, final, years) {
    if (initial == null || final == null || !years || initial <= 0) return null;
    return (Math.pow(final / initial, 1 / years) - 1) * 100;
  }

  /** Percentage margin — e.g. margin(EBIT, REV) */
  static margin(part, whole) {
    if (whole == null || whole === 0 || part == null) return null;
    return (part / whole) * 100;
  }

  /** Generic ratio a / b */
  static ratio(a, b) {
    if (b == null || b === 0 || a == null) return null;
    return a / b;
  }

  /** Mean of a non-null numeric array */
  static average(values) {
    const nums = (values ?? []).filter(v => v != null && !isNaN(v));
    if (!nums.length) return null;
    return nums.reduce((s, v) => s + v, 0) / nums.length;
  }

  /**
   * Market-cap-weighted average of a values array.
   * Pairs where either value or weight is null/zero are skipped.
   * Falls back to simple average when no valid weights exist.
   *
   * @param {(number|null)[]} values
   * @param {(number|null)[]} weights   - same length as values; typically market caps
   */
  static weightedAverage(values, weights) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const w = weights[i];
      if (v == null || isNaN(v) || w == null || isNaN(w) || w <= 0) continue;
      weightedSum += v * w;
      totalWeight += w;
    }
    if (totalWeight > 0) return weightedSum / totalWeight;
    // If no weights are usable, fall back to simple average
    return FinHelper.average(values);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 2 — KPI resolver (DB + substitute fallback)
  // ─────────────────────────────────────────────────────────────────────────────

  /** Load substitutes from DB (or return from cache) */
  async _getSubstitutes(primaryAbbr) {
    if (this._substituteCache.has(primaryAbbr)) {
      return this._substituteCache.get(primaryAbbr);
    }
    const row = await this.prisma.substituteKpi.findUnique({
      where:  { primaryKpiAbbr: primaryAbbr },
      select: { substitutes: true },
    });
    const subs = row?.substitutes ?? [];
    this._substituteCache.set(primaryAbbr, subs);
    return subs;
  }

  /** Extract a numeric KPI value from a Summary.kpis array [{kpi_abbr, value}] */
  static _extractFromKpis(kpisArr, abbr) {
    if (!Array.isArray(kpisArr)) return null;
    const match = kpisArr.find(k => k.kpi_abbr === abbr);
    if (match == null) return null;
    const v = parseFloat(match.value);
    return isNaN(v) ? null : v;
  }

  /**
   * Resolve a KPI from a kpis array, falling back to substitutes in priority order.
   *
   * @param {Array<{kpi_abbr: string, value: any}>} kpisArr
   * @param {string} primaryAbbr
   * @returns {Promise<{ value: number|null, resolvedAbbr: string, isSubstitute: boolean }>}
   */
  async resolveKpi(kpisArr, primaryAbbr) {
    const direct = FinHelper._extractFromKpis(kpisArr, primaryAbbr);
    if (direct != null) {
      return { value: direct, resolvedAbbr: primaryAbbr, isSubstitute: false };
    }

    const substitutes = await this._getSubstitutes(primaryAbbr);
    for (const sub of substitutes) {
      const v = FinHelper._extractFromKpis(kpisArr, sub);
      if (v != null) {
        return { value: v, resolvedAbbr: sub, isSubstitute: true };
      }
    }

    return { value: null, resolvedAbbr: primaryAbbr, isSubstitute: false };
  }

  /**
   * Fetch sorted time series for a KPI across all periods of a ticker.
   * Makes 2 DB queries (calls + summaries).
   *
   * @param {string} ticker         - earnings_calls.company value
   * @param {string} primaryAbbr
   * @returns {Promise<Array<{ callId, period, fiscal_year, quarter, call_date, value, resolvedAbbr, isSubstitute }>>}
   */
  async getTimeSeries(ticker, primaryAbbr) {
    const calls = await this.prisma.earnings_calls.findMany({
      where:   { company: ticker },
      select:  { id: true, fiscal_year: true, quarter: true, call_date: true },
      orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    });
    if (!calls.length) return [];

    const summaries = await this.prisma.summary.findMany({
      where:  { callId: { in: calls.map(c => c.id) } },
      select: { callId: true, kpis: true },
    });
    const summaryMap = new Map(summaries.map(s => [s.callId, s.kpis]));

    const series = [];
    for (const call of calls) {
      const kpisArr  = summaryMap.get(call.id) ?? [];
      const resolved = await this.resolveKpi(kpisArr, primaryAbbr);
      series.push({
        callId:      call.id,
        period:      _periodLabel(call),
        fiscal_year: call.fiscal_year,
        quarter:     call.quarter,
        call_date:   call.call_date,
        ...resolved,
      });
    }
    return series;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 3 — Per-call extractors (thin wrappers over resolveKpi)
  // ─────────────────────────────────────────────────────────────────────────────

  revenue        (kpisArr) { return this.resolveKpi(kpisArr, 'REV');    }
  opm            (kpisArr) { return this.resolveKpi(kpisArr, 'OPM');    }
  roce           (kpisArr) { return this.resolveKpi(kpisArr, 'ROCE');   }
  borrowings     (kpisArr) { return this.resolveKpi(kpisArr, 'DEBT');   }
  fcf            (kpisArr) { return this.resolveKpi(kpisArr, 'FCF');    }
  ccc            (kpisArr) { return this.resolveKpi(kpisArr, 'CCC');    }
  interest       (kpisArr) { return this.resolveKpi(kpisArr, 'INTEXP'); }
  activeCustomers(kpisArr) { return this.resolveKpi(kpisArr, 'CUST');   }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 4 — Stock-level aggregators
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Latest period-over-period growth for a single KPI.
   * @returns {Promise<number|null>}  percentage
   */
  async stockKpiGrowth(ticker, primaryAbbr) {
    const series     = await this.getTimeSeries(ticker, primaryAbbr);
    const withValues = series.filter(s => s.value != null);
    if (withValues.length < 2) return null;
    return FinHelper.growth(withValues.at(-1).value, withValues.at(-2).value);
  }

  /**
   * CAGR over `years` annual periods (default 3).
   * Uses earliest → latest available data points; pass explicit `years` for annualized rate.
   * @returns {Promise<number|null>}  percentage
   */
  async stockKpiCAGR(ticker, primaryAbbr, years = 3) {
    const series     = await this.getTimeSeries(ticker, primaryAbbr);
    const withValues = series.filter(s => s.value != null);
    if (withValues.length < 2) return null;
    return FinHelper.cagr(withValues.at(0).value, withValues.at(-1).value, years);
  }

  /**
   * All 8 indicators for a stock — growth + CAGR — in one batched call.
   * Makes 2 DB queries regardless of indicator count.
   *
   * @param {string} ticker
   * @returns {Promise<StockMetricsResult|null>}
   */
  async stockMetrics(ticker) {
    const { calls, summaryMap } = await this._fetchCallsAndSummaries(ticker);
    if (!calls.length) return null;

    const kpis = await _buildKpisBlock(calls, summaryMap, this);

    return {
      ticker,
      companyName: calls.at(-1)?.company_name ?? ticker,
      industry:    calls.at(-1)?.basic_industry ?? null,
      totalPeriods: calls.length,
      periods:     calls.map(_periodMeta),
      kpis,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 5 — Industry aggregators
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Revenue CAGR across all companies in an industry.
   * Pass `marketCapMap` for market-cap-weighted result; omit for simple average.
   *
   * @param {string}  industry        - earnings_calls.basic_industry value
   * @param {number}  years
   * @param {{ marketCapMap?: Record<string,number> }} [opts]
   *   marketCapMap — { [ticker]: marketCapValue } — any ticker absent from the map
   *                  is excluded from weighting (but still included in simple avg).
   * @returns {Promise<number|null>}  percentage
   */
  async industryRevenueGrowthCAGR(industry, years = 3, { marketCapMap = null } = {}) {
    const tickers = await this._industryTickers(industry);
    const cagrs   = await Promise.all(tickers.map(t => this.stockKpiCAGR(t, 'REV', years)));
    if (marketCapMap) {
      const weights = tickers.map(t => marketCapMap[t] ?? null);
      return FinHelper.weightedAverage(cagrs, weights);
    }
    return FinHelper.average(cagrs);
  }

  /**
   * Latest OPM growth across all companies in an industry.
   * Pass `marketCapMap` for market-cap-weighted result; omit for simple average.
   *
   * @param {string}  industry
   * @param {{ marketCapMap?: Record<string,number> }} [opts]
   * @returns {Promise<number|null>}  percentage
   */
  async industryOPMGrowth(industry, { marketCapMap = null } = {}) {
    const tickers = await this._industryTickers(industry);
    const growths = await Promise.all(tickers.map(t => this.stockKpiGrowth(t, 'OPM')));
    if (marketCapMap) {
      const weights = tickers.map(t => marketCapMap[t] ?? null);
      return FinHelper.weightedAverage(growths, weights);
    }
    return FinHelper.average(growths);
  }

  /**
   * EPS CAGR for a single stock.
   * Substitute fallback order: EPS → EPSBAS → EPSDIL → PAT (via substitute_kpis).
   *
   * @param {string} ticker
   * @param {number} years  - annualisation denominator (default 3)
   * @returns {Promise<number|null>}  percentage
   */
  async stockEpsCAGR(ticker, years = 3) {
    return this.stockKpiCAGR(ticker, 'EPS', years);
  }

  /**
   * EPS CAGR across all companies in an industry.
   * Pass `marketCapMap` for market-cap-weighted result; omit for simple average.
   *
   * @param {string}  industry        - earnings_calls.basic_industry value
   * @param {number}  years
   * @param {{ marketCapMap?: Record<string,number> }} [opts]
   * @returns {Promise<number|null>}  percentage
   */
  async industryEpsCAGR(industry, years = 3, { marketCapMap = null } = {}) {
    const tickers = await this._industryTickers(industry);
    const cagrs   = await Promise.all(tickers.map(t => this.stockKpiCAGR(t, 'EPS', years)));
    if (marketCapMap) {
      const weights = tickers.map(t => marketCapMap[t] ?? null);
      return FinHelper.weightedAverage(cagrs, weights);
    }
    return FinHelper.average(cagrs);
  }

  /**
   * Average P/E ratio for a stock over the past `nQuarters` calendar quarters.
   * Queries pe_data (daily rows) and averages all data points in the window.
   *
   * @param {string} ticker
   * @param {number} nQuarters  - look-back window in quarters (default 3)
   * @returns {Promise<{
   *   ticker:     string,
   *   nQuarters:  number,
   *   fromDate:   Date,
   *   toDate:     Date,
   *   average:    number|null,
   *   dataPoints: number,
   *   timeSeries: Array<{ date: Date, pe: number }>
   * }>}
   */
  async stockPeAverage(ticker, nQuarters = 3) {
    const toDate   = new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - Math.round(nQuarters * DAYS_PER_QUARTER));

    const rows = await this.prisma.pe_data.findMany({
      where: {
        company: ticker,
        date:    { gte: fromDate, lte: toDate },
      },
      select:  { date: true, pe: true },
      orderBy: { date: 'asc' },
    });

    const timeSeries = rows
      .map(r => ({ date: r.date, pe: parseFloat(r.pe) }))
      .filter(r => !isNaN(r.pe));

    return {
      ticker,
      nQuarters,
      fromDate,
      toDate,
      average:    FinHelper.average(timeSeries.map(r => r.pe)),
      dataPoints: timeSeries.length,
      timeSeries,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 6 — Generic ratio calculator
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute numeratorAbbr / denominatorAbbr for every period of a ticker.
   * Both KPIs respect substitute fallback.
   *
   * @param {string}  ticker
   * @param {string}  numeratorAbbr
   * @param {string}  denominatorAbbr
   * @param {string}  [period]  - e.g. "FY25-Q1"; if given, returns single object instead of array
   * @returns {Promise<Array|object|null>}
   */
  async calcRatio(ticker, numeratorAbbr, denominatorAbbr, period = null) {
    const [numSeries, denSeries] = await Promise.all([
      this.getTimeSeries(ticker, numeratorAbbr),
      this.getTimeSeries(ticker, denominatorAbbr),
    ]);

    const denMap     = new Map(denSeries.map(s => [s.period, s]));
    const ratioSeries = numSeries.map(n => {
      const d = denMap.get(n.period);
      return {
        period:      n.period,
        callId:      n.callId,
        value:       FinHelper.ratio(n.value, d?.value ?? null),
        numerator:   { value: n.value,   resolvedAbbr: n.resolvedAbbr, isSubstitute: n.isSubstitute },
        denominator: { value: d?.value ?? null, resolvedAbbr: d?.resolvedAbbr ?? denominatorAbbr, isSubstitute: d?.isSubstitute ?? false },
      };
    });

    if (period) return ratioSeries.find(r => r.period === period) ?? null;
    return ratioSeries;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 7 — Prefetch helper (DB helper for frontend)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch ALL indicator data for a stock in exactly 3 DB queries.
   * Warm-fills the substitute cache as a side effect.
   *
   * Query plan:
   *   1. earnings_calls  WHERE company = ticker
   *   2. summaries       WHERE call_id IN (...)
   *   3. substitute_kpis WHERE primary_kpi_abbr IN (8 primaries)
   *
   * All subsequent resolveKpi calls are in-memory (cache hits).
   *
   * @param {string} ticker
   * @returns {Promise<PrefetchResult|null>}
   */
  async prefetchStockKpis(ticker) {
    // Q1 — all calls for this ticker
    const calls = await this.prisma.earnings_calls.findMany({
      where:   { company: ticker },
      select:  {
        id:             true,
        fiscal_year:    true,
        quarter:        true,
        call_date:      true,
        basic_industry: true,
        company_name:   true,
      },
      orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    });
    if (!calls.length) return null;

    // Q2 — all summaries for those calls
    const summaries = await this.prisma.summary.findMany({
      where:  { callId: { in: calls.map(c => c.id) } },
      select: { callId: true, kpis: true },
    });
    const summaryMap = new Map(summaries.map(s => [s.callId, s.kpis]));

    // Q3 — all substitutes for the 8 indicator primaries (bulk, warm cache)
    const primaryAbbrs = Object.values(INDICATOR_ABBRS).map(i => i.primary);
    await this._warmSubstituteCache(primaryAbbrs);

    // In-memory: build indicator time series + stats
    const kpis = await _buildKpisBlock(calls, summaryMap, this);

    return {
      ticker,
      companyName:  calls.at(-1)?.company_name   ?? ticker,
      industry:     calls.at(-1)?.basic_industry ?? null,
      totalPeriods: calls.length,
      periods:      calls.map(_periodMeta),
      kpis,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /** Bulk-load substitute rows into cache in a single query */
  async _warmSubstituteCache(primaryAbbrs) {
    const missing = primaryAbbrs.filter(a => !this._substituteCache.has(a));
    if (!missing.length) return;
    const rows = await this.prisma.substituteKpi.findMany({
      where:  { primaryKpiAbbr: { in: missing } },
      select: { primaryKpiAbbr: true, substitutes: true },
    });
    for (const row of rows) {
      this._substituteCache.set(row.primaryKpiAbbr, row.substitutes);
    }
    // Ensure abbrs with no DB row also get cached (empty array → no retry)
    for (const abbr of missing) {
      if (!this._substituteCache.has(abbr)) this._substituteCache.set(abbr, []);
    }
  }

  /** Fetch calls + summaries for a ticker and return both */
  async _fetchCallsAndSummaries(ticker) {
    const calls = await this.prisma.earnings_calls.findMany({
      where:   { company: ticker },
      select:  { id: true, fiscal_year: true, quarter: true, call_date: true, basic_industry: true, company_name: true },
      orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    });
    const summaries = calls.length
      ? await this.prisma.summary.findMany({
          where:  { callId: { in: calls.map(c => c.id) } },
          select: { callId: true, kpis: true },
        })
      : [];
    const summaryMap = new Map(summaries.map(s => [s.callId, s.kpis]));
    return { calls, summaryMap };
  }

  /** Distinct company tickers for an industry */
  async _industryTickers(industry) {
    const rows = await this.prisma.earnings_calls.findMany({
      where:    { basic_industry: industry },
      select:   { company: true },
      distinct: ['company'],
    });
    return rows.map(r => r.company);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers (pure, no DB)
// ─────────────────────────────────────────────────────────────────────────────

/** Consistent period string e.g. "FY25-Q1" or "FY25" */
function _periodLabel(call) {
  return call.quarter ? `${call.fiscal_year}-${call.quarter}` : call.fiscal_year;
}

/** Period metadata object used in `periods` arrays */
function _periodMeta(call) {
  return {
    callId:      call.id,
    period:      _periodLabel(call),
    fiscal_year: call.fiscal_year,
    quarter:     call.quarter,
    call_date:   call.call_date,
  };
}

/**
 * Build the full kpis block for all 8 indicators given pre-fetched calls + summaryMap.
 * All resolveKpi calls hit the in-memory cache — no further DB queries.
 *
 * @param {Array}   calls
 * @param {Map}     summaryMap   callId → kpisArr
 * @param {FinHelper} helper
 */
async function _buildKpisBlock(calls, summaryMap, helper) {
  const kpis = {};

  for (const [indicator, { primary, label, unit }] of Object.entries(INDICATOR_ABBRS)) {
    const series = [];

    for (const call of calls) {
      const kpisArr  = summaryMap.get(call.id) ?? [];
      const resolved = await helper.resolveKpi(kpisArr, primary);
      series.push({ ...(_periodMeta(call)), ...resolved });
    }

    const withValues = series.filter(s => s.value != null);
    const latest     = withValues.at(-1)?.value ?? null;
    const prev       = withValues.at(-2)?.value ?? null;
    const first      = withValues.at(0)?.value  ?? null;

    // Estimate span in years from actual call dates (falls back to period count)
    const spanYears = _spanYears(withValues);

    kpis[indicator] = {
      label,
      unit,
      primaryAbbr:   primary,
      timeSeries:    series,
      latestValue:   latest,
      latestGrowth:  FinHelper.growth(latest, prev),   // % period-over-period
      cagr:          FinHelper.cagr(first, latest, spanYears),
      periodsWithData: withValues.length,
    };
  }

  return kpis;
}

/**
 * Compute span in decimal years between first and last call_date.
 * Falls back to period count if dates are unavailable.
 */
function _spanYears(withValues) {
  if (withValues.length < 2) return null;
  const first = withValues.at(0);
  const last  = withValues.at(-1);
  if (first.call_date && last.call_date) {
    const ms = new Date(last.call_date) - new Date(first.call_date);
    const years = ms / (1000 * 60 * 60 * 24 * 365.25);
    return years > 0 ? years : withValues.length;
  }
  return withValues.length;  // treat each period as ~1 unit
}

module.exports = { FinHelper, INDICATOR_ABBRS };
