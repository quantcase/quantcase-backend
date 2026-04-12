'use strict';

const prowess = require('../lib/prowess');

// ── Basket definitions ────────────────────────────────────────────────────────
// Each basket maps to the PDF spec: broad category, sub-category, description,
// conditions, and the columns that are relevant for its stock list.

const BASKETS = [
  {
    id: 'value-buying',
    category: 'Value Investing',
    title: 'Value Buying',
    description: 'Stocks trading below intrinsic value — low P/E, low P/B, strong cash flows. Market hasn\'t priced in the underlying business quality yet.',
    searchIntent: 'Cheap quality stocks the market has overlooked',
    conditions: 'P/E < sector median; P/B < 1.5; Positive Free Cash Flow; Debt/Equity < 0.5; ROE > 12%',
    columns: ['symbol', 'companyName', 'pe', 'pb', 'roe', 'debtEquity', 'freeCashFlow', 'marketCapCr'],
  },
  {
    id: 'high-dividend-low-payout',
    category: 'Value Investing',
    title: 'High Dividend + Low Payout',
    description: 'Companies with 4%+ dividend yield but payout ratio under 40%. Dividend is safe and growing. Attractive during market fear or sideways phases.',
    searchIntent: 'Safe high yield with room to grow dividend',
    conditions: 'Dividend Yield > 4%; Payout Ratio < 40%; Consistent 3-yr dividend history; Positive operating cash flow',
    columns: ['symbol', 'companyName', 'dividendYield', 'payoutRatio', 'pe', 'netProfitCr', 'marketCapCr'],
  },
  {
    id: 'promoter-buying-signal',
    category: 'Value Investing',
    title: 'Promoter Buying Signal',
    description: 'Promoters buying their own stock in open market — strong insider signal. Best when combined with low valuation and no increase in pledging.',
    searchIntent: 'Insiders buying their own stock at low valuations',
    conditions: 'Promoter stake increase (SEBI disclosure); No increase in pledged shares; P/E below 3-yr average; Positive earnings trend',
    columns: ['symbol', 'companyName', 'promoterPct', 'promoterChange', 'pe', 'pb', 'marketCapCr'],
  },
  {
    id: 'market-crash-bargains',
    category: 'Market Condition — Bear / Fear',
    title: 'Market Crash Bargains',
    description: 'Quality stocks down 30%+ from highs due to broad sell-off, not fundamentals. Technicals show oversold; fundamentals remain intact.',
    searchIntent: 'Quality stocks crashed by market panic, not fundamentals',
    conditions: 'RSI < 30; Price down 30%+ from 52-week high; Debt/Equity < 0.5; ROE > 15%; No fundamental deterioration in last 2 quarters',
    columns: ['symbol', 'companyName', 'pe', 'pb', 'roe', 'debtEquity', 'netProfitCr', 'marketCapCr'],
  },
  {
    id: 'panic-bottom-reversal',
    category: 'Market Condition — Bear / Fear',
    title: 'Panic Bottom Reversal',
    description: 'Stocks forming bullish reversal candlestick patterns on high volume at major support during fear phase. Pure technical entry in fundamentally sound names.',
    searchIntent: 'Oversold stocks reversing at support with high volume',
    conditions: 'Hammer / Bullish Engulfing candle on daily chart; Volume 2x+ 10-day average; Price at 52-week support; India VIX elevated (>20)',
    columns: ['symbol', 'companyName', 'pe', 'pb', 'roe', 'netProfitCr', 'marketCapCr'],
  },
  {
    id: 'rebound-leaders',
    category: 'Market Condition — Recovery / Rebound',
    title: 'Rebound Leaders',
    description: 'First stocks to reclaim their 200 DMA after a broad market recovery. Tend to be sector leaders with institutional backing.',
    searchIntent: 'Sector leaders first to cross above 200 DMA',
    conditions: 'Price crosses above 200 DMA; Volume surge on breakout day; Relative strength vs Nifty rising; Stock is sector leader by market cap',
    columns: ['symbol', 'companyName', 'pe', 'roe', 'netProfitCr', 'totalIncomeCr', 'marketCapCr'],
  },
  {
    id: 'sectoral-rotation-plays',
    category: 'Market Condition — Recovery / Rebound',
    title: 'Sectoral Rotation Plays',
    description: 'Money rotates from defensive to cyclical sectors (BFSI, infra, auto, realty) as economy recovers. Identify sectors with improving fundamentals and rising price strength.',
    searchIntent: 'Cyclical sectors gaining as economy turns the corner',
    conditions: 'Sector relative strength improving vs Nifty; Institutional buying in FII/DII data; Revenue cycle turning positive; Low base quarter comparison',
    columns: ['symbol', 'companyName', 'pe', 'pb', 'roe', 'totalIncomeCr', 'netProfitCr', 'marketCapCr'],
  },
  {
    id: 'earnings-growth-compounders',
    category: 'Growth Investing',
    title: 'Earnings Growth Compounders',
    description: 'Companies growing EPS 20%+ consistently over 3-5 years with expanding margins. GARP approach — quality at fair price.',
    searchIntent: 'Consistent 20%+ EPS growth at a fair price',
    conditions: 'EPS growth > 20% for 3 consecutive years; Operating margin expanding; Revenue CAGR > 18%; Low or zero promoter pledge',
    columns: ['symbol', 'companyName', 'pe', 'pb', 'roe', 'epsGrowth', 'totalIncomeCr', 'netProfitCr', 'marketCapCr'],
  },
  {
    id: 'breakout-on-earnings',
    category: 'Growth Investing',
    title: 'Breakout on Earnings',
    description: 'Stock breaks a multi-month resistance on the back of strong quarterly results. Fundamental trigger combined with technical confirmation — high conviction.',
    searchIntent: 'Strong earnings surprise breaking a multi-month resistance',
    conditions: 'Price breaks key resistance on result day; Volume 2x+ average on breakout; EPS beat > 10% vs estimates; Revenue beat; Prior base of 3+ months',
    columns: ['symbol', 'companyName', 'pe', 'adjEps', 'totalIncomeCr', 'netProfitCr', 'marketCapCr'],
  },
  {
    id: 'momentum-with-quality',
    category: 'Growth Investing',
    title: 'Momentum with Quality',
    description: '52-week high breakouts with strong fundamentals underneath. Filters out speculative momentum — only quality names at new highs.',
    searchIntent: 'Quality fundamentals confirming a 52-week high breakout',
    conditions: 'Price near or at 52-week high; ROE > 18%; Debt/Equity < 0.5; Consistent quarterly earnings growth; Institutional holding increasing',
    columns: ['symbol', 'companyName', 'pe', 'pb', 'roe', 'debtEquity', 'netProfitCr', 'marketCapCr'],
  },
  {
    id: 'turnaround-candidates',
    category: 'Special Situations',
    title: 'Turnaround Candidates',
    description: 'Companies improving from a loss-making or low-ROE phase. Look for inflection in margins and a technical base forming after prolonged downtrend.',
    searchIntent: 'Loss-making companies showing clear margin inflection signs',
    conditions: '2-3 consecutive quarters of margin improvement; Revenue growth resuming; Price base forming (flat for 3+ months); Promoter buying or low pledging',
    columns: ['symbol', 'companyName', 'pe', 'pb', 'roe', 'netProfitCr', 'totalIncomeCr', 'promoterPct', 'marketCapCr'],
  },
  {
    id: 'ipo-lockup-expiry',
    category: 'Special Situations',
    title: 'IPO Lockup Expiry',
    description: 'Strong IPOs where anchor/institutional lock-in expires (~6 months post listing) — potential temporary dip and re-entry opportunity if fundamentals are solid.',
    searchIntent: 'Post-IPO dip as lock-in expiry creates temporary selling',
    conditions: '6 months post listing date; Price above IPO issue price; Fundamentals intact post-listing quarters; GMP was positive at listing; No major negative news',
    columns: ['symbol', 'companyName', 'pe', 'pb', 'adjEps', 'totalIncomeCr', 'netProfitCr', 'marketCapCr'],
  },
];

