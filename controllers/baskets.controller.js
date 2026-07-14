'use strict';

const prisma = require('../config/prisma');
const peerIdentity = require('../lib/peerIdentity');
const { resolveMetric, resolveTechnicalIndicators } = require('../utils/formulaRegistry/index');
const { fetchMarketSnapshots, fetchOhlcvBars, fetchPeTimeSeriesBatch } = require('../utils/formulaRegistry/dataFetcherMarket');
const { fetchKpiMapsMultiBatch } = require('../utils/formulaRegistry/dataFetcher');

// ── Basket definitions ────────────────────────────────────────────────────────
// The 11 screens from "Screens for Quantcase.txt", grouped into 3 categories.
// Conditions text is the admin's literal spec, shown to the frontend as-is.

const BASKETS = [
  {
    id: 'small-size-solid-fundamentals',
    category: 'Value & Quality',
    title: 'Small size, solid fundamentals',
    description: 'Profitable, low-debt micro-caps growing sales for 3 years, priced below their historical PE and cheap relative to growth (PEG < 1)',
    conditions: 'Market Capitalization >500 AND <2000; Net profit >0; Sales growth 3Years >0; Debt to equity <1; EPS >0; Price to Earning < Historical PE 5Years; PEG Ratio <1',
    columns: ['symbol', 'companyName', 'marketCapCr', 'netProfitCr', 'salesGrowth3y', 'debtEquity', 'eps', 'pe', 'historicalPe5y', 'peg'],
    needs: { fundamentals: true, bars: false },
  },
  {
    id: 'profit-momentum-reasonably-priced',
    category: 'Growth & Turnaround',
    title: 'Profit momentum, reasonably priced',
    description: 'Net profit growing every quarter for a year, with strong margins and priced reasonably relative to earnings and growth.',
    conditions: 'Net Profit grew every quarter over the last 4 quarters (QoQ); PEG Ratio <1; Market Capitalization >1000; OPM >15; Price to Earning <30',
    columns: ['symbol', 'companyName', 'peg', 'marketCapCr', 'opm', 'pe', 'netProfitCr'],
    needs: { fundamentals: true, bars: false, quarterly: true },
  },
  {
    id: 'quality-compounders-at-a-discount',
    category: 'Value & Quality',
    title: 'Quality compounders at a discount',
    description: 'Long-term earnings growth with strong ROE and low debt, trading cheap versus its own history and its industry.',
    conditions: 'EPS growth 5Years >15 AND 3Years >12; EPS last year > EPS preceding year; Price to Earning < Historical PE 3Years AND < Historical PE 5Years AND < PEG Ratio * 100; EPS >0; ROE >12; Debt to equity <1; Sales growth 5years >10; Price to Earning < Industry PE; Market Capitalization >1000',
    columns: ['symbol', 'companyName', 'epsGrowth5y', 'epsGrowth3y', 'pe', 'historicalPe3y', 'historicalPe5y', 'peg', 'roe', 'debtEquity', 'salesGrowth5y', 'industryPe', 'marketCapCr'],
    needs: { fundamentals: true, bars: false, historicalPe: true, industryPe: true },
  },
  {
    id: 'down-50pct-fundamentals-strong',
    category: 'Growth & Turnaround',
    title: 'Down 50%, fundamentals still strong',
    description: 'Strong growth, high returns, low debt and solid cash flow — priced 50%+ below its all-time high.',
    conditions: 'Market Capitalization >1000; Sales growth 5Years >10; Profit growth 5Years >10; ROCE >15; ROE >15; Debt to equity <0.5; PEG Ratio <2; EPS growth 3Years >0; Current ratio >1.2; Free cash flow 3years >0; Current price < 0.5 × High price all time',
    columns: ['symbol', 'companyName', 'marketCapCr', 'salesGrowth5y', 'profitGrowth5y', 'roce', 'roe', 'debtEquity', 'peg', 'epsGrowth3y', 'currentRatio', 'fcf', 'distFromAthPct'],
    needs: { fundamentals: true, bars: true },
  },
  {
    id: 'cheap-on-book-strong-returns',
    category: 'Value & Quality',
    title: 'Cheap on book, strong returns',
    description: 'Trading below 2x book value with healthy ROE and ROCE above 12%, low debt and cash flow backing reported profits.',
    conditions: 'Price to book value <2; ROE >12; ROCE >12; Market Capitalization >1000; OCF/PAT >0.8; Debt to equity <0.5',
    columns: ['symbol', 'companyName', 'pb', 'roe', 'roce', 'marketCapCr', 'ocfPat', 'debtEquity'],
    needs: { fundamentals: true, bars: false },
  },
  {
    id: 'profit-growing-faster-than-sales',
    category: 'Growth & Turnaround',
    title: 'Profit growing faster than sales',
    description: 'Fast YoY sales and profit growth, with profit outpacing sales and margins expanding quarter-on-quarter.',
    conditions: 'YoY Quarterly Sales Growth >15%; YoY Quarterly Profit Growth >25%; Profit Growth > 1.5× Sales Growth; OPM latest quarter > 1.1× OPM preceding quarter; ROCE >15%; OCF/PAT >0.8; Market Capitalization >500',
    columns: ['symbol', 'companyName', 'salesGrowthYoyQ', 'profitGrowthYoyQ', 'opmLatestQ', 'opmPrevQ', 'roce', 'ocfPat', 'marketCapCr'],
    needs: { fundamentals: true, bars: false, quarterly: true },
  },
  {
    id: 'near-lows-quality-intact',
    category: 'Growth & Turnaround',
    title: 'Near lows, quality intact',
    description: 'Trading near its 52-week low and 50%+ below all-time high, but still profitable with strong capital returns and manageable debt.',
    conditions: 'Current price < 0.5 × High price all time; Current price <= 1.10 × Low price (52w); Market Capitalization >500; Profit after tax >0; ROCE >15; Debt to equity <1',
    columns: ['symbol', 'companyName', 'marketCapCr', 'distFromAthPct', 'distFrom52wLowPct', 'netProfitCr', 'roce', 'debtEquity'],
    needs: { fundamentals: true, bars: true },
  },
  {
    id: 'golden-crossover',
    category: 'Technical Signals',
    title: 'Golden crossover',
    description: '50-day average just crossed above the 200-day average — a classic bullish momentum signal.',
    conditions: 'DMA 50 > DMA 200; DMA 50 (previous day) < DMA 200 (previous day); Market Capitalization >500',
    columns: ['symbol', 'companyName', 'marketCapCr', 'sma50', 'sma200', 'close'],
    needs: { fundamentals: false, bars: true },
  },
  {
    id: 'oversold-on-rsi',
    category: 'Technical Signals',
    title: 'Oversold on RSI',
    description: 'RSI(14) below 30 signals the stock may be oversold — a potential bounce candidate, filtered to exclude micro-caps.',
    conditions: 'RSI(14) <30; Market Capitalization >500',
    columns: ['symbol', 'companyName', 'marketCapCr', 'rsi14', 'close'],
    needs: { fundamentals: false, bars: true },
  },
  {
    id: 'four-mas-in-one-candle',
    category: 'Technical Signals',
    title: '4 moving averages in one candle',
    description: 'A rare confluence zone often watched for a breakout or breakdown.',
    conditions: 'Market Capitalization >1000; Low price <= SMA20 <= High price; Low price <= SMA50 <= High price; Low price <= SMA100 <= High price; Low price <= SMA200 <= High price',
    columns: ['symbol', 'companyName', 'marketCapCr', 'sma20', 'sma50', 'sma100', 'sma200', 'low', 'high'],
    needs: { fundamentals: false, bars: true },
  },
  {
    id: 'power-candle',
    category: 'Technical Signals',
    title: 'Power Candle',
    description: 'Strong single-day buying — often an early signal of more upside ahead.',
    conditions: 'Market Capitalization >1000; Close price = High price; (High − Low) = Max(High − Low) of last 7 days; Open price < (High + Low) / 2',
    columns: ['symbol', 'companyName', 'marketCapCr', 'close', 'high', 'low', 'open'],
    needs: { fundamentals: false, bars: true },
  },
];

