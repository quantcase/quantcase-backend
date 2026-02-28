'use strict';

const { getHistoricPeForTickers } = require('../db-utils/getHistoricPe');

// Ordered fallback list for operating margin — index 0 = highest priority.
// Falls back further via substitute_kpis table at runtime.
const OPM_KPI_PRIORITY = ['OPM', 'EBITDA', 'EBITDAM', 'NIM', 'CTI'];

/**
 * FinHelper — financial KPI calculation utility
 *
 * Layers:
 *  1. Math primitives  — pure static functions (growth, CAGR, margin, ratio, average)
 *  2. Time series      — fetch KPI values from DB quarterly summaries
 *  3. Stock-level CAGR — EPS CAGR (DB) and P/E CAGR (pe_data table)
 *  4. Industry-level   — aggregate EPS and PE CAGR across all tickers in an industry
 */

class FinHelper {
  /**
   * @param {import('@prisma/client').PrismaClient} prisma
   */
  constructor(prisma) {
    this.prisma = prisma;
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
   * Market-cap-weighted average. Falls back to simple average when no valid weights exist.
   * @param {(number|null)[]} values
   * @param {(number|null)[]} weights
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
    return FinHelper.average(values);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 2 — Time series from DB summaries
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch all quarterly values for a KPI abbr across all periods of a ticker.
   * If the primary abbr yields no data for a period, falls back to substitutes
   * from the substitute_kpis table (ordered by priority, index 0 = highest).
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

    const summaries = await this.prisma.summary.findMany({
      where:  { callId: { in: calls.map(c => c.id) } },
      select: { callId: true, kpis: true },
    });
    const summaryMap = new Map(summaries.map(s => [s.callId, s.kpis]));

    // Load substitutes for this abbr once (ordered priority list)
    const subRow = await this.prisma.substituteKpi.findUnique({
      where: { primaryKpiAbbr: abbr },
    });
    const fallbackAbbrs = subRow?.substitutes ?? [];
    const abbrCandidates = [abbr, ...fallbackAbbrs];

    return calls.map(call => {
      const kpisArr = summaryMap.get(call.id) ?? [];
      if (!Array.isArray(kpisArr)) {
        return { callId: call.id, period: _periodLabel(call), fiscal_year: call.fiscal_year, quarter: call.quarter, call_date: call.call_date, value: null, abbrUsed: null };
      }

      // Try primary then substitutes in priority order
      for (const candidate of abbrCandidates) {
        const match = kpisArr.find(k => k.kpi_abbr === candidate && k.value != null);
        if (match) {
          const raw = parseFloat(match.value);
          return {
            callId:      call.id,
            period:      _periodLabel(call),
            fiscal_year: call.fiscal_year,
            quarter:     call.quarter,
            call_date:   call.call_date,
            value:       !isNaN(raw) ? raw : null,
            abbrUsed:    candidate,
          };
        }
      }

      return { callId: call.id, period: _periodLabel(call), fiscal_year: call.fiscal_year, quarter: call.quarter, call_date: call.call_date, value: null, abbrUsed: null };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 3 — Stock-level CAGR
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * EPS CAGR for a single stock from DB quarterly summaries.
   * Falls back to latest value when base EPS is non-positive or < 2 periods.
   */
  async stockEpsCagr(ticker, targetYears = 5) {
    const series     = await this.getTimeSeries(ticker, 'EPS');
    const withValues = series.filter(s => s.value != null);

    console.log(`[EPS] ${ticker} — ${series.length} periods total, ${withValues.length} with values`);
    withValues.forEach(s => console.log(`  ${s.period}  eps=${s.value}`));

    if (withValues.length === 0) {
      return { value: null, type: 'no_data', periodsUsed: 0 };
    }

    const latest = withValues.at(-1);
    if (withValues.length === 1) {
      return { value: latest.value, type: 'latest_value', periodsUsed: 1,
               note: 'Only one period available — CAGR not computable' };
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
               note: 'Zero time span' };
    }

    const cagrValue = FinHelper.cagr(first.value, latest.value, spanYears);
    if (cagrValue == null || isNaN(cagrValue)) {
      return { value: latest.value, type: 'latest_value', periodsUsed: withValues.length,
               note: 'CAGR undefined (negative/zero base EPS) — returning latest value' };
    }

    return {
      value:       parseFloat(cagrValue.toFixed(2)),
      type:        spanYears >= 4 ? '5yr_cagr' : 'partial_cagr',
      spanYears:   parseFloat(spanYears.toFixed(2)),
      periodsUsed: withValues.length,
      firstValue:  first.value,
      latestValue: latest.value,
    };
  }

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
    const avgPe    = FinHelper.average(qpe.map(q => q.avgPe));

    if (qpe.length === 1) {
      return { value: latestPe, type: 'latest_value', periodsUsed: 1, latestPe,
               avgPe, note: 'Only one quarter available' };
    }

    const firstYear = _quarterLabelToYear(qpe.at(0).quarter);
    const lastYear  = _quarterLabelToYear(qpe.at(-1).quarter);
    const spanYears = (firstYear != null && lastYear != null)
      ? (lastYear - firstYear)
      : qpe.length * 0.25;

    const firstPe = qpe.at(0).avgPe;

    if (spanYears <= 0) {
      return { value: latestPe, type: 'latest_value', periodsUsed: qpe.length,
               latestPe, avgPe: avgPe != null ? parseFloat(avgPe.toFixed(2)) : null,
               note: 'Zero time span' };
    }

    const cagrValue = FinHelper.cagr(firstPe, latestPe, spanYears);
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 4 — Industry-level CAGR
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Average EPS CAGR across all tickers in an industry.
   * Only tickers with computable CAGR (not latest_value fallbacks) are included.
   */
  async industryEpsCagr(industry, targetYears = 5) {
    const tickers = await this._industryTickers(industry);
    console.log(`[Industry EPS] "${industry}" — ${tickers.length} tickers:`, tickers);
    if (!tickers.length) return { value: null, type: 'no_data', tickerCount: 0 };

    const results = await Promise.allSettled(
      tickers.map(t => this.stockEpsCagr(t, targetYears))
    );

    results.forEach((r, i) => {
      const v = r.status === 'fulfilled'
        ? `value=${r.value.value}, type=${r.value.type}`
        : `REJECTED: ${r.reason?.message}`;
      console.log(`[Industry EPS] ${tickers[i]} → ${v}`);
    });

    const cagrValues = results
      .filter(r => r.status === 'fulfilled' && r.value.value != null && !isNaN(r.value.value) && r.value.type.includes('cagr'))
      .map(r => r.value.value);

    const avg = FinHelper.average(cagrValues);
    return {
      value:            avg != null ? parseFloat(avg.toFixed(2)) : null,
      type:             '5yr_cagr',
      tickerCount:      tickers.length,
      validTickerCount: cagrValues.length,
      tickers,
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

    const avgCagr   = FinHelper.average(cagrValues);
    const avgLatest = FinHelper.average(latestPes);
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
  // Layer 5 — Industry OPM
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Average OPM % across all summaries for tickers in an industry.
   * Tries OPM_KPI_PRIORITY in order, then any additional substitutes from the
   * substitute_kpis table, using the first abbr that yields numeric values.
   *
   * @param {string} industry - earnings_calls.basic_industry value
   * @returns {Promise<{ value: number|null, abbrUsed: string|null, sampleSize: number }>}
   */
  async industryOpm(industry) {
    const tickers = await this._industryTickers(industry);
    if (!tickers.length) return { value: null, abbrUsed: null, sampleSize: 0 };

    const calls = await this.prisma.earnings_calls.findMany({
      where:   { company: { in: tickers } },
      select:  { id: true },
    });
    const summaries = await this.prisma.summary.findMany({
      where:  { callId: { in: calls.map(c => c.id) } },
      select: { kpis: true },
    });

    const allKpis = summaries.flatMap(s => Array.isArray(s.kpis) ? s.kpis : []);

    // Build candidate list: static priority + DB substitutes for 'OPM'
    const subRow = await this.prisma.substituteKpi.findUnique({ where: { primaryKpiAbbr: 'OPM' } });
    const candidates = [...new Set([...OPM_KPI_PRIORITY, ...(subRow?.substitutes ?? [])])];

    for (const abbr of candidates) {
      const vals = allKpis
        .filter(k => k.kpi_abbr === abbr && k.value != null)
        .map(k => parseFloat(k.value))
        .filter(v => !isNaN(v));
      if (vals.length > 0) {
        const avg = parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2));
        return { value: avg, abbrUsed: abbr, sampleSize: vals.length };
      }
    }
    return { value: null, abbrUsed: null, sampleSize: 0 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  async _industryTickers(industry) {
    const rows = await this.prisma.summary.findMany({
      where:  { industryAnalysis: { path: ['industry'], equals: industry } },
      select: { callId: true },
    });
    // Extract unique tickers from callId (format: TICKER_FYXXXX_QX)
    return [...new Set(rows.map(r => r.callId.split('_FY')[0]))];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

function _periodLabel(call) {
  return call.quarter ? `${call.fiscal_year}-${call.quarter}` : call.fiscal_year;
}

/** "YYYYQN" → decimal year at midpoint of quarter. e.g. "2023Q1" → 2023.125 */
function _quarterLabelToYear(label) {
  const match = label && label.match(/^(\d{4})Q(\d)$/);
  if (!match) return null;
  return parseInt(match[1]) + (parseInt(match[2]) - 0.5) * 0.25;
}

module.exports = { FinHelper };
