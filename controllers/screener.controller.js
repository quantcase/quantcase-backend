'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
const YahooFinance = require('yahoo-finance2').default;
const technicalAnalysis = require('../lib/technicalAnalysis');
const financials = require('../lib/financials');
const { generateDecisionIntelligence } = require('../utils/decisionIntelligence');
const { computeIndicatorSeries } = require('../utils/taIndicators');
const prisma = require('../config/prisma');

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── Peer comparison helpers (reuse Prowess CSV data) ────────────────────────

// Identity CSV column indices (0-based)
const ID_COL_NAME          = 0;
const ID_COL_INDUSTRY_GRP  = 9;   // "Industry group"
const ID_COL_NSE_BASIC_IND = 24;  // "NSE Basic Industry classification"
const ID_COL_NSE_SYMBOL    = 25;  // "NSE symbol"

// Fundamental CSV layout (same as prowess.controller)
const PEER_COLS_PER_PERIOD = 20;
const PEER_PERIOD_COUNT    = 8;
const PEER_OFF = { SHARES: 0, MARKET_CAP: 1, ADJ_EPS: 3, PE: 5, PB: 6, YIELD: 8,
                   EV: 9, TOTAL_INCOME: 13, NET_PROFIT: 15 };

// osc_mod_qtr_v1.csv layout — 54 data cols per period (col 0 = Company Name, then groups of 54)
const MOD_COLS_PER_PERIOD = 54;
const MOD_OFF = {
  NET_PROFIT:  30, // "Net Profit/(Loss) for the period from continuing operations (after tax)"
  INTEREST:    23, // "Interest expenses"
  PAID_CAP:    32, // "Paid up capital"
  RESERVES:    33, // "Reserves"
  BORROWINGS:  36, // "Borrowings"
};

let _peerIdentityRows  = null; // raw parsed rows (array of arrays)
let _peerIdentityHeader = null;
let _peerFundMap       = null; // { companyName: row[] }
let _peerFundQtrs      = null; // string[]
let _modMap            = null; // { companyName: row[] } from osc_mod_qtr_v1.csv