// ── Concurrency helper ────────────────────────────────────────────────────────
// Small worker-pool mirroring utils/industryIntelligence/index.js's pMap — keeps
// per-candidate DB fanout (fundamentals/bars) bounded under prisma's connection_limit.

async function pMap(items, fn, limit = 15) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function r2(v) {
  return v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
}

// ── Stage 1: universe + bulk cheap filter (one query, all symbols) ───────────

let _universeCache = null;
function getUniverse() {
  if (_universeCache) return _universeCache;
  const { rows } = peerIdentity.load();
  const seen = new Set();
  const list = [];
  for (const row of rows) {
    const sym = (row[peerIdentity.COL_NSE_SYMBOL] || '').trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    list.push(sym);
  }
  _universeCache = list;
  return list;
}

/**
 * Bulk market snapshot for the whole universe, resolved through the registry
 * (values are already stored in nse_equity_new — resolveMetric's stored-value
 * short-circuit makes this a free pass-through, no extra DB cost).
 * Returns { [symbol]: { kpiMap, basicIndustry, companyName } }.
 */
async function buildMarketMap() {
  const symbols = getUniverse();
  const snapshots = await fetchMarketSnapshots(prisma, symbols);
  const marketMap = {};
  for (const sym of symbols) {
    const snap = snapshots[sym];
    if (!snap || snap.close == null) continue;
    const kpiMap = {
      PRICE: snap.close,
      TTM_EPS: snap.eps,
      MARKET_CAP_CR: snap.market_cap_cr,
      PE_TTM: snap.pe,
    };
    const identity = peerIdentity.getIdentity(sym);
    marketMap[sym] = {
      kpiMap,
      basicIndustry: identity?.basicIndustry ?? null,
      companyName: identity?.companyName ?? null,
    };
  }
  return marketMap;
}