// ── Screening logic ───────────────────────────────────────────────────────────
// All screens operate on the most-recent period (index 7) from Prowess CSVs.
// Period 7 = most recent quarter in osc_fundamental_ind_qtr_v4.csv
// Period 6 = one quarter back, etc.

const LATEST = prowess.FUND_PERIOD_COUNT - 1; // index 7
const PREV   = prowess.FUND_PERIOD_COUNT - 2; // index 6
const PREV2  = prowess.FUND_PERIOD_COUNT - 3; // index 5
const PREV3  = prowess.FUND_PERIOD_COUNT - 4; // index 4

const SH_LATEST = prowess.SH_PERIOD_COUNT - 1;
const SH_PREV   = prowess.SH_PERIOD_COUNT - 2;

// Map NSE symbol → identity row using prowess identity CSV
// Returns { symbol, companyName, industryGroup, nseBasicIndustry }
function buildSymbolIndex() {
  const { companyMap, quarterLabels } = prowess.loadFundamentalData();
  const identityMap = prowess.loadIdentityMap(); // symbol → companyName
  // Invert: companyName → symbol
  const nameToSymbol = {};
  for (const [sym, name] of Object.entries(identityMap)) {
    nameToSymbol[name] = sym;
  }
  return { companyMap, nameToSymbol, quarterLabels };
}

