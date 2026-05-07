'use strict';

const { cagr, average, weightedAverage } = require('./finMath');
const { SOURCE_ABBRS, computeDerivedKpis } = require('./finDerivedKpis');

// ─── Name normalization ───────────────────────────────────────────────────────

/**
 * Strip legal suffixes and punctuation for fuzzy company name matching.
 */
function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\b(ltd\.?|limited|pvt\.?|private|inc\.?|llp|corp\.?|corporation)\b\.?/gi, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── ProwessHelper ────────────────────────────────────────────────────────────

/**
 * ProwessHelper — mirrors FinHelper but reads from prowess_values_new (annual audited data).
 *
 * Key differences from FinHelper / kpi_values:
 *  - Uses full company names, not tickers. Name resolution via earnings_calls.company_name.
 *  - Data is annual only: quarter = "Q4" in prowess means the full-year figure.
 *  - Values stored as raw INR; divide by `multiplier` to get display unit (Cr).
 *  - No callId — synthetic period key used instead.
 *
 * Return shapes are intentionally identical to FinHelper so callers can swap transparently:
 *   getTimeSeries      → [{ callId: null, period, fiscal_year, quarter, call_date: null, value, abbrUsed }]
 *   getTimeSeriesBatch → Record<abbr, same array>
 *   getDerivedKpiBatch → same as FinHelper.getDerivedKpiBatch
 *   stockKpiLatest     → { value, abbrUsed, period, type }
 *   stockKpiCagr       → { value, type, spanYears, periodsUsed, firstValue, latestValue }
 */