/** Per-industry average PE, built from the same bulk snapshot (screen 3 only). */
function buildIndustryPeMap(marketMap) {
  const groups = {};
  for (const sym of Object.keys(marketMap)) {
    const { kpiMap, basicIndustry } = marketMap[sym];
    if (!basicIndustry) continue;
    const pe = resolveMetric('PE_TTM', { kpiMap }).value;
    if (pe == null || pe <= 0) continue;
    (groups[basicIndustry] ??= []).push(pe);
  }
  const industryPe = {};
  for (const [industry, list] of Object.entries(groups)) {
    industryPe[industry] = list.reduce((s, v) => s + v, 0) / list.length;
  }
  return industryPe;
}

// ── Stage 2: fundamentals for candidates only ─────────────────────────────────
//
// Batched, not per-candidate: fetchKpiMapsMultiBatch/fetchPeTimeSeriesBatch pull
// ALL candidates in 1-2 queries (WHERE company = ANY(...)), then every candidate
// is built and filtered synchronously in-process. Profiling on a 578-candidate
// screen showed the old per-candidate approach cost ~180s of cumulative DB query
// time (round-trip latency dominated, not query cost) even though 15-way
// concurrency hid most of it behind a ~12s wall time — batching removes the
// round-trip multiplication entirely, mirroring how Stage 1 already batches.

// EPS_BASIC has noticeably sparser coverage in prowess_values_new than EPS_DILUTED
// (~37k vs ~46k rows, close to PAT's ~47k) — fall back to diluted wherever basic is missing.
function epsOf(kpiMap) {
  return kpiMap.EPS_BASIC ?? kpiMap.EPS_DILUTED ?? null;
}

/** Ascending-by-year { value, fiscal_year } series for a kpi abbr, from DESC periods. */
function seriesFromPeriods(periods, abbr) {
  const accessor = abbr === 'EPS_BASIC' ? (km => epsOf(km)) : (km => km[abbr] ?? null);
  return periods.slice().reverse().map(p => ({ value: accessor(p.kpiMap), fiscal_year: p.fiscal_year }));
}

/**
 * Full annual fundamentals bundle for one company (Stage 2) — pure, no I/O.
 * `periods` comes from a prefetched fetchKpiMapsMultiBatch() result.
 * `marketKpiMap` (PRICE/TTM_EPS/MARKET_CAP_CR/PE_TTM) is merged in so PB/PEG can resolve.
 */
function buildAnnualBundle(periods, marketKpiMap) {
  if (!periods || !periods.length) return null;

  const latest = periods[0].kpiMap;
  const prev = periods[1]?.kpiMap ?? null;

  const epsSeries = seriesFromPeriods(periods, 'EPS_BASIC');
  const revSeries = seriesFromPeriods(periods, 'REV_OP');
  const patSeries = seriesFromPeriods(periods, 'PAT');

  const epsCagr3y = resolveMetric('EPS_CAGR_3Y', { series: epsSeries }).value;
  const epsCagr5y = resolveMetric('EPS_CAGR_5Y', { series: epsSeries }).value;
  const revCagr3y = resolveMetric('REV_CAGR_3Y', { series: revSeries }).value;
  const revCagr5y = resolveMetric('REV_CAGR_5Y', { series: revSeries }).value;
  const patCagr5y = resolveMetric('PAT_CAGR_5Y', { series: patSeries }).value;

  const roe = resolveMetric('ROE', { kpiMap: latest }).value;
  const roce = resolveMetric('ROCE', { kpiMap: latest }).value;
  const de = resolveMetric('DE', { kpiMap: latest }).value;
  const currentRatio = resolveMetric('CURRENT_RATIO', { kpiMap: latest }).value;
  const ocfPat = resolveMetric('OCF_PAT', { kpiMap: latest }).value;
  // Free cash flow — latest year only. A true "3-year" FCF check needs 4 periods of
  // CAPEX deltas per candidate; using the latest year is a documented proxy (this
  // condition is rarely the binding one in practice).
  const fcfRaw = prev ? resolveMetric('FCF', { kpiMap: latest, prevKpiMap: prev }).value : null;

  const pb = resolveMetric('PB_TTM', { kpiMap: { ...marketKpiMap, ...latest } }).value;
  const peg = resolveMetric('PEG_RATIO', { kpiMap: { ...marketKpiMap, EPS_GROWTH_PCT: epsCagr3y } }).value;

  // PAT/FCF from prowess_values_new are raw ₹ (not Cr, unlike MARKET_CAP_CR from
  // nse_equity_new) — convert to Cr for filtering/display consistency.
  const RUPEES_PER_CR = 1e7;

  return {
    periods, latest, prev,
    epsSeries, revSeries, patSeries,
    epsCagr3y, epsCagr5y, revCagr3y, revCagr5y, patCagr5y,
    roe, roce, de, currentRatio, ocfPat, pb, peg,
    netWorth: latest.NET_WORTH ?? (latest.EQ_SHARE_CAP != null && latest.RES_SURPLUS != null ? latest.EQ_SHARE_CAP + latest.RES_SURPLUS : null),
    fcf: fcfRaw != null ? fcfRaw / RUPEES_PER_CR : null,
    pat: latest.PAT != null ? latest.PAT / RUPEES_PER_CR : null,
    eps: epsOf(latest),
    epsPrev: prev ? epsOf(prev) : null,
  };
}