function loadPeerIdentity() {
  if (_peerIdentityRows) return { rows: _peerIdentityRows, header: _peerIdentityHeader };
  const raw = fs.readFileSync(path.join(__dirname, '../lib/osc_identity.csv'), 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const all = csvParse.parse(content, { relax_column_count: true });
  _peerIdentityHeader = all[0];
  _peerIdentityRows   = all.slice(1);
  return { rows: _peerIdentityRows, header: _peerIdentityHeader };
}

function loadPeerFundamentals() {
  if (_peerFundMap) return { fundMap: _peerFundMap, qtrs: _peerFundQtrs };
  const raw = fs.readFileSync(path.join(__dirname, '../lib/osc_fundamental_ind_qtr_v4.csv'), 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const all = csvParse.parse(content, { relax_column_count: true });
  const quarterRow = all[4];
  _peerFundQtrs = [];
  for (let i = 0; i < PEER_PERIOD_COUNT; i++) {
    _peerFundQtrs.push(quarterRow[1 + i * PEER_COLS_PER_PERIOD] || `Q${i + 1}`);
  }
  _peerFundMap = {};
  for (const row of all.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) _peerFundMap[name] = row;
  }
  return { fundMap: _peerFundMap, qtrs: _peerFundQtrs };
}

function loadModData() {
  if (_modMap) return _modMap;
  const raw = fs.readFileSync(path.join(__dirname, '../lib/osc_mod_qtr_v1.csv'), 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const all = csvParse.parse(content, { relax_column_count: true });
  _modMap = {};
  // Row 5 (index 5) is the header row with "Company Name" in col 0
  for (const row of all.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) _modMap[name] = row;
  }
  return _modMap;
}

function peerToFloat(val) {
  if (val === '' || val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }

/** Extract one metric from a Prowess row at a given period index */
function peerPeriodVal(row, periodIndex, offset) {
  const start = 1 + periodIndex * PEER_COLS_PER_PERIOD;
  return peerToFloat(row[start + offset]);
}

async function getTechnicals(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const result = await technicalAnalysis.analyze(symbol);

    const dbInsight = await prisma.aiInsight.findUnique({
      where: { ticker_type: { ticker: symbol, type: 'technicals' } },
    });

    if (dbInsight?.insight) {
      result.decisionIntelligence = dbInsight.insight;
    } else {
      const insight = await generateDecisionIntelligence(result);
      result.decisionIntelligence = insight;
      if (insight) {
        await prisma.aiInsight.upsert({
          where: { ticker_type: { ticker: symbol, type: 'technicals' } },
          create: { ticker: symbol, type: 'technicals', insight },
          update: { insight, updated_at: new Date() },
        });
      }
    }

    // Strip joined watchout strings from ruleEngine — decisionIntelligence has distilled versions
    if (result.ruleEngine) {
      const re = result.ruleEngine;
      const buckets = [
        re.structureEngine?.marketStructure,
        re.structureEngine?.participation,
        re.structureEngine?.priceStructure,
        re.trendEngine?.trendQuality,
        re.timingEngine?.momentum,
        re.timingEngine?.volatility,
        re.dominanceEngine?.leadership?.vsNifty,
        re.dominanceEngine?.leadership?.vsSector,
      ];
      for (const bucket of buckets) {
        if (!bucket) continue;
        delete bucket.growthWatchout;
        delete bucket.valueWatchout;
      }
    }

    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
}
async function getTickerInfo(req, res, next) {
  try {
    const sym = req.params.symbol.toUpperCase();

    // ── 1. Company identity from osc_identity.csv ──────────────────────────
    const { rows: idRows } = loadPeerIdentity();
    const idRow = idRows.find((r) => (r[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase() === sym);
    const companyName    = idRow ? (idRow[ID_COL_NAME] || '').trim() : null;
    const industryGroup  = idRow ? (idRow[ID_COL_INDUSTRY_GRP] || '').trim() : null;
    const basicIndustry  = idRow ? (idRow[ID_COL_NSE_BASIC_IND] || '').trim() : null;

    // ── 2. Price data from nse_equity ──────────────────────────────────────
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    const [latestPriceRows, yearPriceRows, mktCapRows, peRows, prowessRows] = await Promise.all([
      // Latest 2 rows to compute day change
      prisma.$queryRaw`
        SELECT datetime, open, high, low, close, volume
        FROM nse_equity
        WHERE symbol = ${sym}
        ORDER BY datetime DESC
        LIMIT 2
      `,
      // Last 1 year for 52W high/low
      prisma.$queryRaw`
        SELECT high, low
        FROM nse_equity
        WHERE symbol = ${sym} AND datetime >= ${oneYearAgo}
      `,
      // Latest market cap
      prisma.$queryRaw`
        SELECT "market_cap(Cr)" AS market_cap_cr, market_cap, date
        FROM market_cap
        WHERE symbol = ${sym}
        ORDER BY date DESC
        LIMIT 1
      `,
      // Latest P/E (pe_data keyed by company name)
      companyName
        ? prisma.$queryRaw`
            SELECT pe, date
            FROM pe_data
            WHERE company = ${companyName}
            ORDER BY date DESC
            LIMIT 1
          `
        : Promise.resolve([]),
      // KPI values from prowess_values_new (quarterly fundamentals)
      companyName
        ? prisma.$queryRaw`
            SELECT kpi_abbr, value, raw_value, unit, multiplier, fiscal_year, quarter, period_type
            FROM prowess_values_new
            WHERE company = ${companyName}
            ORDER BY fiscal_year DESC, quarter DESC
          `
        : Promise.resolve([]),
    ]);

    // ── 3. Price calculations ──────────────────────────────────────────────
    const today    = latestPriceRows[0] ?? null;
    const prevDay  = latestPriceRows[1] ?? null;

    if (!today && !companyName) {
      return res.status(404).json({ error: `Symbol "${sym}" not found` });
    }

    const price         = today?.close != null ? parseFloat(today.close) : null;
    const prevClose     = prevDay?.close != null ? parseFloat(prevDay.close) : null;
    const change        = price != null && prevClose != null ? r2(price - prevClose) : null;
    const changePercent = price != null && prevClose != null && prevClose !== 0
      ? r2((price - prevClose) / prevClose) : null;

    const week52High = yearPriceRows.length > 0
      ? r2(Math.max(...yearPriceRows.map((r) => parseFloat(r.high ?? 0)).filter(Boolean)))
      : null;
    const week52Low = yearPriceRows.length > 0
      ? r2(Math.min(...yearPriceRows.map((r) => parseFloat(r.low ?? Infinity)).filter((v) => v !== Infinity)))
      : null;

    // ── 4. Market cap ──────────────────────────────────────────────────────
    const mktCapRow = mktCapRows[0] ?? null;
    // market_cap(Cr) column is stored as market_cap_cr in schema
    const marketCapCr  = mktCapRow?.market_cap_cr != null ? parseFloat(mktCapRow.market_cap_cr) : null;
    // Convert Cr → absolute (1 Cr = 10M = 1e7)
    const marketCapAbs = marketCapCr != null ? marketCapCr * 1e7 : null;

    function marketCapLabel(capCr) {
      if (capCr == null) return null;
      if (capCr >= 20000) return 'Large cap';
      if (capCr >= 5000)  return 'Mid cap';
      return 'Small cap';
    }

    // ── 5. P/E ─────────────────────────────────────────────────────────────
    const peRow     = peRows[0] ?? null;
    // pe_data stores PE keyed by company name. Fallback: marketCap / annualised PAT.
    let trailingPE = peRow?.pe != null ? r2(parseFloat(peRow.pe)) : null;

    // ── 6. KPI helpers ─────────────────────────────────────────────────────
    // Group prowess rows by period (fiscal_year + quarter), latest first
    // Pick latest value for each kpi_abbr
    const kpiMap = {};
    for (const row of prowessRows) {
      const abbr = row.kpi_abbr;
      if (!kpiMap[abbr]) kpiMap[abbr] = row; // first = most recent due to ORDER BY
    }

    // Group all values for each kpi_abbr by period for trend/growth calculations
    const kpiByPeriod = {};
    for (const row of prowessRows) {
      const abbr = row.kpi_abbr;
      if (!kpiByPeriod[abbr]) kpiByPeriod[abbr] = [];
      kpiByPeriod[abbr].push(row);
    }

    // value in DB is already absolute (raw_value_in_Cr * multiplier); do NOT re-multiply.
    // raw_value is the Cr-denominated string; value is the absolute INR amount.
    function kpiVal(abbr) {
      const row = kpiMap[abbr];
      if (!row || row.value == null) return null;
      return parseFloat(row.value);
    }

    // kpiValCr: value in Crore (for human-readable fields where Cr is preferred)
    function kpiValCr(abbr) {
      const row = kpiMap[abbr];
      if (!row) return null;
      if (row.raw_value != null) return parseFloat(row.raw_value);
      if (row.value != null && row.multiplier != null && row.multiplier !== 0) {
        return parseFloat(row.value) / row.multiplier;
      }
      return null;
    }

    // YoY growth: compare latest vs same quarter prior year
    function kpiYoy(abbr) {
      const series = kpiByPeriod[abbr];
      if (!series || series.length < 2) return null;
      const latest = series[0];
      const curr = latest.value != null ? parseFloat(latest.value) : null;
      // Find entry from same quarter prior year (fiscal_year like "FY2025" → year int = 2025)
      const latestYear = latest.fiscal_year ? parseInt(latest.fiscal_year.replace(/\D/g, '')) : null;
      const prior = series.find(
        (r) => r.quarter === latest.quarter &&
               r.fiscal_year != null && latestYear != null &&
               parseInt(r.fiscal_year.replace(/\D/g, '')) === latestYear - 1
      ) ?? series[series.length - 1];
      const prev = prior?.value != null ? parseFloat(prior.value) : null;
      if (curr == null || prev == null || prev === 0) return null;
      return r2((curr - prev) / Math.abs(prev));
    }

    // ── 7. PE fallback from market cap / PAT (if pe_data had no entry) ────
    if (trailingPE == null && marketCapAbs != null) {
      const patForPe = kpiVal('PAT');
      if (patForPe != null && patForPe !== 0) {
        trailingPE = r2(marketCapAbs / patForPe);
      }
    }

    // ── 7b. Quarterly trend ─────────────────────────────────────────────────
    // Collect all unique periods that have revenue or net profit
    const TREND_ABBRS = new Set(['REV_OP', 'TOTAL_INCOME', 'PAT', 'EPS_BASIC', 'CFO']);
    const trendPeriods = {};
    for (const row of prowessRows) {
      if (!TREND_ABBRS.has(row.kpi_abbr)) continue;
      const key = `${row.fiscal_year}|${row.quarter}`;
      if (!trendPeriods[key]) trendPeriods[key] = { fiscal_year: row.fiscal_year, quarter: row.quarter };
      // Use value directly (already absolute); EPS_BASIC has multiplier=1, financials have multiplier=1e7
      trendPeriods[key][row.kpi_abbr] = row.value != null ? parseFloat(row.value) : null;
    }
    const quarterlyTrend = Object.values(trendPeriods)
      .sort((a, b) => {
        if (a.fiscal_year !== b.fiscal_year) return (a.fiscal_year ?? '').localeCompare(b.fiscal_year ?? '');
        return (a.quarter ?? '').localeCompare(b.quarter ?? '');
      })
      .map((p) => ({
        period:     `${p.quarter ?? ''} ${p.fiscal_year ?? ''}`.trim(),
        revenue:    p.REV_OP ?? p.TOTAL_INCOME ?? null,
        netIncome:  p.PAT ?? null,
        eps:        p.EPS_BASIC ?? null,
        cfo:        p.CFO ?? null,
      }));

    // ── 8. Derived / computed metrics ────────────────────────────────────────
    // Shares outstanding: EQ_SHARE_CAP is paid-up capital in Cr; divide by face value (₹10 default)
    // to get share count. But for ratios below we keep values consistent.
    const netWorthAbs   = kpiVal('NET_WORTH');   // absolute INR
    const patAbs        = kpiVal('PAT');
    const totalAssetsAbs = kpiVal('TOTAL_ASSETS');
    const eqShareCapAbs = kpiVal('EQ_SHARE_CAP'); // paid-up capital in INR (face value included)

    // Shares outstanding in absolute count: paid-up capital / face value (₹10 for most Indian banks)
    // EQ_SHARE_CAP raw_value is Cr of capital; shares = (raw_value * 1e7) / face_value
    const eqCapCr = kpiValCr('EQ_SHARE_CAP'); // Cr
    const FACE_VALUE = 10; // ₹10 default; adjust if needed per company
    const sharesOutstandingCount = eqCapCr != null ? Math.round((eqCapCr * 1e7) / FACE_VALUE) : null;

    // ROE = PAT / Net Worth (annualised; for quarterly PAT multiply by 4 for annual)
    // Both from same latest period (Q4 annual for Q4 data in prowess) — use as-is
    const roe = patAbs != null && netWorthAbs != null && netWorthAbs !== 0
      ? r2((patAbs / netWorthAbs) * 100) : null;

    // ROA = PAT / Total Assets
    const roa = patAbs != null && totalAssetsAbs != null && totalAssetsAbs !== 0
      ? r2((patAbs / totalAssetsAbs) * 100) : null;

    // Book Value per share (₹) = Net Worth / shares outstanding
    const bookValue = netWorthAbs != null && sharesOutstandingCount != null && sharesOutstandingCount !== 0
      ? r2(netWorthAbs / sharesOutstandingCount) : null;

    // Profit Margins = PAT / Revenue
    const revAbsForMargin = kpiVal('REV_OP') ?? kpiVal('TOTAL_INCOME');
    const profitMargins = patAbs != null && revAbsForMargin != null && revAbsForMargin !== 0
      ? r2((patAbs / revAbsForMargin) * 100) : null;

    // P/B ratio = price / book value per share; fallback: marketCap / netWorth
    const pbRatio = price != null && bookValue != null && bookValue !== 0
      ? r2(price / bookValue)
      : (marketCapAbs != null && netWorthAbs != null && netWorthAbs !== 0
          ? r2(marketCapAbs / netWorthAbs)
          : null);

    // EPS 3Y CAGR: compare latest EPS_BASIC vs 3 years ago (same quarter, 3 fiscal years back)
    const epsSeries = kpiByPeriod['EPS_BASIC'];
    let epsCagr3y = null;
    if (epsSeries && epsSeries.length >= 2) {
      const latestEps = epsSeries[0];
      const latestEpsYear = latestEps.fiscal_year ? parseInt(latestEps.fiscal_year.replace(/\D/g, '')) : null;
      const priorEps3y = epsSeries.find(
        (r) => r.quarter === latestEps.quarter &&
               r.fiscal_year != null && latestEpsYear != null &&
               parseInt(r.fiscal_year.replace(/\D/g, '')) === latestEpsYear - 3
      );
      if (priorEps3y && latestEps.value != null && priorEps3y.value != null && parseFloat(priorEps3y.value) > 0) {
        const curr3 = parseFloat(latestEps.value);
        const prev3 = parseFloat(priorEps3y.value);
        epsCagr3y = r2((Math.pow(curr3 / prev3, 1 / 3) - 1) * 100);
      }
    }

    function epsCagrLabel(cagr) {
      if (cagr == null) return null;
      if (cagr >= 20) return 'Excellent';
      if (cagr >= 12) return 'Good';
      if (cagr >= 5)  return 'Moderate';
      if (cagr >= 0)  return 'Weak';
      return 'Negative';
    }

    // ROCE 3Y avg
    const roceSeries = kpiByPeriod['ROCE'];
    let roce3yAvg = null;
    if (roceSeries && roceSeries.length >= 3) {
      const last3 = roceSeries.slice(0, 3);
      const vals = last3.map((r) => r.value != null ? parseFloat(r.value) : null).filter((v) => v != null);
      if (vals.length >= 2) roce3yAvg = r2(vals.reduce((s, v) => s + v, 0) / vals.length);
    }

    // ROE 3Y avg
    const roeSeries = kpiByPeriod['PAT'];
    const nwSeries  = kpiByPeriod['NET_WORTH'];
    let roe3yAvg = null;
    if (roeSeries && nwSeries && roeSeries.length >= 3 && nwSeries.length >= 3) {
      const roeVals = [];
      for (let i = 0; i < Math.min(3, roeSeries.length, nwSeries.length); i++) {
        const pat = roeSeries[i]?.value != null ? parseFloat(roeSeries[i].value) : null;
        const nw  = nwSeries[i]?.value != null  ? parseFloat(nwSeries[i].value)  : null;
        if (pat != null && nw != null && nw !== 0) roeVals.push((pat / nw) * 100);
      }
      if (roeVals.length >= 2) roe3yAvg = r2(roeVals.reduce((s, v) => s + v, 0) / roeVals.length);
    }

    // PE valuation label based on trailing PE
    function peValuationLabel(pe) {
      if (pe == null) return null;
      if (pe < 10) return 'Undervalued';
      if (pe < 20) return 'Fair value';
      if (pe < 35) return 'Moderately valued';
      return 'Expensive';
    }

    // Debt status
    const de = kpiVal('DE');
    function debtStatus(d) {
      if (d == null) return null;
      if (d <= 0.5)  return 'Low debt';
      if (d <= 1.0)  return 'Moderate debt';
      if (d <= 2.0)  return 'High debt';
      return 'Very high debt';
    }

    // ── 9. Build response ──────────────────────────────────────────────────
    res.json({
      symbol: sym,

      company: {
        name:        companyName || sym,
        exchange:    'NSE',
        sector:      industryGroup  || null,
        industry:    basicIndustry  || null,
        description: null,
        website:     null,
        employees:   null,
        country:     'India',
      },

      quote: {
        price,
        change,
        changePercent,
        open:           today?.open != null  ? r2(parseFloat(today.open))  : null,
        high:           today?.high != null  ? r2(parseFloat(today.high))  : null,
        low:            today?.low != null   ? r2(parseFloat(today.low))   : null,
        previousClose:  prevClose,
        volume:         today?.volume != null ? Number(today.volume) : null,
        avgVolume:      null,
        week52High,
        week52Low,
        marketCap:      marketCapAbs,
        marketCapLabel: marketCapLabel(marketCapCr),
        currency:       'INR',
        marketState:    null,
        lastUpdated:    today?.datetime ?? null,
      },

      financialPerformance: {
        // REV_OP = operating revenue (non-fin) / operating income (fin); TOTAL_INCOME includes other income
        revenue:          kpiVal('REV_OP') ?? kpiVal('TOTAL_INCOME'),
        revenueGrowth:    kpiYoy('REV_OP') ?? kpiYoy('TOTAL_INCOME'),
        grossProfits:     null,
        grossMargins:     null,
        ebitda:           null,
        ebitdaGrowth:     null,
        ebitdaMargins:    null,
        operatingMargins: null,
        netProfit:        kpiVal('PAT'),
        netProfitGrowth:  kpiYoy('PAT'),
        profitMargins,
        operatingCashflow: kpiVal('CFO'),
        cfoGrowth:        kpiYoy('CFO'),
        freeCashflow:     null,
        fcfGrowth:        null,
        earningsGrowth:   null,
        revenuePerShare:  null,
        reserves:         kpiVal('NET_WORTH'),
        reservesGrowth:   kpiYoy('NET_WORTH'),
        quarterlyTrend,
      },

      valuation: {
        peRatio:          trailingPE,
        peValuationLabel: peValuationLabel(trailingPE),
        forwardPE:        null,
        pbRatio,
        pegRatio:         null,
        evToEbitda:       null,
        evToRevenue:      null,
        enterpriseValue:  null,
        profitMargins,
        industryPE:       null,
        industryPELabel:  null,
      },

      efficiency: {
        returnOnEquity:    roe,
        returnOnAssets:    roa,
        debtToEquity:      kpiVal('DE'),
        debtGrowth:        kpiYoy('DE'),
        currentRatio:      null,
        quickRatio:        null,
        totalCash:         kpiVal('CASH_EQUIV'),
        totalDebt:         kpiVal('BORR_TOTAL') ?? (
          (kpiVal('DEBT_LT') != null || kpiVal('DEBT_ST') != null)
            ? (kpiVal('DEBT_LT') ?? 0) + (kpiVal('DEBT_ST') ?? 0)
            : null
        ),
        totalCashPerShare: null,
      },

      perShare: {
        eps:          kpiVal('EPS_BASIC') ?? kpiVal('EPS_DILUTED'),
        epsForward:   null,
        bookValue,
        dividendRate: null,
        dividendYield: null,
        payoutRatio:  null,
      },

      analystRatings: {
        targetHighPrice:         null,
        targetLowPrice:          null,
        targetMeanPrice:         null,
        targetMedianPrice:       null,
        recommendationKey:       null,
        numberOfAnalystOpinions: null,
      },

      keyStats: {
        beta:                    null,
        sharesOutstanding:       sharesOutstandingCount,
        floatShares:             null,
        heldPercentInsiders:     null,
        heldPercentInstitutions: null,
        earningsQuarterlyGrowth: kpiYoy('PAT'),
        fiftyDayAverage:         null,
        twoHundredDayAverage:    null,
        week52Change:            null,
      },

      ratios: {
        roce:      kpiVal('ROCE'),
        roce3yAvg,
        roe,
        roe3yAvg,
        debtStatus: debtStatus(kpiVal('DE')),
      },

      ownership: {
        promoter:     null,
        institutions: null,
        fii:          null,
        dii:          null,
        public:       null,
        publicLabel:  null,
      },

      financials: {
        eps_cagr_3y:       epsCagr3y,
        eps_cagr_3y_label: epsCagrLabel(epsCagr3y),
        ebitda_ev_yield:   null,
        cfo_ebitda_pct:    null,
        net_debt_ebitda:   null,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getFinancials(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const result = await financials.analyze(symbol);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getPrices(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const period1 = req.query.from
      ? new Date(req.query.from)
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // default: 1 year
    const period2 = req.query.to ? new Date(req.query.to) : new Date();

    const rows = await prisma.nse_equity.findMany({
      where: {
        symbol,
        datetime: { gte: period1, lte: period2 },
      },
      orderBy: { datetime: 'asc' },
      select: { datetime: true, open: true, high: true, low: true, close: true, volume: true },
    });

    if (rows.length === 0) {
      return res.status(404).json({ error: `No price data found for symbol ${symbol}` });
    }

    const prices = rows
      .filter((r) => r.close != null)
      .map((r) => ({
        date: r.datetime.toISOString().slice(0, 10),
        open: r.open ?? null,
        high: r.high ?? null,
        low: r.low ?? null,
        close: r.close ?? null,
        volume: r.volume != null ? Number(r.volume) : null,
      }));

    const indicators = computeIndicatorSeries(prices);

    res.json({ symbol, count: prices.length, prices, indicators });
  } catch (err) {
    next(err);
  }
}

// ── Charts ────────────────────────────────────────────────────────────────────

/**
 * GET /api/screener/:symbol/charts
 *
 * Returns chart-ready data grouped by: Price, PE Ratio, Sales & Margin.
 * Each group contains barSeries and lineSeries arrays whose data share the same x values.
 */
async function getCharts(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const ticker = symbol + '.NS';

    // ── 1. Fetch raw data in parallel ──────────────────────────────────────
    const now = Date.now();
    const tenYearsAgo = new Date(now - 10 * 365 * 24 * 60 * 60 * 1000);

    const [monthlyChartRes, quarterlyChartRes, peRowsRes, quarterlyFundamentalsRes, quarterlyIncomeRes, quarterlyBalanceSheetRes] = await Promise.allSettled([
      yahooFinance.chart(ticker, {
        period1: tenYearsAgo,
        period2: new Date(now),
        interval: '1mo',
      }),
      yahooFinance.chart(ticker, {
        period1: tenYearsAgo,
        period2: new Date(now),
        interval: '3mo',
      }),
      prisma.pe_data.findMany({
        where: { company: symbol },
        orderBy: { date: 'asc' },
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'financials',
        type: 'quarterly',
        period1: new Date(now - 2 * 365 * 24 * 60 * 60 * 1000),
      }),
      yahooFinance.quoteSummary(ticker, {
        modules: ['incomeStatementHistoryQuarterly'],
      }),
      yahooFinance.fundamentalsTimeSeries(ticker, {
        module: 'balance-sheet',
        type: 'quarterly',
        period1: new Date(now - 2 * 365 * 24 * 60 * 60 * 1000),
      }),
    ]);

    const monthlyChart        = monthlyChartRes.status           === 'fulfilled' ? monthlyChartRes.value           : null;
    const quarterlyChart      = quarterlyChartRes.status         === 'fulfilled' ? quarterlyChartRes.value         : null;
    const peRows              = peRowsRes.status                 === 'fulfilled' ? peRowsRes.value                 : [];
    const quarterlyFundamentals = quarterlyFundamentalsRes.status === 'fulfilled' ? quarterlyFundamentalsRes.value : [];
    // incomeStatementHistoryQuarterly: totalRevenue and netIncome are reliable; grossProfit/operatingIncome are zeroed since Nov 2024
    const quarterlyIncome     = quarterlyIncomeRes.status === 'fulfilled'
      ? (quarterlyIncomeRes.value?.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? [])
      : [];
    const quarterlyBalanceSheet = quarterlyBalanceSheetRes.status === 'fulfilled' ? quarterlyBalanceSheetRes.value : [];

    // ── 2. Price group ─────────────────────────────────────────────────────
    // Monthly bars sorted oldest→newest, labelled "Mon YYYY"
    const monthlyQuotes = (monthlyChart?.quotes ?? [])
      .filter((q) => q.close != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Compute rolling SMAs over the ordered close series
    function rollingAvg(closes, window) {
      return closes.map((_, i) => {
        if (i < window - 1) return null;
        const slice = closes.slice(i - window + 1, i + 1);
        return Math.round((slice.reduce((s, v) => s + v, 0) / window) * 100) / 100;
      });
    }

    const fmtMonthLabel = (date) => {
      const d = date instanceof Date ? date : new Date(date);
      return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
    };

    const monthlyLabels = monthlyQuotes.map((q) => fmtMonthLabel(q.date));
    const monthlyCloses = monthlyQuotes.map((q) => q.close);
    // 50 DMA ≈ 50-day: using 3-month monthly window as rough proxy; for monthly bars use 3
    // 200 DMA ≈ 200-day ≈ 10 months
    const dma50Values  = rollingAvg(monthlyCloses, 3);
    const dma200Values = rollingAvg(monthlyCloses, 10);

    const priceGroup = {
      group: 'Price',
      barSeries: [
        {
          dataKey: 'volume',
          name: 'Volume',
          data: monthlyQuotes.map((q, i) => ({ x: monthlyLabels[i], y: q.volume ?? null })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'priceNSE',
          name: 'Price on NSE',
          data: monthlyQuotes.map((q, i) => ({ x: monthlyLabels[i], y: Math.round(q.close * 100) / 100 })),
        },
        {
          dataKey: 'dma50',
          name: '50 DMA',
          data: monthlyLabels.map((x, i) => ({ x, y: dma50Values[i] })),
        },
        {
          dataKey: 'dma200',
          name: '200 DMA',
          data: monthlyLabels.map((x, i) => ({ x, y: dma200Values[i] })),
        },
      ],
    };

    // ── 3–7. Shared helpers for fundamentals-based groups ─────────────────
    // qChartQuotes: quarterly price series for priceForQuarter lookups
    const qChartQuotes = (quarterlyChart?.quotes ?? [])
      .filter((q) => q.close != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Sort balance sheet and financials oldest→newest
    const bsSorted = [...quarterlyBalanceSheet].sort((a, b) => new Date(a.date) - new Date(b.date));
    const qfSorted = [...quarterlyFundamentals].sort((a, b) => new Date(a.date) - new Date(b.date));

    // Most recent balance sheet entry — fallback for quarters beyond last BS date
    const latestBs = bsSorted.length > 0 ? bsSorted[bsSorted.length - 1] : null;

    // Find closest entry within ±50 days
    const MS_50D = 50 * 24 * 60 * 60 * 1000;
    function closestByDate(arr, targetMs) {
      let best = null, bestDiff = MS_50D;
      for (const r of arr) {
        const diff = Math.abs(new Date(r.date).getTime() - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = r; }
      }
      return best;
    }

    // Balance sheet for a quarter: closest match, or latest if target is beyond last BS date
    function bsForQuarter(targetMs) {
      const exact = closestByDate(bsSorted, targetMs);
      if (exact) return exact;
      if (latestBs && targetMs > new Date(latestBs.date).getTime()) return latestBs;
      return null;
    }

    // Price at a given quarter-end date, matched from qChartQuotes within ±50 days
    function priceForQuarter(targetMs) {
      return closestByDate(qChartQuotes.map((q) => ({ date: q.date, close: q.close })), targetMs)?.close ?? null;
    }

    // Shared x-axis labels for groups 3, 5–7 (oldest→newest, ~5 quarters)
    const fundLabels = qfSorted.map((r) =>
      new Date(r.date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    );

    // ── 3. PE Ratio group ──────────────────────────────────────────────────
    // X-axis: qfSorted (~5 quarters, same as groups 5–7).
    // TTM EPS = sum of basicEPS for up to 4 quarters ending at this date.
    // PE = price / TTM EPS. Fallback: closest pe_data entry within ±45 days.
    // Median PE: from pe_data DB if available.

    // Median PE across all pe_data rows
    const allPeValues = peRows
      .map((r) => (r.pe != null ? Number(r.pe) : null))
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    let medianPe = null;
    if (allPeValues.length > 0) {
      const mid = Math.floor(allPeValues.length / 2);
      medianPe = allPeValues.length % 2 === 0
        ? Math.round(((allPeValues[mid - 1] + allPeValues[mid]) / 2) * 100) / 100
        : Math.round(allPeValues[mid] * 100) / 100;
    }

    const MS_45D = 45 * 24 * 60 * 60 * 1000;

    // peData uses qfSorted as x-axis (same as groups 5–7)
    const peData = qfSorted.map((r) => {
      const qt = new Date(r.date).getTime();
      const price = priceForQuarter(qt);

      // TTM EPS: sum basicEPS across up to 4 quarters ending at this date
      const eligible = qfSorted.filter((x) => new Date(x.date).getTime() <= qt);
      const recent4 = eligible.slice(-4);
      const ttmEps = recent4.length > 0 && recent4.every((x) => x.basicEPS != null)
        ? Math.round(recent4.reduce((s, x) => s + x.basicEPS, 0) * 100) / 100
        : null;

      // Computed PE from price / ttmEps
      let pe = price != null && ttmEps != null && ttmEps !== 0
        ? Math.round((price / ttmEps) * 100) / 100
        : null;

      // Fallback: closest pe_data entry within ±45 days
      if (pe === null) {
        let best = null, bestDiff = MS_45D;
        for (const row of peRows) {
          const diff = Math.abs(new Date(row.date).getTime() - qt);
          if (diff < bestDiff) { bestDiff = diff; best = row; }
        }
        if (best?.pe != null) pe = Math.round(Number(best.pe) * 100) / 100;
      }

      return { ttmEps, pe };
    });

    const peGroup = {
      group: 'PE Ratio',
      barSeries: [
        {
          dataKey: 'ttmEps',
          name: 'TTM EPS',
          data: fundLabels.map((x, i) => ({ x, y: peData[i].ttmEps })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'pe',
          name: 'PE',
          data: fundLabels.map((x, i) => ({ x, y: peData[i].pe })),
        },
        {
          dataKey: 'medianPe',
          name: 'Median PE',
          data: fundLabels.map((x) => ({ x, y: medianPe })),
        },
      ],
    };

    // ── 4. Sales & Margin group ────────────────────────────────────────────
    // Merge quarterlyFundamentals (5 periods) + quarterlyIncome (4 periods) deduplicated,
    // sorted oldest→newest.

    const smMerged = [...quarterlyFundamentals];
    for (const r of quarterlyIncome) {
      const rDate = new Date(r.endDate).toISOString().slice(0, 10);
      const existing = smMerged.find(
        (x) => new Date(x.date).toISOString().slice(0, 10) === rDate
      );
      if (existing) {
        // Backfill only totalRevenue and netIncome if missing — grossProfit/operatingIncome are zeroed in this source
        if (existing.totalRevenue == null && r.totalRevenue != null) existing.totalRevenue = r.totalRevenue;
        if (existing.netIncome == null && r.netIncome != null) existing.netIncome = r.netIncome;
      } else {
        smMerged.push({ date: r.endDate, totalRevenue: r.totalRevenue, netIncome: r.netIncome });
      }
    }
    smMerged.sort((a, b) => new Date(a.date) - new Date(b.date));

    const smLabels = smMerged.map((r) =>
      new Date(r.date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    );

    const smRevenue = smMerged.map((r) => {
      const v = r.totalRevenue;
      return v != null ? Math.round(v / 1e7 * 100) / 100 : null;
    });

    const smOpm = smMerged.map((r) => {
      const rev = r.totalRevenue;
      const opInc = r.operatingIncome != null ? r.operatingIncome : (
        r.totalRevenue != null && (r.operatingExpense ?? r.totalExpenses) != null
          ? r.totalRevenue - (r.operatingExpense ?? r.totalExpenses)
          : null
      );
      if (!rev || opInc === null) return null;
      return Math.round((opInc / rev) * 10000) / 100;
    });

    const smGpm = smMerged.map((r) => {
      const rev = r.totalRevenue;
      const gp = r.grossProfit != null ? r.grossProfit : (
        r.totalRevenue != null && r.costOfRevenue != null
          ? r.totalRevenue - r.costOfRevenue
          : null
      );
      if (!rev || gp === null) return null;
      return Math.round((gp / rev) * 10000) / 100;
    });

    const smNpm = smMerged.map((r) => {
      const rev = r.totalRevenue;
      const np = r.netIncome;
      if (!rev || np == null) return null;
      return Math.round((np / rev) * 10000) / 100;
    });

    const salesMarginGroup = {
      group: 'Sales & Margin',
      barSeries: [
        {
          dataKey: 'quarterSales',
          name: 'Quarter Sales',
          data: smLabels.map((x, i) => ({ x, y: smRevenue[i] })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'gpm',
          name: 'GPM %',
          data: smLabels.map((x, i) => ({ x, y: smGpm[i] })),
        },
        {
          dataKey: 'opm',
          name: 'OPM %',
          data: smLabels.map((x, i) => ({ x, y: smOpm[i] })),
        },
        {
          dataKey: 'npm',
          name: 'NPM %',
          data: smLabels.map((x, i) => ({ x, y: smNpm[i] })),
        },
      ],
    };

    // ── 5. EV / EBITDA group ───────────────────────────────────────────────
    // Bar: quarterly EBITDA (Cr). Line: EV/EBITDA per quarter. Median: 30.3.

    const evEbitdaData = qfSorted.map((r) => {
      const qt = new Date(r.date).getTime();
      const price = priceForQuarter(qt);
      const ebitdaCr = r.EBITDA != null ? Math.round(r.EBITDA / 1e7 * 100) / 100 : null;

      const bs = bsForQuarter(qt);
      const shares = bs?.ordinarySharesNumber ?? null;
      const totalDebt = bs?.totalDebt ?? 0;
      const cash = bs?.cashCashEquivalentsAndShortTermInvestments ?? bs?.cashAndCashEquivalents ?? 0;
      const ev = price != null && shares != null ? price * shares + totalDebt - cash : null;

      // TTM EBITDA: sum of up to 4 quarters ending at this date
      const eligible = qfSorted.filter((x) => new Date(x.date).getTime() <= qt);
      const recent4 = eligible.slice(-4);
      const ttmEbitda = recent4.length > 0 && recent4.every((x) => x.EBITDA != null)
        ? recent4.reduce((s, x) => s + x.EBITDA, 0)
        : null;

      const ratio = ev != null && ttmEbitda != null && ttmEbitda !== 0
        ? Math.round((ev / ttmEbitda) * 100) / 100
        : null;

      return { ebitdaCr, ratio };
    });

    const MEDIAN_EV_EBITDA = 30.3;
    const evEbitdaGroup = {
      group: 'EV / EBITDA',
      barSeries: [
        {
          dataKey: 'ebitda',
          name: 'EBITDA',
          data: fundLabels.map((x, i) => ({ x, y: evEbitdaData[i].ebitdaCr })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'evToEbitda',
          name: 'EV / EBITDA',
          data: fundLabels.map((x, i) => ({ x, y: evEbitdaData[i].ratio })),
        },
        {
          dataKey: 'medianEvMultiple',
          name: `Median EV Multiple = ${MEDIAN_EV_EBITDA}`,
          data: fundLabels.map((x) => ({ x, y: MEDIAN_EV_EBITDA })),
        },
      ],
    };

    // ── 6. Price to Book group ─────────────────────────────────────────────
    // Bar: Book Value per share (₹). Line: P/BV. Median: 19.6.

    const pbvData = qfSorted.map((r) => {
      const qt = new Date(r.date).getTime();
      const price = priceForQuarter(qt);
      const bs = bsForQuarter(qt);
      const equity = bs?.stockholdersEquity ?? bs?.commonStockEquity ?? null;
      const shares = bs?.ordinarySharesNumber ?? null;
      const bvps = equity != null && shares != null && shares !== 0
        ? Math.round((equity / shares) * 100) / 100
        : null;
      const pbv = price != null && bvps != null && bvps !== 0
        ? Math.round((price / bvps) * 100) / 100
        : null;
      return { bvps, pbv };
    });

    const MEDIAN_PBV = 19.6;
    const priceToBookGroup = {
      group: 'Price to Book',
      barSeries: [
        {
          dataKey: 'bookValue',
          name: 'Book Value',
          data: fundLabels.map((x, i) => ({ x, y: pbvData[i].bvps })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'priceToBV',
          name: 'Price to BV',
          data: fundLabels.map((x, i) => ({ x, y: pbvData[i].pbv })),
        },
        {
          dataKey: 'medianPBV',
          name: `Median PBV = ${MEDIAN_PBV}`,
          data: fundLabels.map((x) => ({ x, y: MEDIAN_PBV })),
        },
      ],
    };

    // ── 7. Market Cap / Sales group ────────────────────────────────────────
    // Bar: quarterly Sales (Cr). Line: Market Cap / TTM Sales. Median: 3.5.

    const mcSalesData = qfSorted.map((r) => {
      const qt = new Date(r.date).getTime();
      const price = priceForQuarter(qt);
      const bs = bsForQuarter(qt);
      const shares = bs?.ordinarySharesNumber ?? null;
      const marketCap = price != null && shares != null ? price * shares : null;

      const quarterRevenueCr = r.totalRevenue != null ? Math.round(r.totalRevenue / 1e7 * 100) / 100 : null;

      // TTM revenue: sum of up to 4 quarters ending at this date
      const eligible = qfSorted.filter((x) => new Date(x.date).getTime() <= qt);
      const recent4 = eligible.slice(-4);
      const ttmRevenue = recent4.length > 0 && recent4.every((x) => x.totalRevenue != null)
        ? recent4.reduce((s, x) => s + x.totalRevenue, 0)
        : null;

      const mcToSales = marketCap != null && ttmRevenue != null && ttmRevenue !== 0
        ? Math.round((marketCap / ttmRevenue) * 100) / 100
        : null;

      return { quarterRevenueCr, mcToSales };
    });

    const MEDIAN_MC_SALES = 3.5;
    const mcSalesGroup = {
      group: 'Market Cap / Sales',
      barSeries: [
        {
          dataKey: 'sales',
          name: 'Sales',
          data: fundLabels.map((x, i) => ({ x, y: mcSalesData[i].quarterRevenueCr })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'mcToSales',
          name: 'Market Cap / Sales',
          data: fundLabels.map((x, i) => ({ x, y: mcSalesData[i].mcToSales })),
        },
        {
          dataKey: 'medianMcToSales',
          name: `Median Market Cap to Sales = ${MEDIAN_MC_SALES}`,
          data: fundLabels.map((x) => ({ x, y: MEDIAN_MC_SALES })),
        },
      ],
    };

    res.json({ chartGroups: [priceGroup, peGroup, salesMarginGroup, evEbitdaGroup, priceToBookGroup, mcSalesGroup] });
  } catch (err) {
    next(err);
  }
}

// ── Peer comparison ───────────────────────────────────────────────────────────

/**
 * POST /api/screener/:symbol/peers
 *
 * Body (optional):
 *   { "indicators": ["cmp","pe","marketCap","divYld","npQtr","qtrProfitVar","salesQtr","qtrSalesVar","roce"] }
 *
 * 1. Resolve symbol → NSE Basic Industry classification via osc_identity.csv
 * 2. Collect all peers in the same basic industry (+ same industry group for tighter match)
 * 3. Pull latest-quarter fundamentals from osc_fundamental_ind_qtr_v4.csv
 * 4. Bulk-fetch Yahoo Finance quotes for live CMP & Market Cap
 * 5. Return table rows with requested indicators as columns
 */
async function getPeers(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();

    // Default column set matches the image
    const DEFAULT_INDICATORS = ['cmp','pe','marketCap','divYld','npQtr','qtrProfitVar','salesQtr','qtrSalesVar','roce'];
    const requestedIndicators = (req.body && Array.isArray(req.body.indicators) && req.body.indicators.length > 0)
      ? req.body.indicators
      : DEFAULT_INDICATORS;

    // ── 1. Find subject company in identity CSV ──────────────────────────────
    const { rows: idRows } = loadPeerIdentity();
    const subjectRow = idRows.find((r) => (r[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase() === symbol);
    if (!subjectRow) {
      return res.status(404).json({ error: `Symbol "${symbol}" not found in identity data` });
    }

    const subjectBasicInd  = (subjectRow[ID_COL_NSE_BASIC_IND] || '').trim();
    const subjectIndGrp    = (subjectRow[ID_COL_INDUSTRY_GRP]  || '').trim();

    // ── 2. Find all peers in same basic industry ─────────────────────────────
    // Include subject itself so it appears in the table (highlighted by caller)
    const peerRows = idRows.filter((r) => {
      const ind = (r[ID_COL_NSE_BASIC_IND] || '').trim();
      const sym = (r[ID_COL_NSE_SYMBOL] || '').trim();
      return ind === subjectBasicInd && sym !== '';
    });

    if (peerRows.length === 0) {
      return res.status(404).json({ error: `No peers found for industry "${subjectBasicInd}"` });
    }

    // ── 3. Load Prowess fundamentals ─────────────────────────────────────────
    const { fundMap, qtrs } = loadPeerFundamentals();
    const LATEST = PEER_PERIOD_COUNT - 1;   // index 7
    const YEAR_AGO = LATEST - 4;            // index 3  (same quarter, prior year)

    const nseSymbols = peerRows.map((r) => (r[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase()).filter(Boolean);

    // ── 4. Bulk-fetch CMP, Market Cap, and PE from DB ────────────────────────
    const needCmp       = requestedIndicators.includes('cmp');
    const needMarketCap = requestedIndicators.includes('marketCap');
    const needPe        = requestedIndicators.includes('pe');
    const needRoce      = requestedIndicators.includes('roce');

    // CMP: latest close per symbol from nse_equity
    const cmpMap = {};
    if (needCmp || needMarketCap) {
      const latestPrices = await prisma.$queryRaw`
        SELECT DISTINCT ON (symbol) symbol, close
        FROM nse_equity
        WHERE symbol = ANY(${nseSymbols})
        ORDER BY symbol, datetime DESC
      `;
      for (const row of latestPrices) {
        if (row.close != null) cmpMap[row.symbol.toUpperCase()] = parseFloat(row.close);
      }
    }

    // Market Cap: latest entry per symbol from market_cap table
    const mktCapMap = {};
    if (needMarketCap) {
      const latestMktCap = await prisma.$queryRaw`
        SELECT DISTINCT ON (symbol) symbol, "market_cap(Cr)" AS market_cap_cr
        FROM market_cap
        WHERE symbol = ANY(${nseSymbols})
        ORDER BY symbol, date DESC
      `;
      for (const row of latestMktCap) {
        if (row.market_cap_cr != null) mktCapMap[row.symbol.toUpperCase()] = parseFloat(row.market_cap_cr);
      }
    }

    // PE: latest entry per company from pe_data table (keyed by company name)
    const peDbMap = {};
    if (needPe) {
      const companyNames = peerRows.map((r) => (r[ID_COL_NAME] || '').trim()).filter(Boolean);
      const latestPe = await prisma.$queryRaw`
        SELECT DISTINCT ON (company) company, pe
        FROM pe_data
        WHERE company = ANY(${companyNames})
        ORDER BY company, date DESC
      `;
      for (const row of latestPe) {
        if (row.pe != null) peDbMap[row.company.trim()] = parseFloat(row.pe);
      }
    }

    // ROCE: load osc_mod_qtr_v1.csv — EBIT / Capital Employed
    // EBIT ≈ Net Profit + Interest (annualised from latest quarter × 4 is not done; use raw Qtr EBIT)
    // Capital Employed = Paid-up Capital + Reserves + Borrowings
    const modMap = needRoce ? loadModData() : {};

    // ── 5. Build table rows ──────────────────────────────────────────────────
    const latestQtr = qtrs[LATEST];
    const yearAgoQtr = qtrs[YEAR_AGO] || null;

    const peers = peerRows.map((idRow) => {
      const peerSymbol  = (idRow[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase();
      const companyName = (idRow[ID_COL_NAME] || '').trim();
      const fundRow     = fundMap[companyName] || null;

      // ── DB-sourced data ──
      const cmp       = needCmp       ? r2(cmpMap[peerSymbol] ?? null)    : undefined;
      let   marketCap = needMarketCap ? r2(mktCapMap[peerSymbol] ?? null)  : undefined;

      // If market_cap table is missing the symbol, derive from CMP × shares (Prowess)
      if (needMarketCap && marketCap == null && fundRow) {
        const shares = peerPeriodVal(fundRow, LATEST, PEER_OFF.SHARES); // crore shares
        const price  = cmpMap[peerSymbol] ?? null;
        if (shares != null && price != null) {
          marketCap = r2((shares * price) / 100); // shares(Cr) × price / 100 → Cr (price in ₹, shares in Cr)
        }
      }

      // ── Prowess fundamentals (latest period) ──
      let pe           = needPe ? r2(peDbMap[companyName] ?? null) : undefined;
      let divYld       = null;
      let npQtr        = null;
      let salesQtr     = null;
      let qtrProfitVar = null;
      let qtrSalesVar  = null;
      let roce         = null;

      if (fundRow) {
        // PE fallback: Prowess CSV if DB had no entry
        if (needPe && pe == null) pe = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.PE));

        divYld   = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.YIELD));
        npQtr    = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.NET_PROFIT));
        salesQtr = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.TOTAL_INCOME));

        const npPrior    = peerPeriodVal(fundRow, YEAR_AGO, PEER_OFF.NET_PROFIT);
        const salesPrior = peerPeriodVal(fundRow, YEAR_AGO, PEER_OFF.TOTAL_INCOME);
        if (npQtr != null && npPrior != null && npPrior !== 0) {
          qtrProfitVar = r2(((npQtr - npPrior) / Math.abs(npPrior)) * 100);
        }
        if (salesQtr != null && salesPrior != null && salesPrior !== 0) {
          qtrSalesVar = r2(((salesQtr - salesPrior) / Math.abs(salesPrior)) * 100);
        }
      }

      // ROCE from osc_mod_qtr_v1.csv
      // Formula: ROCE = EBIT / Capital Employed × 100
      //   EBIT            = Net Profit + Interest Expenses  (latest quarter, annualised ×4)
      //   Capital Employed = Paid-up Capital + Reserves + Borrowings
      if (needRoce) {
        const modRow = modMap[companyName] || null;
        if (modRow) {
          // Latest period = last block: col offset = 1 + (n-1)*54 where n is derived from row length
          const totalCols   = modRow.length - 1; // exclude col 0 (company name)
          const periodCount = Math.floor(totalCols / MOD_COLS_PER_PERIOD);
          const lastPeriod  = periodCount - 1;
          const base        = 1 + lastPeriod * MOD_COLS_PER_PERIOD;

          const netProfit  = peerToFloat(modRow[base + MOD_OFF.NET_PROFIT]);
          const interest   = peerToFloat(modRow[base + MOD_OFF.INTEREST]);
          const paidCap    = peerToFloat(modRow[base + MOD_OFF.PAID_CAP]);
          const reserves   = peerToFloat(modRow[base + MOD_OFF.RESERVES]);
          const borrowings = peerToFloat(modRow[base + MOD_OFF.BORROWINGS]);

          if (netProfit != null && interest != null && paidCap != null && reserves != null && borrowings != null) {
            const ebitQtr        = netProfit + interest;
            const ebitAnnualised = ebitQtr * 4;
            const capitalEmployed = paidCap + reserves + borrowings;
            if (capitalEmployed > 0) {
              roce = r2((ebitAnnualised / capitalEmployed) * 100);
            }
          }
        }
      }

      const row = {
        symbol:    peerSymbol,
        name:      companyName,
        isSubject: peerSymbol === symbol,
      };

      if (requestedIndicators.includes('cmp'))          row.cmp          = cmp ?? null;
      if (requestedIndicators.includes('pe'))           row.pe           = pe ?? null;
      if (requestedIndicators.includes('marketCap'))    row.marketCapCr  = marketCap ?? null;
      if (requestedIndicators.includes('divYld'))       row.divYld       = divYld;
      if (requestedIndicators.includes('npQtr'))        row.npQtrCr      = npQtr;
      if (requestedIndicators.includes('qtrProfitVar')) row.qtrProfitVar = qtrProfitVar;
      if (requestedIndicators.includes('salesQtr'))     row.salesQtrCr   = salesQtr;
      if (requestedIndicators.includes('qtrSalesVar'))  row.qtrSalesVar  = qtrSalesVar;
      if (requestedIndicators.includes('roce'))         row.roce         = roce;

      return row;
    });

    // Sort: subject first, then by marketCap desc
    peers.sort((a, b) => {
      if (a.isSubject) return -1;
      if (b.isSubject) return 1;
      return (b.marketCapCr ?? 0) - (a.marketCapCr ?? 0);
    });

    res.json({
      symbol,
      basicIndustry: subjectBasicInd,
      industryGroup: subjectIndGrp,
      latestQuarter: latestQtr,
      yearAgoQuarter: yearAgoQtr,
      indicators: requestedIndicators,
      count: peers.length,
      peers,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getTickerInfo, getTechnicals, getFinancials, getPrices, getCharts, getPeers };