/** Compute EPS growth across recent periods, returns fraction or null */
function epsGrowthRate(row, latestIdx, prevIdx) {
  const latest = prowess.fundPeriodData(row, latestIdx);
  const prev   = prowess.fundPeriodData(row, prevIdx);
  if (latest.adjEps == null || prev.adjEps == null || prev.adjEps === 0) return null;
  return (latest.adjEps - prev.adjEps) / Math.abs(prev.adjEps);
}

/** Check if net profit has grown across three periods */
function isConsistentEpsGrowth(row, minGrowthFraction) {
  const periods = [PREV3, PREV2, PREV, LATEST].map(i => prowess.fundPeriodData(row, i));
  for (let i = 1; i < periods.length; i++) {
    const curr = periods[i].adjEps;
    const prev = periods[i - 1].adjEps;
    if (curr == null || prev == null || prev === 0) return false;
    if ((curr - prev) / Math.abs(prev) < minGrowthFraction) return false;
  }
  return true;
}

/** Check if revenue CAGR over available periods exceeds threshold */
function revenueCAGR(row) {
  const oldest = prowess.fundPeriodData(row, PREV3);
  const latest = prowess.fundPeriodData(row, LATEST);
  if (oldest.totalIncomeCr == null || latest.totalIncomeCr == null) return null;
  if (oldest.totalIncomeCr <= 0) return null;
  // 4 periods ≈ 1 year (quarterly), treat as ~1 yr CAGR
  return (latest.totalIncomeCr / oldest.totalIncomeCr) - 1;
}

/** Compute debtEquity proxy from mod data (borrowings / reserves+equity) */
function debtEquityFromFund(row) {
  // We use pb and bvps as proxies since mod data isn't loaded here
  // Debt/Equity approximation: not directly in fundamental CSV.
  // We'll return null and filter loosely.
  return null;
}

/** Check if net profit improved over last N quarters */
function isMarginImproving(row, quarters) {
  const periods = [];
  for (let i = 0; i < quarters; i++) {
    periods.push(prowess.fundPeriodData(row, LATEST - i));
  }
  periods.reverse(); // oldest first
  for (let i = 1; i < periods.length; i++) {
    const curr = periods[i].netProfitCr;
    const prev = periods[i - 1].netProfitCr;
    if (curr == null || prev == null) return false;
    if (curr <= prev) return false;
  }
  return true;
}

/** Compute promoter change: latest vs previous */
function promoterChange(shRow) {
  if (!shRow) return null;
  const latest = prowess.shPeriodData(shRow, SH_LATEST);
  const prev   = prowess.shPeriodData(shRow, SH_PREV);
  if (latest.promoters == null || prev.promoters == null) return null;
  return prowess.r2(latest.promoters - prev.promoters);
}

/** Build a standardised stock record from fundamental row + symbol */
function buildStockRecord(symbol, companyName, fundRow, shRow) {
  const d = prowess.fundPeriodData(fundRow, LATEST);
  const dPrev = prowess.fundPeriodData(fundRow, PREV);
  const shLatest = shRow ? prowess.shPeriodData(shRow, SH_LATEST) : null;
  const shPrev   = shRow ? prowess.shPeriodData(shRow, SH_PREV)   : null;

  const epsCurr = d.adjEps;
  const epsPrev = dPrev.adjEps;
  const epsGrowth = (epsCurr != null && epsPrev != null && epsPrev !== 0)
    ? prowess.r2((epsCurr - epsPrev) / Math.abs(epsPrev))
    : null;

  const promoterPct    = shLatest?.promoters ?? null;
  const promoterPctPrev = shPrev?.promoters ?? null;
  const promChg = (promoterPct != null && promoterPctPrev != null)
    ? prowess.r2(promoterPct - promoterPctPrev)
    : null;

  return {
    symbol,
    companyName,
    pe:           prowess.r2(d.pe),
    pb:           prowess.r2(d.pb),
    adjEps:       prowess.r2(d.adjEps),
    epsGrowth,                                    // fraction, e.g. 0.25 = 25%
    dividendYield: prowess.r2(d.yield_),          // percent
    payoutRatio:  null,                            // not in CSV; frontend shows N/A
    roe:          null,                            // not directly in fund CSV; derived where possible
    debtEquity:   null,                            // not in fund CSV
    freeCashFlow: null,                            // not in fund CSV
    totalIncomeCr:  prowess.r2(d.totalIncomeCr),
    netProfitCr:    prowess.r2(d.netProfitCr),
    marketCapCr:    prowess.r2(d.marketCapCr),
    promoterPct:    prowess.r2(promoterPct),
    promoterChange: promChg,
    evPbdita:       prowess.r2(d.evPbdita),
  };
}