/** Yearly-average-PE series for Historical PE (one point per calendar year — see
 *  utils/formulaRegistry/financialEntries.b.js HISTORICAL_PE_3Y/5Y docs on why this
 *  matters given nse_equity_new's daily/weekly cadence split). Pure, no I/O — `rows`
 *  comes from a prefetched fetchPeTimeSeriesBatch() result. */
function buildHistoricalPeSeries(rows) {
  const byYear = {};
  for (const r of (rows ?? [])) {
    if (r.pe == null) continue;
    (byYear[r.date.slice(0, 4)] ??= []).push(r.pe);
  }
  return Object.keys(byYear).sort().map(year => ({
    value: byYear[year].reduce((s, v) => s + v, 0) / byYear[year].length,
    year,
  }));
}

/** Latest-quarter + 4-quarters-back bundle for the two QoQ/YoY screens (2, 6).
 *  Pure, no I/O — `periods` comes from a prefetched fetchKpiMapsMultiBatch() result. */
function buildQuarterlyBundle(periods) {
  if (!periods || periods.length < 5) return null;
  const opm = p => resolveMetric('OP_MARGIN', { kpiMap: p.kpiMap }).value;
  return {
    q0: periods[0], q1: periods[1], q2: periods[2], q3: periods[3], q4: periods[4],
    opmQ: opm,
  };
}

/** Distinct, non-null company names for a Stage-1 candidate list. */
function companyNamesOf(candidates) {
  return [...new Set(candidates.map(([, e]) => e.companyName).filter(Boolean))];
}

/**
 * Shared harness for the 5 purely-fundamental screens (1, 3, 4, 5 use annual;
 * screen 3 additionally needs the historical-PE series). Batch-prefetches once,
 * then calls `evaluate(symbol, entry, ann, peSeries) => record|null` synchronously
 * per candidate.
 */
async function runAnnualScreen(candidates, { historicalPe = false, window = 5 } = {}, evaluate) {
  const companyNames = companyNamesOf(candidates);
  const symbols = candidates.map(([symbol]) => symbol);
  const [annualMap, peMap] = await Promise.all([
    fetchKpiMapsMultiBatch(prisma, companyNames, 'annual', window),
    historicalPe ? fetchPeTimeSeriesBatch(prisma, symbols, { months: 60 }) : Promise.resolve({}),
  ]);

  const rows = [];
  for (const [symbol, entry] of candidates) {
    if (!entry.companyName) continue;
    const ann = buildAnnualBundle(annualMap[entry.companyName], entry.kpiMap);
    if (!ann) continue;
    const peSeries = historicalPe ? buildHistoricalPeSeries(peMap[symbol]) : null;
    const record = evaluate(symbol, entry, ann, peSeries);
    if (record) rows.push(record);
  }
  return rows;
}

/** Shared harness for the 2 QoQ/YoY quarterly screens (2, 6). */
async function runQuarterlyScreen(candidates, evaluate) {
  const companyNames = companyNamesOf(candidates);
  const quarterlyMap = await fetchKpiMapsMultiBatch(prisma, companyNames, 'quarterly', 4);

  const rows = [];
  for (const [symbol, entry] of candidates) {
    if (!entry.companyName) continue;
    const q = buildQuarterlyBundle(quarterlyMap[entry.companyName]);
    if (!q) continue;
    const record = evaluate(symbol, entry, q);
    if (record) rows.push(record);
  }
  return rows;
}

// ── Stage 3: price history for candidates that need it ───────────────────────

async function getBarsBundle(symbol) {
  const bars = await fetchOhlcvBars(prisma, symbol);
  if (!bars.dailyBars.length) return null;
  const ta = resolveTechnicalIndicators(bars.dailyBars, bars.weeklyBars, bars.monthlyBars, bars.quote);
  return { bars, ta };
}

// ── Shared record builder ─────────────────────────────────────────────────────

function baseRecord(symbol, entry) {
  return {
    symbol,
    companyName: entry.companyName,
    marketCapCr: r2(entry.kpiMap.MARKET_CAP_CR),
    pe: r2(entry.kpiMap.PE_TTM),
  };
}

