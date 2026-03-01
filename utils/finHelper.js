'use strict';

const { getHistoricPeForTickers } = require('../db-utils/getHistoricPe');

/**
 * FinHelper — financial KPI calculation utility
 *
 * Layers:
 *  1. Math primitives  — pure static functions (growth, CAGR, margin, ratio, average)
 *  2. Time series      — fetch KPI values from DB quarterly summaries (with substitute_kpis fallback)
 *  3. Generic stock    — stockKpiLatest / stockKpiCagr for any primary KPI abbr
 *  4. Generic industry — industryKpiAvg / industryKpiCagr for any primary KPI abbr
 *  5. Named wrappers   — stockEpsCagr, industryOpm etc. delegate to the generics above
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
    const fallbackAbbrs  = subRow?.substitutes ?? [];
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
  // Layer 3 — Generic stock-level calculations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Latest non-null value for any KPI from a ticker's time series.
   * Substitute fallback is handled by getTimeSeries.
   *
   * @param {string} ticker
   * @param {string} abbr  - primary KPI abbr (e.g. 'ROCE', 'FCF', 'OPM')
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
   * Substitute fallback is handled by getTimeSeries.
   *
   * @param {string} ticker
   * @param {string} abbr        - primary KPI abbr
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

    const cagrValue = FinHelper.cagr(first.value, latest.value, spanYears);
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
   * Substitute fallback is handled per-ticker by getTimeSeries.
   *
   * @param {string} industry
   * @param {string} abbr     - primary KPI abbr (e.g. 'OPM', 'ROCE', 'REV')
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

    const avg = FinHelper.average(valid.map(v => v.value));
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

    const avg = FinHelper.average(cagrValues);
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

  // ── EPS ──────────────────────────────────────────────────────────────────────
  /** EPS CAGR for a single stock. */
  async stockEpsCagr(ticker, targetYears = 5) {
    return this.stockKpiCagr(ticker, 'EPS', targetYears);
  }
  /** Average EPS CAGR across all tickers in an industry. */
  async industryEpsCagr(industry, targetYears = 5) {
    return this.industryKpiCagr(industry, 'EPS', targetYears);
  }

  // ── OPM ──────────────────────────────────────────────────────────────────────
  /** Average OPM across all tickers in an industry (substitute_kpis fallback applied). */
  async industryOpm(industry) {
    return this.industryKpiAvg(industry, 'OPM');
  }

  // ── REV (Revenue) ─────────────────────────────────────────────────────────────
  /** Revenue CAGR for a single stock. */
  async stockRevCagr(ticker, targetYears = 5) {
    return this.stockKpiCagr(ticker, 'REV', targetYears);
  }
  /** Average Revenue CAGR across all tickers in an industry. */
  async industryRevCagr(industry, targetYears = 5) {
    return this.industryKpiCagr(industry, 'REV', targetYears);
  }

  // ── PAT (Profit After Tax) ────────────────────────────────────────────────────
  /** PAT CAGR for a single stock. */
  async stockPatCagr(ticker, targetYears = 5) {
    return this.stockKpiCagr(ticker, 'PAT', targetYears);
  }
  /** Average PAT CAGR across all tickers in an industry. */
  async industryPatCagr(industry, targetYears = 5) {
    return this.industryKpiCagr(industry, 'PAT', targetYears);
  }

  // ── PBT (Profit Before Tax) ───────────────────────────────────────────────────
  /** PBT CAGR for a single stock. */
  async stockPbtCagr(ticker, targetYears = 5) {
    return this.stockKpiCagr(ticker, 'PBT', targetYears);
  }
  /** Average PBT CAGR across all tickers in an industry. */
  async industryPbtCagr(industry, targetYears = 5) {
    return this.industryKpiCagr(industry, 'PBT', targetYears);
  }

  // ── FCF (Free Cash Flow) ──────────────────────────────────────────────────────
  // Point-in-time preferred — FCF CAGR is unreliable when base year is negative.
  /** Latest FCF value for a single stock. */
  async stockFcfLatest(ticker) {
    return this.stockKpiLatest(ticker, 'FCF');
  }
  /** Average FCF across all tickers in an industry. */
  async industryFcfAvg(industry) {
    return this.industryKpiAvg(industry, 'FCF');
  }

  // ── DEBT (Total Debt) ─────────────────────────────────────────────────────────
  /** Latest Debt value for a single stock. */
  async stockDebtLatest(ticker) {
    return this.stockKpiLatest(ticker, 'DEBT');
  }
  /** Average Debt across all tickers in an industry. */
  async industryDebtAvg(industry) {
    return this.industryKpiAvg(industry, 'DEBT');
  }

  // ── INTEXP (Interest Expense) ─────────────────────────────────────────────────
  /** Latest Interest Expense for a single stock. */
  async stockIntexpLatest(ticker) {
    return this.stockKpiLatest(ticker, 'INTEXP');
  }
  /** Average Interest Expense across all tickers in an industry. */
  async industryIntexpAvg(industry) {
    return this.industryKpiAvg(industry, 'INTEXP');
  }

  // ── ROCE (Return on Capital Employed) ─────────────────────────────────────────
  // Point-in-time preferred — ROCE is a margin %, CAGR of a % is rarely used.
  /** Latest ROCE for a single stock. */
  async stockRoceLatest(ticker) {
    return this.stockKpiLatest(ticker, 'ROCE');
  }
  /** Average ROCE across all tickers in an industry. */
  async industryRoceAvg(industry) {
    return this.industryKpiAvg(industry, 'ROCE');
  }

  // ── CCC (Cash Conversion Cycle) ───────────────────────────────────────────────
  // Days metric — point-in-time comparison is more meaningful than CAGR.
  /** Latest CCC (days) for a single stock. */
  async stockCccLatest(ticker) {
    return this.stockKpiLatest(ticker, 'CCC');
  }
  /** Average CCC across all tickers in an industry. */
  async industryCccAvg(industry) {
    return this.industryKpiAvg(industry, 'CCC');
  }

  // ── CUST (Number of Customers) ────────────────────────────────────────────────
  // Growth rate is the meaningful signal for customer metrics.
  /** Customer count CAGR for a single stock. */
  async stockCustCagr(ticker, targetYears = 5) {
    return this.stockKpiCagr(ticker, 'CUST', targetYears);
  }
  /** Average Customer CAGR across all tickers in an industry. */
  async industryCustCagr(industry, targetYears = 5) {
    return this.industryKpiCagr(industry, 'CUST', targetYears);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Layer 5b — Computed ratios
  //
  // Each method tries the stored ratio KPI first. If missing, it fetches the
  // numerator and denominator via stockKpiLatest() — which automatically chains
  // through substitute_kpis, so component fallbacks are handled for free:
  //   EBIT    → PBT → PAT → EBITDA          (seeded in substitute_kpis)
  //   NETDEBT → DEBT                         (seeded in substitute_kpis)
  //   EBITDA  → EBIT → PAT → PBT            (seeded in substitute_kpis)
  //   TL      → DEBT                         (seeded in substitute_kpis)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Net Debt / EBITDA.
   * Tries stored NETDEBT_EBITDA → then computes NETDEBT ÷ EBITDA.
   * NETDEBT falls back to DEBT; EBITDA falls back to EBIT → PAT → PBT.
   */
  async computeNetDebtEbitda(ticker) {
    const stored = await this.stockKpiLatest(ticker, 'NETDEBT_EBITDA');
    if (stored.value != null) return { value: stored.value, abbrUsed: 'NETDEBT_EBITDA', computed: false };

    const [netDebtR, ebitdaR] = await Promise.all([
      this.stockKpiLatest(ticker, 'NETDEBT'), // NETDEBT → DEBT
      this.stockKpiLatest(ticker, 'EBITDA'),  // EBITDA  → EBIT → PAT → PBT
    ]);

    const value = FinHelper.ratio(netDebtR.value, ebitdaR.value);
    return {
      value:    value != null ? parseFloat(value.toFixed(2)) : null,
      abbrUsed: 'NETDEBT_EBITDA',
      computed: true,
      note:     `${netDebtR.abbrUsed ?? 'NETDEBT'} ÷ ${ebitdaR.abbrUsed ?? 'EBITDA'}`,
    };
  }

  /**
   * Debt / Equity ratio.
   * Tries stored DE → then computes DEBT ÷ EQ.
   * DEBT falls back via its own substitute chain (NETDEBT, DE, …).
   */
  async computeDeRatio(ticker) {
    const stored = await this.stockKpiLatest(ticker, 'DE');
    if (stored.value != null) return { value: stored.value, abbrUsed: 'DE', computed: false };

    const [debtR, eqR] = await Promise.all([
      this.stockDebtLatest(ticker),          // DEBT → NETDEBT → …
      this.stockKpiLatest(ticker, 'EQ'),     // EQ (no substitute — standalone)
    ]);

    const value = FinHelper.ratio(debtR.value, eqR.value);
    return {
      value:    value != null ? parseFloat(value.toFixed(2)) : null,
      abbrUsed: 'DE',
      computed: true,
      note:     `${debtR.abbrUsed ?? 'DEBT'} ÷ EQ`,
    };
  }

  /**
   * Interest Coverage ratio (EBIT / Interest Expense).
   * The INTEXP substitute chain includes IC and INTCOV — if those land first
   * the stored ratio is returned directly.
   * Otherwise computes EBIT ÷ INTEXP; EBIT falls back to PBT → PAT → EBITDA.
   */
  async computeIc(ticker) {
    const [ebitR, intexpR] = await Promise.all([
      this.stockKpiLatest(ticker, 'EBIT'),   // EBIT → PBT → PAT → EBITDA
      this.stockKpiLatest(ticker, 'INTEXP'), // INTEXP → FINCOS → IC → INTCOV → …
    ]);

    // Substitute resolution landed on a stored ratio — use it directly
    const ALREADY_RATIO = new Set(['IC', 'INTCOV']);
    if (intexpR.value != null && ALREADY_RATIO.has(intexpR.abbrUsed)) {
      return { value: intexpR.value, abbrUsed: intexpR.abbrUsed, computed: false };
    }

    const value = FinHelper.ratio(ebitR.value, intexpR.value);
    return {
      value:    value != null ? parseFloat(value.toFixed(2)) : null,
      abbrUsed: 'IC',
      computed: true,
      note:     `${ebitR.abbrUsed ?? 'EBIT'} ÷ ${intexpR.abbrUsed ?? 'INTEXP'}`,
    };
  }

  /**
   * Current Ratio.
   * Tries stored CR → then computes WC ÷ TL (schema definition).
   * TL falls back to DEBT as a rough proxy for total liabilities.
   */
  async computeCr(ticker) {
    const stored = await this.stockKpiLatest(ticker, 'CR');
    if (stored.value != null) return { value: stored.value, abbrUsed: 'CR', computed: false };

    const [wcR, tlR] = await Promise.all([
      this.stockKpiLatest(ticker, 'WC'), // WC (no substitute — standalone)
      this.stockKpiLatest(ticker, 'TL'), // TL → DEBT
    ]);

    const value = FinHelper.ratio(wcR.value, tlR.value);
    return {
      value:    value != null ? parseFloat(value.toFixed(2)) : null,
      abbrUsed: 'CR',
      computed: true,
      note:     `WC ÷ ${tlR.abbrUsed ?? 'TL'}`,
    };
  }

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