class ProwessHelper {
  /**
   * @param {import('@prisma/client').PrismaClient} prisma
   */
  constructor(prisma) {
    this.prisma      = prisma;
    this._nameCache  = new Map(); // ticker → prowessCompanyName | null
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Name resolution
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Resolve a ticker to its prowess_values_new company name.
   * Cached per instance to avoid repeated DB lookups across batch calls.
   *
   * @param {string} ticker  e.g. "MSUMI"
   * @returns {Promise<string|null>}
   */
  async resolveProwessName(ticker) {
    if (this._nameCache.has(ticker)) return this._nameCache.get(ticker);

    const ec = await this.prisma.earnings_calls.findFirst({
      where:  { company: ticker },
      select: { company_name: true },
    });

    const prowessName = ec?.company_name
      ? await this._matchProwessName(ec.company_name)
      : null;

    this._nameCache.set(ticker, prowessName);
    return prowessName;
  }

  /**
   * Find the best-matching prowess company name for a given full company name.
   * Uses normalised word-overlap scoring; requires ≥ 50% word match.
   *
   * @param {string} companyName  e.g. "Motherson Sumi Wiring India Limited"
   * @returns {Promise<string|null>}
   */
  async _matchProwessName(companyName) {
    const normTarget = normName(companyName);
    const words      = normTarget.split(' ').filter(w => w.length > 2);
    if (!words.length) return null;

    // Candidate search: find prowess names containing the first distinctive word
    const candidates = await this.prisma.prowessValueNew.findMany({
      where:    { company: { contains: words[0], mode: 'insensitive' } },
      select:   { company: true },
      distinct: ['company'],
    });

    let best = null, bestScore = 0;
    for (const c of candidates) {
      const normC      = normName(c.company);
      const matchCount = words.filter(w => normC.includes(w)).length;
      const score      = matchCount / words.length;
      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        best      = c.company;
      }
    }
    return best;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 2 — Time series from prowess_values_new
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch all annual values for a single KPI abbr for a ticker.
   * Returns null value for any period where the abbr is not found.
   *
   * Return shape identical to FinHelper.getTimeSeries.
   *
   * @param {string} ticker
   * @param {string} abbr
   * @returns {Promise<Array<{ callId: null, period, fiscal_year, quarter, call_date: null, value, abbrUsed }>>}
   */
  async getTimeSeries(ticker, abbr) {
    const prowessName = await this.resolveProwessName(ticker);
    if (!prowessName) return [];

    // Fetch all periods for this company (anchor), then join with abbr values
    const [allPeriods, kpiRows] = await Promise.all([
      this.prisma.prowessValueNew.findMany({
        where:    { company: prowessName, source_type: 'C' },
        select:   { fiscal_year: true, quarter: true },
        distinct: ['fiscal_year', 'quarter'],
        orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
      }),
      this.prisma.prowessValueNew.findMany({
        where:   { company: prowessName, kpi_abbr: abbr, source_type: 'C' },
        select:  { fiscal_year: true, quarter: true, value: true, multiplier: true },
      }),
    ]);

    // If no consolidated data exists for this company, fall back to standalone
    const [allPeriodsEff, kpiRowsEff] = allPeriods.length ? [allPeriods, kpiRows] : await Promise.all([
      this.prisma.prowessValueNew.findMany({
        where:    { company: prowessName, source_type: 'S' },
        select:   { fiscal_year: true, quarter: true },
        distinct: ['fiscal_year', 'quarter'],
        orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
      }),
      this.prisma.prowessValueNew.findMany({
        where:   { company: prowessName, kpi_abbr: abbr, source_type: 'S' },
        select:  { fiscal_year: true, quarter: true, value: true, multiplier: true },
      }),
    ]);

    const kpiMap = new Map(
      kpiRowsEff.map(r => [`${r.fiscal_year}|${r.quarter}`, r.value != null ? r.value / (r.multiplier || 1) : null])
    );

    return allPeriodsEff.map(p => {
      const value = kpiMap.get(`${p.fiscal_year}|${p.quarter}`) ?? null;
      return {
        callId:      null,
        period:      `${p.fiscal_year}-${p.quarter}`,
        fiscal_year: p.fiscal_year,
        quarter:     p.quarter,
        call_date:   null,
        value,
        abbrUsed:    value != null ? abbr : null,
      };
    });
  }

  /**
   * Fetch multiple KPI abbrs in a single DB round-trip, aligned to common periods.
   * Return shape identical to FinHelper.getTimeSeriesBatch.
   *
   * @param {string}   ticker
   * @param {string[]} abbrs
   * @returns {Promise<Record<string, Array<{ callId: null, period, fiscal_year, quarter, call_date: null, value, abbrUsed }>>>}
   */
  async getTimeSeriesBatch(ticker, abbrs) {
    const prowessName = await this.resolveProwessName(ticker);
    const result      = Object.fromEntries(abbrs.map(a => [a, []]));
    if (!prowessName) return result;

    let [allPeriods, kpiRows] = await Promise.all([
      this.prisma.prowessValueNew.findMany({
        where:    { company: prowessName, source_type: 'C' },
        select:   { fiscal_year: true, quarter: true },
        distinct: ['fiscal_year', 'quarter'],
        orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
      }),
      this.prisma.prowessValueNew.findMany({
        where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'C' },
        select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
      }),
    ]);

    // Fall back to standalone if no consolidated rows found for this company
    if (!allPeriods.length) {
      [allPeriods, kpiRows] = await Promise.all([
        this.prisma.prowessValueNew.findMany({
          where:    { company: prowessName, source_type: 'S' },
          select:   { fiscal_year: true, quarter: true },
          distinct: ['fiscal_year', 'quarter'],
          orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
        }),
        this.prisma.prowessValueNew.findMany({
          where:   { company: prowessName, kpi_abbr: { in: abbrs }, source_type: 'S' },
          select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
        }),
      ]);
    }

    return this._buildResult(abbrs, allPeriods, kpiRows);
  }

  /**
   * Annual-only batch: rows from prowess_new_* (audited annual CSV).
   * Prefers consolidated; falls back to standalone if no C rows exist.
   * All returned periods are fiscal-year Q4 full-year figures.
   */
  async getAnnualBatch(ticker, abbrs) {
    const prowessName = await this.resolveProwessName(ticker);
    const result      = Object.fromEntries(abbrs.map(a => [a, []]));
    if (!prowessName) return result;

    const annualPrefix = { startsWith: 'prowess_new_' };

    let [allPeriods, kpiRows] = await Promise.all([
      this.prisma.prowessValueNew.findMany({
        where:    { company: prowessName, callId: annualPrefix, source_type: 'C' },
        select:   { fiscal_year: true, quarter: true },
        distinct: ['fiscal_year', 'quarter'],
        orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
      }),
      this.prisma.prowessValueNew.findMany({
        where:   { company: prowessName, callId: annualPrefix, kpi_abbr: { in: abbrs }, source_type: 'C' },
        select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
      }),
    ]);

    if (!allPeriods.length) {
      [allPeriods, kpiRows] = await Promise.all([
        this.prisma.prowessValueNew.findMany({
          where:    { company: prowessName, callId: annualPrefix, source_type: 'S' },
          select:   { fiscal_year: true, quarter: true },
          distinct: ['fiscal_year', 'quarter'],
          orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
        }),
        this.prisma.prowessValueNew.findMany({
          where:   { company: prowessName, callId: annualPrefix, kpi_abbr: { in: abbrs }, source_type: 'S' },
          select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
        }),
      ]);
    }

    return this._buildResult(abbrs, allPeriods, kpiRows);
  }