// ── Screeners ──────────────────────────────────────────────────────────────────
// Each screener: (a) applies the basket's cheap Stage-1 conditions over the bulk
// market map, (b) fetches Stage 2/3 data only for survivors, (c) applies the
// remaining conditions, (d) returns the final stock records.

async function screenSmallSizeSolidFundamentals(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 500 && mc < 2000;
  });

  return runAnnualScreen(candidates, { historicalPe: true }, (symbol, entry, ann, peSeries) => {
    if (ann.netWorth == null || ann.netWorth <= 0) return null;
    const historicalPe5y = resolveMetric('HISTORICAL_PE_5Y', { series: peSeries }).value;
    const pe = entry.kpiMap.PE_TTM;

    if (ann.pat == null || ann.pat <= 0) return null;
    if (ann.revCagr3y == null || ann.revCagr3y <= 0) return null;
    if (ann.de == null || ann.de >= 1) return null;
    if (ann.eps == null || ann.eps <= 0) return null;
    if (pe == null || historicalPe5y == null || pe >= historicalPe5y) return null;
    if (ann.peg == null || ann.peg >= 1) return null;

    return {
      ...baseRecord(symbol, entry),
      netProfitCr: r2(ann.pat),
      salesGrowth3y: r2(ann.revCagr3y),
      debtEquity: r2(ann.de),
      eps: r2(ann.eps),
      historicalPe5y: r2(historicalPe5y),
      peg: r2(ann.peg),
    };
  });
}

async function screenProfitMomentumReasonablyPriced(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    const pe = e.kpiMap.PE_TTM;
    return mc != null && mc > 1000 && pe != null && pe > 0 && pe < 30;
  });

  const companyNames = companyNamesOf(candidates);
  const [quarterlyMap, annualMap] = await Promise.all([
    fetchKpiMapsMultiBatch(prisma, companyNames, 'quarterly', 4),
    fetchKpiMapsMultiBatch(prisma, companyNames, 'annual', 3), // for EPS_CAGR_3Y (PEG input)
  ]);

  const rows = [];
  for (const [symbol, entry] of candidates) {
    if (!entry.companyName) continue;
    const q = buildQuarterlyBundle(quarterlyMap[entry.companyName]);
    if (!q) continue;

    const pat = p => p.kpiMap.PAT;
    // Net profit grew every quarter over the last 4 quarters.
    const chain = [q.q4, q.q3, q.q2, q.q1, q.q0].map(pat);
    if (chain.some(v => v == null)) continue;
    let grew = true;
    for (let i = 1; i < chain.length; i++) {
      if (chain[i] <= chain[i - 1]) { grew = false; break; }
    }
    if (!grew) continue;

    const opm = q.opmQ(q.q0);
    if (opm == null || opm <= 15) continue;

    const annEps = seriesFromPeriods(annualMap[entry.companyName] ?? [], 'EPS_BASIC');
    const epsCagr3y = resolveMetric('EPS_CAGR_3Y', { series: annEps }).value;
    const peg = resolveMetric('PEG_RATIO', { kpiMap: { ...entry.kpiMap, EPS_GROWTH_PCT: epsCagr3y } }).value;
    if (peg == null || peg >= 1) continue;

    rows.push({
      ...baseRecord(symbol, entry),
      peg: r2(peg),
      opm: r2(opm),
      netProfitCr: r2(chain[chain.length - 1] / 1e7), // prowess_values_new PAT is raw ₹, not Cr
    });
  }
  return rows;
}

async function screenQualityCompoundersAtDiscount(marketMap, industryPe) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 1000;
  });

  return runAnnualScreen(candidates, { historicalPe: true }, (symbol, entry, ann, peSeries) => {
    if (ann.netWorth == null || ann.netWorth <= 0) return null;

    if (ann.epsCagr5y == null || ann.epsCagr5y <= 15) return null;
    if (ann.epsCagr3y == null || ann.epsCagr3y <= 12) return null;
    if (ann.eps == null || ann.epsPrev == null || ann.eps <= ann.epsPrev) return null;

    const pe = entry.kpiMap.PE_TTM;
    const historicalPe3y = resolveMetric('HISTORICAL_PE_3Y', { series: peSeries }).value;
    const historicalPe5y = resolveMetric('HISTORICAL_PE_5Y', { series: peSeries }).value;
    if (pe == null || historicalPe3y == null || pe >= historicalPe3y) return null;
    if (historicalPe5y == null || pe >= historicalPe5y) return null;
    if (ann.peg == null || pe >= ann.peg * 100) return null;

    if (ann.eps <= 0) return null;
    if (ann.roe == null || ann.roe <= 12) return null;
    if (ann.de == null || ann.de >= 1) return null;
    if (ann.revCagr5y == null || ann.revCagr5y <= 10) return null;

    const industryAvgPe = entry.basicIndustry ? industryPe[entry.basicIndustry] : null;
    if (industryAvgPe == null || pe >= industryAvgPe) return null;

    return {
      ...baseRecord(symbol, entry),
      epsGrowth5y: r2(ann.epsCagr5y),
      epsGrowth3y: r2(ann.epsCagr3y),
      historicalPe3y: r2(historicalPe3y),
      historicalPe5y: r2(historicalPe5y),
      peg: r2(ann.peg),
      roe: r2(ann.roe),
      debtEquity: r2(ann.de),
      salesGrowth5y: r2(ann.revCagr5y),
      industryPe: r2(industryAvgPe),
    };
  });
}

