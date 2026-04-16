'use strict';

const { getHistoricPeForTickers }          = require('../services/db/historicPe.db');
const { isBFSI }                           = require('./industryClassifier');
const { cagr, average, yoyGrowth, periodLabel, quarterLabelToYear } = require('./finMath');
const { SOURCE_ABBRS, computeDerivedKpis } = require('./finDerivedKpis');

/**
 * FinHelper — financial KPI calculation utility
 *
 * Layers:
 *  1. Math primitives  — see finMath.js
 *  2. Time series      — fetch KPI values from DB quarterly summaries
 *  3. Generic stock    — stockKpiLatest / stockKpiCagr for any primary KPI abbr
 *  4. Generic industry — industryKpiAvg / industryKpiCagr for any primary KPI abbr
 *  5. Named wrappers   — stockEpsCagr, industryOpm etc. delegate to the generics above
 *  5a. Derived KPIs    — see finDerivedKpis.js
 *  5b. Computed ratios — stored KPI only (returns null if not found)
 *  6. PE (special)     — reads pe_data table, not summary KPIs
 */

class FinHelper {
  /**
   * @param {import('@prisma/client').PrismaClient} prisma
   */
  constructor(prisma) {
    this.prisma = prisma;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 2 — Time series from DB summaries
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch all quarterly values for a KPI abbr across all periods of a ticker.
   * Returns null value for any period where the abbr is not found.
   *
   * @param {string} ticker    - earnings_calls.company
   * @param {string} abbr      - KPI abbreviation e.g. 'EPS'
   * @returns {Promise<Array<{ callId, period, fiscal_year, quarter, call_date, value, abbrUsed }>>}
   */
  async getTimeSeries(ticker, abbr) {
    const calls = await this.prisma.earnings_calls.findMany({
      where:   { company: ticker },
      select:  { id: true, fiscal_year: true, quarter: true, call_date: true },
      orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    });
    if (!calls.length) return [];

    const kpiRows = await this.prisma.kpiValue.findMany({
      where:  { callId: { in: calls.map(c => c.id) }, kpi_abbr: abbr },
      select: { callId: true, value: true, multiplier: true },
    });
    const kpiMap = new Map(kpiRows.map(r => [r.callId, r.value / (r.multiplier || 1)]));

    return calls.map(call => {
      const raw   = kpiMap.get(call.id);
      const value = raw != null && !isNaN(raw) ? raw : null;
      return {
        callId:      call.id,
        period:      periodLabel(call),
        fiscal_year: call.fiscal_year,
        quarter:     call.quarter,
        call_date:   call.call_date,
        value,
        abbrUsed:    value != null ? abbr : null,
      };
    });
  }

  /**
   * Fetch all quarterly values for multiple KPI abbrs in a single DB round-trip.
   * Returns a map of abbr → time-series array (same shape as getTimeSeries).
   *
   * @param {string}   ticker
   * @param {string[]} abbrs  - e.g. ['REV_OP', 'PAT', 'EBIT', ...]
   * @returns {Promise<Record<string, Array<{ callId, period, fiscal_year, quarter, call_date, value, abbrUsed }>>>}
   */
  async getTimeSeriesBatch(ticker, abbrs) {
    const calls = await this.prisma.earnings_calls.findMany({
      where:   { company: ticker },
      select:  { id: true, fiscal_year: true, quarter: true, call_date: true },
      orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    });

    const result = Object.fromEntries(abbrs.map(a => [a, []]));
    if (!calls.length) return result;

    const callIds = calls.map(c => c.id);
    const kpiRows = await this.prisma.kpiValue.findMany({
      where:  { callId: { in: callIds }, kpi_abbr: { in: abbrs } },
      select: { callId: true, kpi_abbr: true, value: true, multiplier: true, start_date: true, end_date: true },
    });

    // Build nested map: callId → abbr → { displayValue, start_date, end_date }
    const kpiMap = {};
    for (const row of kpiRows) {
      if (!kpiMap[row.callId]) kpiMap[row.callId] = {};
      if (kpiMap[row.callId][row.kpi_abbr] === undefined) {
        kpiMap[row.callId][row.kpi_abbr] = {
          value:      row.value / (row.multiplier || 1),
          start_date: row.start_date ?? null,
          end_date:   row.end_date   ?? null,
        };
      }
    }

    for (const call of calls) {
      const base = {
        callId:      call.id,
        period:      periodLabel(call),
        fiscal_year: call.fiscal_year,
        quarter:     call.quarter,
        call_date:   call.call_date,
      };
      for (const abbr of abbrs) {
        const entry = kpiMap[call.id]?.[abbr];
        const raw   = entry?.value;
        const value = raw != null && !isNaN(raw) ? raw : null;
        result[abbr].push({
          ...base, value, abbrUsed: value != null ? abbr : null,
          start_date: entry?.start_date ?? null,
          end_date:   entry?.end_date   ?? null,
        });
      }
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 3 — Generic stock-level calculations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Latest non-null value for any KPI from a ticker's time series.
   *
   * @param {string} ticker
   * @param {string} abbr  - KPI abbr (e.g. 'ROCE', 'FCF', 'OPM')
   * @returns {Promise<{ value: number|null, abbrUsed: string|null, period: string|null, type: string }>}
   */
  async stockKpiLatest(ticker, abbr) {
    const series     = await this.getTimeSeries(ticker, abbr);
    const withValues = series.filter(s => s.value != null);
    if (!withValues.length) return { value: null, abbrUsed: null, period: null, type: 'no_data' };
    const latest = withValues.at(-1);
    return { value: latest.value, abbrUsed: latest.abbrUsed, period: latest.period, type: 'latest_value' };
  }

  /**
   * CAGR for any KPI from a ticker's time series.
   * Falls back to latest value when base is non-positive or < 2 periods.
   *
   * @param {string} ticker
   * @param {string} abbr        - KPI abbr
   * @param {number} targetYears
   */
  async stockKpiCagr(ticker, abbr, targetYears = 5) {
    const series     = await this.getTimeSeries(ticker, abbr);
    const withValues = series.filter(s => s.value != null);

    console.log(`[${abbr}] ${ticker} — ${series.length} periods total, ${withValues.length} with values`);
    withValues.forEach(s => console.log(`  ${s.period}  ${abbr}=${s.value}  (abbrUsed=${s.abbrUsed})`));

    if (withValues.length === 0) {
      return { value: null, type: 'no_data', periodsUsed: 0 };
    }

    const latest = withValues.at(-1);
    if (withValues.length === 1) {
      return { value: latest.value, type: 'latest_value', periodsUsed: 1,
               abbrUsed: latest.abbrUsed, note: 'Only one period available — CAGR not computable' };
    }

    const first = withValues.at(0);
    let spanYears;
    if (first.call_date && latest.call_date) {
      const ms = new Date(latest.call_date) - new Date(first.call_date);
      spanYears = ms / (1000 * 60 * 60 * 24 * 365.25);
    } else {
      spanYears = withValues.length / 4;
    }

    if (spanYears <= 0) {
      return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
               abbrUsed: latest.abbrUsed, note: 'Zero time span' };
    }

    const cagrValue = cagr(first.value, latest.value, spanYears);
    if (cagrValue == null || isNaN(cagrValue)) {
      return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
               abbrUsed: latest.abbrUsed, note: 'CAGR undefined (negative/zero base) — returning latest value' };
    }

    return {
      value:       parseFloat(cagrValue.toFixed(2)),
      type:        spanYears >= 4 ? '5yr_cagr' : 'partial_cagr',
      spanYears:   parseFloat(spanYears.toFixed(2)),
      periodsUsed: withValues.length,
      abbrUsed:    latest.abbrUsed,
      firstValue:  first.value,
      latestValue: latest.value,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 4 — Generic industry-level calculations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Simple average of the latest value for any KPI across all tickers in an industry.
   *
   * @param {string} industry
   * @param {string} abbr     - KPI abbr (e.g. 'OPM', 'ROCE', 'REV')
   * @returns {Promise<{ value: number|null, abbrUsed: string|null, sampleSize: number }>}
   */
  async industryKpiAvg(industry, abbr) {
    const tickers = await this._industryTickers(industry);
    if (!tickers.length) return { value: null, abbrUsed: null, sampleSize: 0 };

    const results = await Promise.allSettled(tickers.map(t => this.stockKpiLatest(t, abbr)));
    const valid   = results
      .filter(r => r.status === 'fulfilled' && r.value.value != null)
      .map(r => r.value);

    if (!valid.length) return { value: null, abbrUsed: null, sampleSize: 0 };

    const avg = average(valid.map(v => v.value));
    return {
      value:      avg != null ? parseFloat(avg.toFixed(2)) : null,
      abbrUsed:   valid[0]?.abbrUsed ?? abbr,
      sampleSize: valid.length,
    };
  }

  /**
   * Average CAGR for any KPI across all tickers in an industry.
   * Only tickers with a computable CAGR (not latest_value fallbacks) are included.
   *
   * @param {string} industry
   * @param {string} abbr        - primary KPI abbr (e.g. 'EPS', 'REV', 'ROCE')
   * @param {number} targetYears
   */
  async industryKpiCagr(industry, abbr, targetYears = 5) {
    const tickers = await this._industryTickers(industry);
    console.log(`[Industry ${abbr}] "${industry}" — ${tickers.length} tickers:`, tickers);
    if (!tickers.length) return { value: null, type: 'no_data', tickerCount: 0 };

    const results = await Promise.allSettled(
      tickers.map(t => this.stockKpiCagr(t, abbr, targetYears))
    );

    results.forEach((r, i) => {
      const v = r.status === 'fulfilled'
        ? `value=${r.value.value}, type=${r.value.type}`
        : `REJECTED: ${r.reason?.message}`;
      console.log(`[Industry ${abbr}] ${tickers[i]} → ${v}`);
    });

    const cagrValues = results
      .filter(r => r.status === 'fulfilled' && r.value.value != null && !isNaN(r.value.value) && r.value.type.includes('cagr'))
      .map(r => r.value.value);

    const avg = average(cagrValues);
    return {
      value:            avg != null ? parseFloat(avg.toFixed(2)) : null,
      type:             '5yr_cagr',
      tickerCount:      tickers.length,
      validTickerCount: cagrValues.length,
      tickers,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 5 — Named wrappers for every primary_kpi_abbr in substitute_kpis
  //           (used by controllers — do not rename existing ones)
  // ─────────────────────────────────────────────────────────────────────────────

  // ── EPS_BASIC ─────────────────────────────────────────────────────────────────
  async stockEpsCagr(ticker, targetYears = 5)   { return this.stockKpiCagr(ticker, 'EPS_BASIC', targetYears); }
  async industryEpsCagr(industry, targetYears = 5) { return this.industryKpiCagr(industry, 'EPS_BASIC', targetYears); }

  // ── OPM ──────────────────────────────────────────────────────────────────────
  async industryOpm(industry)                   { return this.industryKpiAvg(industry, 'EBITDA_MARGIN'); }

  // ── REV_OP (Revenue from Operations) ─────────────────────────────────────────
  async stockRevCagr(ticker, targetYears = 5)   { return this.stockKpiCagr(ticker, 'REV_OP', targetYears); }
  async industryRevCagr(industry, targetYears = 5) { return this.industryKpiCagr(industry, 'REV_OP', targetYears); }

  // ── PAT (Profit After Tax) ────────────────────────────────────────────────────
  async stockPatCagr(ticker, targetYears = 5)   { return this.stockKpiCagr(ticker, 'PAT', targetYears); }
  async industryPatCagr(industry, targetYears = 5) { return this.industryKpiCagr(industry, 'PAT', targetYears); }

  // ── PBT (Profit Before Tax) ───────────────────────────────────────────────────
  async stockPbtCagr(ticker, targetYears = 5)   { return this.stockKpiCagr(ticker, 'PBT', targetYears); }
  async industryPbtCagr(industry, targetYears = 5) { return this.industryKpiCagr(industry, 'PBT', targetYears); }

  // ── FCF — point-in-time preferred (base-year sign issues make CAGR unreliable)
  async stockFcfLatest(ticker)                  { return this.stockKpiLatest(ticker, 'FCF'); }
  async industryFcfAvg(industry)                { return this.industryKpiAvg(industry, 'FCF'); }

  // ── DEBT (Total Debt) ─────────────────────────────────────────────────────────
  async stockDebtLatest(ticker)                 { return this.stockKpiLatest(ticker, 'DEBT'); }
  async industryDebtAvg(industry)               { return this.industryKpiAvg(industry, 'DEBT'); }

  // ── INTEXP (Interest Expense) ─────────────────────────────────────────────────
  async stockIntexpLatest(ticker)               { return this.stockKpiLatest(ticker, 'INTEXP'); }
  async industryIntexpAvg(industry)             { return this.industryKpiAvg(industry, 'INTEXP'); }

  // ── ROCE — point-in-time preferred (% metric, CAGR rarely used)
  async stockRoceLatest(ticker)                 { return this.stockKpiLatest(ticker, 'ROCE'); }
  async industryRoceAvg(industry)               { return this.industryKpiAvg(industry, 'ROCE'); }

  // ── CCC (Cash Conversion Cycle) — days metric, point-in-time more meaningful
  async stockCccLatest(ticker)                  { return this.stockKpiLatest(ticker, 'CCC'); }
  async industryCccAvg(industry)                { return this.industryKpiAvg(industry, 'CCC'); }

  // ── CUST (Number of Customers) ────────────────────────────────────────────────
  async stockCustCagr(ticker, targetYears = 5)  { return this.stockKpiCagr(ticker, 'CUST', targetYears); }
  async industryCustCagr(industry, targetYears = 5) { return this.industryKpiCagr(industry, 'CUST', targetYears); }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 5a — Derived KPI batch (see finDerivedKpis.js for formulas)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * @param {string}  ticker
   * @param {boolean} [bfsi=false]
   */
  async getDerivedKpiBatch(ticker, bfsi = false) {
    const raw = await this.getTimeSeriesBatch(ticker, SOURCE_ABBRS);
    return computeDerivedKpis(raw, bfsi);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 5c — Operating Leverage Metrics
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Pre-compute YoY growth metrics for operating leverage analysis.
   * Uses Q4 annual data to compare latest vs prior year.
   *
   * @param {string}  ticker
   * @param {boolean} [bfsi=false]
   * @returns {Promise<{ revGrowthYoy: number|null, ebitGrowthYoy: number|null, leverageSpread: number|null }>}
   */
  async computeOperatingLeverageMetrics(ticker, bfsi = false) {
    const [rawBatch, derivedBatch] = await Promise.all([
      this.getTimeSeriesBatch(ticker, ['REV_OP']),
      this.getDerivedKpiBatch(ticker, bfsi),
    ]);

    const q4Filter = series => (series ?? []).filter(s => s.quarter === 'Q4');

    const revQ4  = q4Filter(rawBatch['REV_OP']);
    const ebitQ4 = q4Filter(derivedBatch['EBIT']);

    const revGrowthYoy  = revQ4.length >= 2  ? yoyGrowth(revQ4)  : null;
    const ebitGrowthYoy = ebitQ4.length >= 2 ? yoyGrowth(ebitQ4) : null;
    const leverageSpread = (revGrowthYoy != null && ebitGrowthYoy != null)
      ? parseFloat((ebitGrowthYoy - revGrowthYoy).toFixed(1))
      : null;

    return { revGrowthYoy, ebitGrowthYoy, leverageSpread };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 5b — Computed ratios (stored KPI only — returns null if not found)
  // ─────────────────────────────────────────────────────────────────────────────

  async computeNetDebtEbitda(ticker) { return this.stockKpiLatest(ticker, 'NETDEBT_EBITDA'); }
  async computeDeRatio(ticker)       { return this.stockKpiLatest(ticker, 'DE'); }
  async computeIc(ticker)            { return this.stockKpiLatest(ticker, 'IC'); }
  async computeCr(ticker)            { return this.stockKpiLatest(ticker, 'CR'); }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 6 — PE (reads pe_data table, not summary KPIs)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * P/E CAGR for a single stock from quarterly PE history (pe_data table).
   */
  async stockPeCagr(ticker, targetYears = 5) {
    const [result] = await getHistoricPeForTickers([ticker]);
    console.log(`[PE] ${ticker} — ${result?.quarterlyPe?.length ?? 0} quarterly buckets`);

    if (!result || result.error) {
      return { value: null, type: result?.error ? 'error' : 'no_data', periodsUsed: 0 };
    }

    const qpe = result.quarterlyPe ?? [];
    if (qpe.length === 0) return { value: null, type: 'no_data', periodsUsed: 0 };

    qpe.forEach(q => console.log(`  [PE] ${q.quarter}  avgPe=${q.avgPe}  dataPoints=${q.dataPoints}`));

    const latestPe = qpe.at(-1).avgPe;
    const avgPe    = average(qpe.map(q => q.avgPe));

    if (qpe.length === 1) {
      return { value: latestPe, type: 'latest_value', periodsUsed: 1, latestPe,
               avgPe, note: 'Only one quarter available' };
    }

    const firstYear = quarterLabelToYear(qpe.at(0).quarter);
    const lastYear  = quarterLabelToYear(qpe.at(-1).quarter);
    const spanYears = (firstYear != null && lastYear != null)
      ? (lastYear - firstYear)
      : qpe.length * 0.25;

    const firstPe = qpe.at(0).avgPe;

    if (spanYears <= 0) {
      return { value: latestPe, type: 'latest_value', periodsUsed: qpe.length,
               latestPe, avgPe: avgPe != null ? parseFloat(avgPe.toFixed(2)) : null,
               note: 'Zero time span' };
    }

    const cagrValue = cagr(firstPe, latestPe, spanYears);
    if (cagrValue == null || isNaN(cagrValue)) {
      return { value: latestPe, type: 'latest_value', periodsUsed: qpe.length,
               latestPe, avgPe: avgPe != null ? parseFloat(avgPe.toFixed(2)) : null,
               note: 'CAGR undefined — returning latest PE' };
    }

    return {
      value:       parseFloat(cagrValue.toFixed(2)),
      type:        spanYears >= 4 ? '5yr_cagr' : 'partial_cagr',
      spanYears:   parseFloat(spanYears.toFixed(2)),
      periodsUsed: qpe.length,
      firstPe,
      latestPe,
      avgPe:       avgPe != null ? parseFloat(avgPe.toFixed(2)) : null,
    };
  }

  /**
   * Average P/E CAGR across all tickers in an industry.
   */
  async industryPeCagr(industry, targetYears = 5) {
    const tickers = await this._industryTickers(industry);
    console.log(`[Industry PE] "${industry}" — ${tickers.length} tickers:`, tickers);
    if (!tickers.length) return { value: null, type: 'no_data', tickerCount: 0 };

    const results = await Promise.allSettled(
      tickers.map(t => this.stockPeCagr(t, targetYears))
    );

    const settled = results.map((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`[Industry PE] ${tickers[i]} → value=${r.value.value}, type=${r.value.type}, latestPe=${r.value.latestPe}`);
        return r.value;
      }
      console.log(`[Industry PE] ${tickers[i]} → REJECTED:`, r.reason?.message);
      return null;
    }).filter(Boolean);

    const cagrValues = settled.filter(r => r.value != null && !isNaN(r.value) && r.type.includes('cagr')).map(r => r.value);
    const latestPes  = settled.filter(r => r.latestPe != null && !isNaN(r.latestPe)).map(r => r.latestPe);

    const avgCagr   = average(cagrValues);
    const avgLatest = average(latestPes);
    return {
      value:            avgCagr   != null ? parseFloat(avgCagr.toFixed(2))   : null,
      type:             '5yr_cagr',
      tickerCount:      tickers.length,
      validTickerCount: cagrValues.length,
      avgLatestPe:      avgLatest != null ? parseFloat(avgLatest.toFixed(2)) : null,
      tickers,
    };
  }

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

module.exports = { FinHelper };