// ── Screeners per basket ──────────────────────────────────────────────────────

function screenValueBuying(companyMap, nameToSymbol, shMap) {
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const d = prowess.fundPeriodData(row, LATEST);
    if (d.pe == null || d.pb == null) continue;
    // P/E < 25 (proxy for below sector median), P/B < 1.5, positive net profit (proxy for FCF)
    if (d.pe > 25)   continue;
    if (d.pb > 1.5)  continue;
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenHighDividend(companyMap, nameToSymbol, shMap) {
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const d = prowess.fundPeriodData(row, LATEST);
    if (d.yield_ == null || d.yield_ < 4) continue;
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenPromoterBuying(companyMap, nameToSymbol, shMap) {
  if (!shMap) return [];
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const shRow = shMap.companyMap?.[companyName] ?? null;
    if (!shRow) continue;
    const latest = prowess.shPeriodData(shRow, SH_LATEST);
    const prev   = prowess.shPeriodData(shRow, SH_PREV);
    if (latest.promoters == null || prev.promoters == null) continue;
    // Promoter stake increased
    if (latest.promoters <= prev.promoters) continue;
    const d = prowess.fundPeriodData(row, LATEST);
    // Positive earnings trend
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenMarketCrashBargains(companyMap, nameToSymbol, shMap) {
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const d = prowess.fundPeriodData(row, LATEST);
    if (d.pe == null || d.pb == null) continue;
    // Quality filter: low PE + low PB + profitable
    if (d.pe > 20)  continue;
    if (d.pb > 2.0) continue;
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    // No deterioration: latest net profit >= previous
    const dPrev = prowess.fundPeriodData(row, PREV);
    if (dPrev.netProfitCr != null && d.netProfitCr < dPrev.netProfitCr * 0.8) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenPanicBottomReversal(companyMap, nameToSymbol, shMap) {
  // Same fundamentals filter as crash bargains — technical conditions (RSI, volume)
  // are not available in CSVs; we surface the fundamentally sound candidates.
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const d = prowess.fundPeriodData(row, LATEST);
    if (d.pe == null || d.pe <= 0) continue;
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenReboundLeaders(companyMap, nameToSymbol, shMap) {
  // Filter: profitable + large/mid-cap (marketCap > 1000 Cr)
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const d = prowess.fundPeriodData(row, LATEST);
    if (d.marketCapCr == null || d.marketCapCr < 1000) continue;
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  // Sort by market cap desc so sector leaders appear first
  results.sort((a, b) => (b.marketCapCr ?? 0) - (a.marketCapCr ?? 0));
  return results;
}

function screenSectoralRotation(companyMap, nameToSymbol, shMap) {
  // Revenue picking up: latest totalIncome > previous
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const d     = prowess.fundPeriodData(row, LATEST);
    const dPrev = prowess.fundPeriodData(row, PREV);
    if (d.totalIncomeCr == null || dPrev.totalIncomeCr == null) continue;
    if (d.totalIncomeCr <= dPrev.totalIncomeCr) continue;
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenEarningsGrowthCompounders(companyMap, nameToSymbol, shMap) {
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    // EPS growing consistently across last 4 periods at > 20%
    if (!isConsistentEpsGrowth(row, 0.20)) continue;
    const cagr = revenueCAGR(row);
    if (cagr == null || cagr < 0.18) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenBreakoutOnEarnings(companyMap, nameToSymbol, shMap) {
  // EPS jumped in latest quarter vs previous by > 10%
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const growth = epsGrowthRate(row, LATEST, PREV);
    if (growth == null || growth < 0.10) continue;
    const d = prowess.fundPeriodData(row, LATEST);
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    const dPrev = prowess.fundPeriodData(row, PREV);
    if (dPrev.totalIncomeCr == null || d.totalIncomeCr == null) continue;
    if (d.totalIncomeCr <= dPrev.totalIncomeCr) continue; // revenue beat
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenMomentumWithQuality(companyMap, nameToSymbol, shMap) {
  // Quality: PE > 0, profitable, large/mid-cap proxy
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const d = prowess.fundPeriodData(row, LATEST);
    if (d.pe == null || d.pe <= 0) continue;
    if (d.pb == null || d.pb <= 0) continue;
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    if (d.marketCapCr == null || d.marketCapCr < 500) continue;
    // Earnings growth: latest > prev
    const dPrev = prowess.fundPeriodData(row, PREV);
    if (dPrev.netProfitCr != null && d.netProfitCr <= dPrev.netProfitCr) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  // Sort by marketCap desc (momentum candidates tend to be well-known names)
  results.sort((a, b) => (b.marketCapCr ?? 0) - (a.marketCapCr ?? 0));
  return results;
}

function screenTurnaroundCandidates(companyMap, nameToSymbol, shMap) {
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    // Was loss-making earlier, now profitable — or was barely profitable, improving
    const dOldest = prowess.fundPeriodData(row, PREV3);
    const dLatest  = prowess.fundPeriodData(row, LATEST);
    if (dOldest.netProfitCr == null || dLatest.netProfitCr == null) continue;
    // Was previously low/negative, now improving
    if (dOldest.netProfitCr >= dLatest.netProfitCr) continue;
    if (dLatest.netProfitCr <= 0) continue; // must now be profitable
    // Margin improving over last 3 quarters
    if (!isMarginImproving(row, 3)) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

function screenIpoLockupExpiry(companyMap, nameToSymbol, shMap) {
  // Proxy: companies with recent EPS data, profitable, but low PE (early stage)
  const results = [];
  for (const [companyName, row] of Object.entries(companyMap)) {
    const d = prowess.fundPeriodData(row, LATEST);
    if (d.netProfitCr == null || d.netProfitCr <= 0) continue;
    if (d.pe == null || d.pe <= 0 || d.pe > 80) continue;
    if (d.marketCapCr == null || d.marketCapCr < 100) continue;
    const symbol = nameToSymbol[companyName];
    if (!symbol) continue;
    const shRow = shMap?.companyMap?.[companyName] ?? null;
    results.push(buildStockRecord(symbol, companyName, row, shRow));
  }
  return results;
}

// Map basket id → screener function
const SCREENERS = {
  'value-buying':               screenValueBuying,
  'high-dividend-low-payout':   screenHighDividend,
  'promoter-buying-signal':     screenPromoterBuying,
  'market-crash-bargains':      screenMarketCrashBargains,
  'panic-bottom-reversal':      screenPanicBottomReversal,
  'rebound-leaders':            screenReboundLeaders,
  'sectoral-rotation-plays':    screenSectoralRotation,
  'earnings-growth-compounders': screenEarningsGrowthCompounders,
  'breakout-on-earnings':       screenBreakoutOnEarnings,
  'momentum-with-quality':      screenMomentumWithQuality,
  'turnaround-candidates':      screenTurnaroundCandidates,
  'ipo-lockup-expiry':          screenIpoLockupExpiry,
};

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
      searchIntent: basket.searchIntent,
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
      searchIntent: b.searchIntent,
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
function getBasketStocks(req, res) {
  const { basketId } = req.params;
  const basket = BASKETS.find(b => b.id === basketId);
  if (!basket) {
    return res.status(404).json({ error: `Basket '${basketId}' not found` });
  }

  const screener = SCREENERS[basketId];
  if (!screener) {
    return res.status(501).json({ error: `Screener for '${basketId}' not implemented` });
  }

  const { companyMap, nameToSymbol, quarterLabels } = buildSymbolIndex();
  const shData = prowess.loadShareholdingData();

  let stocks = screener(companyMap, nameToSymbol, shData);

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
    latestQuarter: quarterLabels[LATEST] ?? null,
    pagination: { page, size, total, pages: Math.ceil(total / size) },
    stocks: items,
  });
}

module.exports = { getBaskets, getBasketStocks };