async function screenDown50PctFundamentalsStrong(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 1000;
  });

  // Annual fundamentals filter first (batched, cheap) — only survivors go on to
  // the per-candidate bars fetch (Stage 3), which is the expensive part left.
  const survivors = await runAnnualScreen(candidates, {}, (symbol, entry, ann) => {
    if (ann.netWorth == null || ann.netWorth <= 0) return null;
    if (ann.revCagr5y == null || ann.revCagr5y <= 10) return null;
    if (ann.patCagr5y == null || ann.patCagr5y <= 10) return null;
    if (ann.roce == null || ann.roce <= 15) return null;
    if (ann.roe == null || ann.roe <= 15) return null;
    if (ann.de == null || ann.de >= 0.5) return null;
    if (ann.peg == null || ann.peg >= 2) return null;
    if (ann.epsCagr3y == null || ann.epsCagr3y <= 0) return null;
    if (ann.currentRatio == null || ann.currentRatio <= 1.2) return null;
    if (ann.fcf == null || ann.fcf <= 0) return null;
    return { symbol, entry, ann };
  });

  const rows = await pMap(survivors, async ({ symbol, entry, ann }) => {
    const bars = await getBarsBundle(symbol);
    if (!bars || bars.bars.allTimeHigh == null) return null;
    const price = entry.kpiMap.PRICE;
    if (price == null || price >= 0.5 * bars.bars.allTimeHigh) return null;

    return {
      ...baseRecord(symbol, entry),
      salesGrowth5y: r2(ann.revCagr5y),
      profitGrowth5y: r2(ann.patCagr5y),
      roce: r2(ann.roce),
      roe: r2(ann.roe),
      debtEquity: r2(ann.de),
      peg: r2(ann.peg),
      epsGrowth3y: r2(ann.epsCagr3y),
      currentRatio: r2(ann.currentRatio),
      fcf: r2(ann.fcf),
      distFromAthPct: r2((price / bars.bars.allTimeHigh - 1) * 100),
    };
  });
  return rows.filter(Boolean);
}

async function screenCheapOnBookStrongReturns(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 1000;
  });

  return runAnnualScreen(candidates, {}, (symbol, entry, ann) => {
    if (ann.netWorth == null || ann.netWorth <= 0) return null;
    if (ann.pb == null || ann.pb <= 0 || ann.pb >= 2) return null;
    if (ann.roe == null || ann.roe <= 12) return null;
    if (ann.roce == null || ann.roce <= 12) return null;
    if (ann.ocfPat == null || ann.ocfPat <= 0.8) return null;
    if (ann.de == null || ann.de >= 0.5) return null;

    return {
      ...baseRecord(symbol, entry),
      pb: r2(ann.pb),
      roe: r2(ann.roe),
      roce: r2(ann.roce),
      ocfPat: r2(ann.ocfPat),
      debtEquity: r2(ann.de),
    };
  });
}

async function screenProfitGrowingFasterThanSales(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 500;
  });

  return runQuarterlyScreen(candidates, (symbol, entry, q) => {
    const revLatest = q.q0.kpiMap.REV_OP, revYoy = q.q4.kpiMap.REV_OP;
    const patLatest = q.q0.kpiMap.PAT, patYoy = q.q4.kpiMap.PAT;
    if (revLatest == null || !revYoy) return null;
    if (patLatest == null || !patYoy) return null;

    const salesGrowthYoyQ = (revLatest - revYoy) / Math.abs(revYoy) * 100;
    const profitGrowthYoyQ = (patLatest - patYoy) / Math.abs(patYoy) * 100;
    if (salesGrowthYoyQ <= 15) return null;
    if (profitGrowthYoyQ <= 25) return null;
    if (profitGrowthYoyQ <= 1.5 * salesGrowthYoyQ) return null;

    const opmLatestQ = q.opmQ(q.q0);
    const opmPrevQ = q.opmQ(q.q1);
    if (opmLatestQ == null || opmPrevQ == null || opmPrevQ <= 0) return null;
    if (opmLatestQ <= 1.1 * opmPrevQ) return null;

    const roce = resolveMetric('ROCE', { kpiMap: q.q0.kpiMap }).value;
    if (roce == null || roce <= 15) return null;
    const ocfPat = resolveMetric('OCF_PAT', { kpiMap: q.q0.kpiMap }).value;
    if (ocfPat == null || ocfPat <= 0.8) return null;

    return {
      ...baseRecord(symbol, entry),
      salesGrowthYoyQ: r2(salesGrowthYoyQ),
      profitGrowthYoyQ: r2(profitGrowthYoyQ),
      opmLatestQ: r2(opmLatestQ),
      opmPrevQ: r2(opmPrevQ),
      roce: r2(roce),
      ocfPat: r2(ocfPat),
    };
  });
}