  /**
   * Quarterly-only batch: P&L rows from prowess_qtr_* (quarterly CSV, period_type='quarterly').
   * Always standalone. Balance sheet snapshots excluded — use getAnnualBatch for those.
   */
  async getQuarterlyBatch(ticker, abbrs) {
    const prowessName = await this.resolveProwessName(ticker);
    const result      = Object.fromEntries(abbrs.map(a => [a, []]));
    if (!prowessName) return result;

    const [allPeriods, kpiRows] = await Promise.all([
      this.prisma.prowessValueNew.findMany({
        where:    { company: prowessName, callId: { startsWith: 'prowess_qtr_' }, period_type: 'quarterly' },
        select:   { fiscal_year: true, quarter: true },
        distinct: ['fiscal_year', 'quarter'],
        orderBy:  [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
      }),
      this.prisma.prowessValueNew.findMany({
        where:   { company: prowessName, callId: { startsWith: 'prowess_qtr_' }, period_type: 'quarterly', kpi_abbr: { in: abbrs } },
        select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, multiplier: true },
      }),
    ]);

    return this._buildResult(abbrs, allPeriods, kpiRows);
  }

  _buildResult(abbrs, allPeriods, kpiRows) {
    const result = Object.fromEntries(abbrs.map(a => [a, []]));
    const lookup = {};
    for (const r of kpiRows) {
      const key   = `${r.fiscal_year}|${r.quarter}`;
      const value = r.value != null ? r.value / (r.multiplier || 1) : null;
      if (!lookup[r.kpi_abbr]) lookup[r.kpi_abbr] = {};
      lookup[r.kpi_abbr][key] = value;
    }
    for (const abbr of abbrs) {
      result[abbr] = allPeriods.map(p => {
        const key   = `${p.fiscal_year}|${p.quarter}`;
        const value = lookup[abbr]?.[key] ?? null;
        return {
          callId:      null,
          period:      `${p.fiscal_year}-${p.quarter}`,
          fiscal_year: p.fiscal_year,
          quarter:     p.quarter,
          call_date:   null,
          value,
          abbrUsed:    value != null ? abbr : null,
        };
      });
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 5a — Derived KPI batch (reuses computeDerivedKpis from finDerivedKpis)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute derived KPIs (EBIT, ROCE, ROA, ROE, CAPEX, FCF) from prowess source data.
   * Uses the exact same computeDerivedKpis function as FinHelper.
   *
   * @param {string}  ticker
   * @param {boolean} [bfsi=false]
   */
  async getDerivedKpiBatch(ticker, bfsi = false) {
    const raw = await this.getTimeSeriesBatch(ticker, SOURCE_ABBRS);
    return computeDerivedKpis(raw, bfsi);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 3 — Stock-level (same interface as FinHelper)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Latest non-null annual value for any KPI.
   * Same return shape as FinHelper.stockKpiLatest.
   *
   * @param {string} ticker
   * @param {string} abbr
   */
  async stockKpiLatest(ticker, abbr) {
    const series     = await this.getTimeSeries(ticker, abbr);
    const withValues = series.filter(s => s.value != null);
    if (!withValues.length) return { value: null, abbrUsed: null, period: null, type: 'no_data' };
    const latest = withValues.at(-1);
    return { value: latest.value, abbrUsed: latest.abbrUsed, period: latest.period, type: 'latest_value' };
  }

  /**
   * CAGR for any KPI from annual prowess series.
   * spanYears = number of annual periods − 1 (prowess has no intra-year granularity).
   * Same return shape as FinHelper.stockKpiCagr.
   *
   * @param {string} ticker
   * @param {string} abbr
   * @param {number} [targetYears=3]   Not used for filtering; kept for API parity with FinHelper.
   */
  async stockKpiCagr(ticker, abbr, targetYears = 3) {
    const series     = await this.getTimeSeries(ticker, abbr);
    const withValues = series.filter(s => s.value != null);

    if (!withValues.length) return { value: null, type: 'no_data', periodsUsed: 0 };

    const latest = withValues.at(-1);
    if (withValues.length === 1) {
      return { value: latest.value, type: 'latest_value', periodsUsed: 1,
               abbrUsed: latest.abbrUsed, note: 'Only one annual period — CAGR not computable' };
    }

    const first     = withValues[0];
    const spanYears = withValues.length - 1; // prowess annual = 1 year per row

    if (first.value == null || first.value <= 0) {
      return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
               abbrUsed: latest.abbrUsed, note: 'Non-positive base — returning latest value' };
    }

    const cagrValue = cagr(first.value, latest.value, spanYears);
    if (cagrValue == null || isNaN(cagrValue)) {
      return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
               abbrUsed: latest.abbrUsed, note: 'CAGR undefined — returning latest value' };
    }

    return {
      value:       parseFloat(cagrValue.toFixed(2)),
      type:        spanYears >= 2 ? 'cagr' : 'partial_cagr',
      spanYears,
      periodsUsed: withValues.length,
      abbrUsed:    latest.abbrUsed,
      firstValue:  first.value,
      latestValue: latest.value,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 4 — Industry-level (same interface as FinHelper)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Market-cap-weighted average of the latest annual value across all tickers in an industry.
   *
   * @param {string}          industry
   * @param {string}          abbr
   * @param {Record<string,number>} [mcapMap]  ticker → market_cap_Cr (pre-fetched for efficiency)
   */
  async industryKpiAvg(industry, abbr, mcapMap = {}) {
    const tickers = await this._industryTickers(industry);
    if (!tickers.length) return { value: null, abbrUsed: null, sampleSize: 0 };

    const results = await Promise.allSettled(tickers.map(t => this.stockKpiLatest(t, abbr)));
    const valid   = results
      .filter(r => r.status === 'fulfilled' && r.value.value != null)
      .map((r, i) => ({ ...r.value, ticker: tickers[i] }));

    if (!valid.length) return { value: null, abbrUsed: null, sampleSize: 0 };

    const values  = valid.map(v => v.value);
    const weights = valid.map(v => mcapMap[v.ticker] ?? null);
    const avg     = weightedAverage(values, weights);

    return {
      value:      avg != null ? parseFloat(avg.toFixed(2)) : null,
      abbrUsed:   valid[0]?.abbrUsed ?? abbr,
      sampleSize: valid.length,
    };
  }

  /**
   * Average CAGR for any KPI across all tickers in an industry.
   *
   * @param {string} industry
   * @param {string} abbr
   * @param {number} [targetYears=3]
   */
  async industryKpiCagr(industry, abbr, targetYears = 3) {
    const tickers = await this._industryTickers(industry);
    if (!tickers.length) return { value: null, type: 'no_data', tickerCount: 0 };

    const results = await Promise.allSettled(
      tickers.map(t => this.stockKpiCagr(t, abbr, targetYears))
    );

    const cagrValues = results
      .filter(r => r.status === 'fulfilled' && r.value.value != null && !isNaN(r.value.value) && r.value.type.includes('cagr'))
      .map(r => r.value.value);

    const avg = average(cagrValues);
    return {
      value:            avg != null ? parseFloat(avg.toFixed(2)) : null,
      type:             'cagr',
      tickerCount:      tickers.length,
      validTickerCount: cagrValues.length,
      tickers,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 5 — Named wrappers (same as FinHelper)
  // ─────────────────────────────────────────────────────────────────────────────

  async stockRevCagr(ticker, targetYears = 3)       { return this.stockKpiCagr(ticker, 'REV_OP', targetYears); }
  async stockPatCagr(ticker, targetYears = 3)        { return this.stockKpiCagr(ticker, 'PAT', targetYears); }
  async stockRoceLatest(ticker)                      { return this.stockKpiLatest(ticker, 'ROCE'); }
  async stockEpsCagr(ticker, targetYears = 3)        { return this.stockKpiCagr(ticker, 'EPS_BASIC', targetYears); }

  async industryRevCagr(industry, targetYears = 3, mcapMap = {})  { return this.industryKpiCagr(industry, 'REV_OP', targetYears); }
  async industryPatCagr(industry, targetYears = 3)                { return this.industryKpiCagr(industry, 'PAT', targetYears); }
  async industryRoceAvg(industry, mcapMap = {})                   { return this.industryKpiAvg(industry, 'ROCE', mcapMap); }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  async _industryTickers(industry) {
    const rows = await this.prisma.earnings_calls.findMany({
      where:    { basic_industry: industry },
      select:   { company: true },
      distinct: ['company'],
    });
    return rows.map(r => r.company);
  }
}

module.exports = { ProwessHelper, normName };