async function screenNearLowsQualityIntact(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 500;
  });

  const survivors = await runAnnualScreen(candidates, {}, (symbol, entry, ann) => {
    if (ann.netWorth == null || ann.netWorth <= 0) return null;
    if (ann.pat == null || ann.pat <= 0) return null;
    if (ann.roce == null || ann.roce <= 15) return null;
    if (ann.de == null || ann.de < 0 || ann.de >= 1) return null;
    return { symbol, entry, ann };
  });

  const rows = await pMap(survivors, async ({ symbol, entry, ann }) => {
    const barsBundle = await getBarsBundle(symbol);
    if (!barsBundle) return null;

    const price = entry.kpiMap.PRICE;
    const { allTimeHigh, dailyBars } = barsBundle.bars;
    if (price == null || allTimeHigh == null) return null;
    if (price >= 0.5 * allTimeHigh) return null;

    const low52w = dailyBars.length ? Math.min(...dailyBars.map(b => b.low)) : null;
    if (low52w == null || price > 1.10 * low52w) return null;

    return {
      ...baseRecord(symbol, entry),
      netProfitCr: r2(ann.pat),
      roce: r2(ann.roce),
      debtEquity: r2(ann.de),
      distFromAthPct: r2((price / allTimeHigh - 1) * 100),
      distFrom52wLowPct: r2((price / low52w - 1) * 100),
    };
  });
  return rows.filter(Boolean);
}

async function screenGoldenCrossover(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 500;
  });

  const rows = await pMap(candidates, async ([symbol, entry]) => {
    const bundle = await getBarsBundle(symbol);
    if (!bundle) return null;
    const { dailyBars, weeklyBars, monthlyBars, quote } = bundle.bars;
    if (dailyBars.length < 2) return null;

    const today = resolveTechnicalIndicators(dailyBars, weeklyBars, monthlyBars, quote).daily;
    const yesterdayBars = dailyBars.slice(0, -1);
    const yesterday = resolveTechnicalIndicators(yesterdayBars, weeklyBars, monthlyBars, quote).daily;

    const sma50 = today.sma50, sma200 = today.sma200;
    const sma50Prev = yesterday.sma50, sma200Prev = yesterday.sma200;
    if ([sma50, sma200, sma50Prev, sma200Prev].some(v => v == null)) return null;
    if (!(sma50 > sma200)) return null;
    if (!(sma50Prev < sma200Prev)) return null;

    return {
      ...baseRecord(symbol, entry),
      sma50: r2(sma50),
      sma200: r2(sma200),
      close: r2(dailyBars.at(-1).close),
    };
  });
  return rows.filter(Boolean);
}

async function screenOversoldOnRsi(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 500;
  });

  const rows = await pMap(candidates, async ([symbol, entry]) => {
    const bundle = await getBarsBundle(symbol);
    if (!bundle) return null;
    const rsi14 = bundle.ta.daily.rsi14;
    if (rsi14 == null || rsi14 >= 30) return null;

    return {
      ...baseRecord(symbol, entry),
      rsi14: r2(rsi14),
      close: r2(bundle.bars.dailyBars.at(-1)?.close),
    };
  });
  return rows.filter(Boolean);
}

async function screenFourMasInOneCandle(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 1000;
  });

  const rows = await pMap(candidates, async ([symbol, entry]) => {
    const bundle = await getBarsBundle(symbol);
    if (!bundle) return null;
    const { sma20, sma50, sma100, sma200, low, high } = bundle.ta.daily;
    if ([sma20, sma50, sma100, sma200, low, high].some(v => v == null)) return null;
    const inRange = v => low <= v && v <= high;
    if (!inRange(sma20) || !inRange(sma50) || !inRange(sma100) || !inRange(sma200)) return null;

    return {
      ...baseRecord(symbol, entry),
      sma20: r2(sma20), sma50: r2(sma50), sma100: r2(sma100), sma200: r2(sma200),
      low: r2(low), high: r2(high),
    };
  });
  return rows.filter(Boolean);
}

async function screenPowerCandle(marketMap) {
  const candidates = Object.entries(marketMap).filter(([, e]) => {
    const mc = e.kpiMap.MARKET_CAP_CR;
    return mc != null && mc > 1000;
  });

  const rows = await pMap(candidates, async ([symbol, entry]) => {
    const bundle = await getBarsBundle(symbol);
    if (!bundle) return null;
    const { dailyBars } = bundle.bars;
    if (dailyBars.length < 7) return null;

    const last = dailyBars.at(-1);
    if (last.close !== last.high) return null;

    const last7 = dailyBars.slice(-7);
    const maxRange = Math.max(...last7.map(b => b.high - b.low));
    const todayRange = last.high - last.low;
    if (Math.abs(todayRange - maxRange) > 1e-9) return null;
    if (!(last.open < (last.high + last.low) / 2)) return null;

    return {
      ...baseRecord(symbol, entry),
      close: r2(last.close), high: r2(last.high), low: r2(last.low), open: r2(last.open),
    };
  });
  return rows.filter(Boolean);
}

// Map basket id → screener function. Every screener receives (marketMap, industryPe).
const SCREENERS = {
  'small-size-solid-fundamentals':      (mm) => screenSmallSizeSolidFundamentals(mm),
  'profit-momentum-reasonably-priced':  (mm) => screenProfitMomentumReasonablyPriced(mm),
  'quality-compounders-at-a-discount':  (mm, ip) => screenQualityCompoundersAtDiscount(mm, ip),
  'down-50pct-fundamentals-strong':     (mm) => screenDown50PctFundamentalsStrong(mm),
  'cheap-on-book-strong-returns':       (mm) => screenCheapOnBookStrongReturns(mm),
  'profit-growing-faster-than-sales':   (mm) => screenProfitGrowingFasterThanSales(mm),
  'near-lows-quality-intact':           (mm) => screenNearLowsQualityIntact(mm),
  'golden-crossover':                   (mm) => screenGoldenCrossover(mm),
  'oversold-on-rsi':                    (mm) => screenOversoldOnRsi(mm),
  'four-mas-in-one-candle':             (mm) => screenFourMasInOneCandle(mm),
  'power-candle':                       (mm) => screenPowerCandle(mm),
};

/** Run a basket's screener end-to-end (Stage 1 → Stage 2/3). Used by both
 *  getBasketStocks and services/dashboard/discover-screens.service.js. */
async function runScreener(basketId) {
  const screener = SCREENERS[basketId];
  if (!screener) return null;
  const marketMap = await buildMarketMap();
  const basket = BASKETS.find(b => b.id === basketId);
  const industryPe = basket?.needs?.industryPe ? buildIndustryPeMap(marketMap) : null;
  return screener(marketMap, industryPe);
}

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/baskets
 * Returns all basket definitions (no stock data).
 */
function getBaskets(req, res) {
  const grouped = {};
  for (const basket of BASKETS) {
    if (!grouped[basket.category]) grouped[basket.category] = [];
    grouped[basket.category].push({
      id:          basket.id,
      title:       basket.title,
      description: basket.description,
      conditions:  basket.conditions,
      columns:     basket.columns,
    });
  }

  res.json({
    baskets: BASKETS.map(b => ({
      id:          b.id,
      category:    b.category,
      title:       b.title,
      description: b.description,
      conditions:  b.conditions,
      columns:     b.columns,
    })),
    grouped,
  });
}

/**
 * GET /api/baskets/:basketId/stocks
 * Runs the screen for the requested basket and returns matching stocks.
 * Query params:
 *   page  (default 1)
 *   size  (default 50, max 200)
 *   sort  (column name, default 'marketCapCr')
 *   order ('asc' | 'desc', default 'desc')
 */
async function getBasketStocks(req, res) {
  const { basketId } = req.params;
  const basket = BASKETS.find(b => b.id === basketId);
  if (!basket) {
    return res.status(404).json({ error: `Basket '${basketId}' not found` });
  }
  if (!SCREENERS[basketId]) {
    return res.status(501).json({ error: `Screener for '${basketId}' not implemented` });
  }

  let stocks;
  try {
    stocks = await runScreener(basketId);
  } catch (err) {
    console.error(`[baskets] screener '${basketId}' failed:`, err);
    return res.status(500).json({ error: 'Screener failed', detail: err.message });
  }

  // Sorting
  const sortField = req.query.sort || 'marketCapCr';
  const order     = req.query.order === 'asc' ? 1 : -1;
  stocks.sort((a, b) => {
    const av = a[sortField] ?? -Infinity;
    const bv = b[sortField] ?? -Infinity;
    return (av < bv ? -1 : av > bv ? 1 : 0) * order;
  });

  // Pagination
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(200, Math.max(1, parseInt(req.query.size) || 50));
  const total = stocks.length;
  const start = (page - 1) * size;
  const items = stocks.slice(start, start + size);

  res.json({
    basket: {
      id:          basket.id,
      category:    basket.category,
      title:       basket.title,
      description: basket.description,
      conditions:  basket.conditions,
      columns:     basket.columns,
    },
    pagination: { page, size, total, pages: Math.ceil(total / size) },
    stocks: items,
  });
}

module.exports = {
  getBaskets,
  getBasketStocks,
  // Exported for reuse by the investor-dashboard discover-screens service.
  BASKETS,
  SCREENERS,
  runScreener,
};
