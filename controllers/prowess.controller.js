'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
const YahooFinance = require('yahoo-finance2').default;

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── CSV structure notes ────────────────────────────────────────────────────────
// osc_identity.csv     : "Company Name" ↔ "NSE symbol" mapping (row 0 = header)
// osc_fundamental_ind_qtr_v3.csv : company rows (row 6+), 12 period blocks of 21 cols each
//   Col 0 = Company Name; periods L-11 … L, each starting at col 1 + period_index*21
//
//   Each period block (L-11 to L) represents the SAME quarter for a company.
//   L-11 to L are 12 consecutive NSE trading day price snapshots within that quarter.
//   The quarter itself is identified by ntrm_date (offset 17) — e.g. "31-12-2025" = Dec-25 quarter.
//
//   Within each period block (0-based offset):
//     0  Shares Outstanding                                   [same across all 12 days]
//     1  Market Capitalisation         (Rs. Crore)            [price-derived — varies per trading day]
//     2  Total Returns (%)                                    [price-derived — varies per trading day]
//     3  Adjusted EPS                  (TTM)                  [price-derived — varies per trading day]
//     4  Adjusted Cash EPS                                    [price-derived — varies per trading day]
//     5  P/E (Price to Earnings Ratio)                        [price-derived — varies per trading day]
//     6  P/B (Price to Book Value Ratio)                      [price-derived — varies per trading day]
//     7  Book Value per Share          (Indian Rupee)         [quarterly fundamental — same across all 12 days]
//     8  Yield                                                [price-derived — varies per trading day]
//     9  Enterprise value              (Rs. Crore)            [price-derived — varies per trading day]
//    10  Market Capitalisation / Enterprise Value             [price-derived — varies per trading day]
//    11  Enterprise Value / PBDITA                            [price-derived — varies per trading day]
//    12  Cost of goods sold            (Rs. Crore)            [quarterly fundamental — same across all 12 days]
//    13  Total income from continuing operations (Rs. Crore)  [quarterly fundamental — same across all 12 days]
//    14  Total expenses                (Rs. Crore)            [quarterly fundamental — same across all 12 days]
//    15  Net Profit                    (Rs. Crore)            [quarterly fundamental — same across all 12 days]
//    16  Earnings per share before extraordinary item (₹)    [quarterly fundamental — same across all 12 days]
//    17  ntrm_date — quarter-end date  (DD-MM-YYYY)           [quarterly fundamental — same across all 12 days]
//    18  ntrm_months — period length   (Months)               [quarterly fundamental — same across all 12 days]
//    19  ntrm_source — data source     (Text)                 [quarterly fundamental — same across all 12 days]
//    20  ntrm_date_signed — results filing date (DD-MM-YYYY)  [quarterly fundamental — same across all 12 days]

const COLS_PER_PERIOD = 21;
const PERIOD_COUNT = 12; // L-11 … L

const OFF = {
  SHARES: 0,
  MARKET_CAP: 1,
  TOTAL_RETURNS: 2,
  ADJ_EPS: 3,
  ADJ_CASH_EPS: 4,
  PE: 5,
  PB: 6,
  BVPS: 7,
  YIELD: 8,
  EV: 9,
  MC_EV: 10,
  EV_PBDITA: 11,
  COGS: 12,
  TOTAL_INCOME: 13,
  TOTAL_EXPENSES: 14,
  NET_PROFIT: 15,
  EPS_BASIC: 16,
  NTRM_DATE: 17,      // quarter-end date — use this to label the quarter
  NTRM_MONTHS: 18,
  NTRM_SOURCE: 19,
  NTRM_DATE_SIGNED: 20,
};

// ── Lazy-loaded data ──────────────────────────────────────────────────────────

let _identityMap = null;    // NSE symbol (uppercase) → Company Name
let _fundamentalMap = null; // Company Name (exact) → row array

function loadIdentityMap() {
  if (_identityMap) return _identityMap;
  const raw = fs.readFileSync(
    path.join(__dirname, '../lib/osc_identity.csv'),
    'utf-8'
  );
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const rows = csvParse.parse(content, { columns: true, relax_column_count: true });
  _identityMap = {};
  for (const row of rows) {
    const sym = (row['NSE symbol'] || '').trim().toUpperCase();
    const name = (row['Company Name'] || '').trim();
    if (sym && name) _identityMap[sym] = name;
  }
  return _identityMap;
}

function loadFundamentalMap() {
  if (_fundamentalMap) return _fundamentalMap;
  const raw = fs.readFileSync(
    path.join(__dirname, '../lib/osc_fundamental_ind_qtr_v3.csv'),
    'utf-8'
  );
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const allRows = csvParse.parse(content, { relax_column_count: true });
  _fundamentalMap = {};
  for (const row of allRows.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) _fundamentalMap[name] = row;
  }
  return _fundamentalMap;
}


/**
 * Derive the quarter label (Mon-YY format) from ntrm_date (DD-MM-YYYY).
 * ntrm_date is the quarter-end date (e.g. "31-12-2025" → "Dec-25").
 * All 12 L-11…L periods share the same ntrm_date, so this returns one label.
 */
function quarterLabelFromNtrmDate(ntrmDateStr) {
  const parts = (ntrmDateStr || '').split('-');
  if (parts.length !== 3) return null;
  const [, mm, yyyy] = parts;
  const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthIdx = parseInt(mm, 10) - 1;
  return `${monthShort[monthIdx]}-${String(yyyy).slice(2)}`;
}

/** Resolve NSE symbol → company row, returns null if not found */
function findCompanyRow(symbol) {
  const identityMap = loadIdentityMap();
  const fundamentalMap = loadFundamentalMap();
  const companyName = identityMap[symbol.toUpperCase()];
  if (!companyName) return null;
  return fundamentalMap[companyName] ?? null;
}

/** Parse CSV cell to float; returns null on empty/NaN */
function toFloat(val) {
  if (val === '' || val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Round to 2 decimal places */
function r2(v) {
  if (v == null) return null;
  return Math.round(v * 100) / 100;
}

/** Extract one period's data from a company row (periodIndex: 0 = L-11, 11 = L) */
function periodData(row, periodIndex) {
  const start = 1 + periodIndex * COLS_PER_PERIOD;
  return {
    shares: toFloat(row[start + OFF.SHARES]),
    marketCapCr: toFloat(row[start + OFF.MARKET_CAP]),
    totalReturns: toFloat(row[start + OFF.TOTAL_RETURNS]),
    adjEps: toFloat(row[start + OFF.ADJ_EPS]),
    adjCashEps: toFloat(row[start + OFF.ADJ_CASH_EPS]),
    pe: toFloat(row[start + OFF.PE]),
    pb: toFloat(row[start + OFF.PB]),
    bvps: toFloat(row[start + OFF.BVPS]),
    yield_: toFloat(row[start + OFF.YIELD]),
    ev: toFloat(row[start + OFF.EV]),
    mcEv: toFloat(row[start + OFF.MC_EV]),
    evPbdita: toFloat(row[start + OFF.EV_PBDITA]),
    cogsCr: toFloat(row[start + OFF.COGS]),
    totalIncomeCr: toFloat(row[start + OFF.TOTAL_INCOME]),
    totalExpCr: toFloat(row[start + OFF.TOTAL_EXPENSES]),
    netProfitCr: toFloat(row[start + OFF.NET_PROFIT]),
    epsBasic: toFloat(row[start + OFF.EPS_BASIC]),
    ntrmDate: row[start + OFF.NTRM_DATE] || null,           // quarter-end date (DD-MM-YYYY)
    ntrmMonths: toFloat(row[start + OFF.NTRM_MONTHS]),
    ntrmSource: row[start + OFF.NTRM_SOURCE] || null,
    ntrmDateSigned: row[start + OFF.NTRM_DATE_SIGNED] || null,
  };
}


// ── Controller ────────────────────────────────────────────────────────────────

/**
 * GET /api/prowess/:symbol/charts
 *
 * Chart groups:
 *   1. Price          — yfinance monthly (10 years)
 *   2. PE Ratio       — Prowess: bar=Adj EPS (TTM), line=PE + Median PE
 *   3. Sales & Margin — Prowess: bar=Quarter Sales (Cr), lines=GPM%/OPM%/NPM%
 *   4. EV / EBITDA    — Prowess: bar=EV (Cr), line=EV/PBDITA + Median
 *   5. Price to Book  — Prowess: bar=Stock Price (₹), line=P/B + Median PBV
 *   6. Market Cap / Sales — Prowess: bar=Quarter Sales (Cr), line=MC/TTM Sales + Median
 *
 * For groups 2-6: x-axis label = quarter derived from ntrm_date (e.g. "Dec-25").
 * All 12 L-11…L series points share the same quarter label since they are price
 * snapshots within the same quarter.
 */
async function getCharts(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const ticker = symbol + '.NS';

    // ── Resolve company ───────────────────────────────────────────────────────
    const companyRow = findCompanyRow(symbol);
    if (!companyRow) {
      return res.status(404).json({
        error: `Symbol "${symbol}" not found in Prowess identity mapping or fundamentals data.`,
      });
    }
    const companyName = companyRow[0];

    // ── Extract all 12 periods (L-11 = oldest snapshot, L = latest snapshot) ──
    const periods = Array.from({ length: PERIOD_COUNT }, (_, i) => periodData(companyRow, i));

    // Quarter label derived from ntrm_date (all 12 periods share the same quarter).
    // Use the latest period's ntrm_date as the authoritative quarter label.
    const quarterLabel = quarterLabelFromNtrmDate(periods[PERIOD_COUNT - 1].ntrmDate) || 'Current';

    // x-axis for Prowess charts: all 12 points are NSE trading day price snapshots
    // within the same quarter (L-11 = oldest, L = latest). Labelled as "Mon-YY · N".
    const snapshotLabels = Array.from({ length: PERIOD_COUNT }, (_, i) =>
      `${quarterLabel} · ${i + 1}`
    );

    // ── 1. Price group — yfinance ─────────────────────────────────────────────
    const now = Date.now();
    const tenYearsAgo = new Date(now - 10 * 365 * 24 * 60 * 60 * 1000);

    let monthlyChart = null;
    try {
      monthlyChart = await yahooFinance.chart(ticker, {
        period1: tenYearsAgo,
        period2: new Date(now),
        interval: '1mo',
      });
    } catch (_) {
      // non-fatal
    }

    const monthlyQuotes = (monthlyChart?.quotes ?? [])
      .filter((q) => q.close != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    function rollingAvg(closes, window) {
      return closes.map((_, i) => {
        if (i < window - 1) return null;
        const slice = closes.slice(i - window + 1, i + 1);
        return r2(slice.reduce((s, v) => s + v, 0) / window);
      });
    }

    const fmtMonthLabel = (date) => {
      const d = date instanceof Date ? date : new Date(date);
      return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
    };

    const monthlyLabels = monthlyQuotes.map((q) => fmtMonthLabel(q.date));
    const monthlyCloses = monthlyQuotes.map((q) => q.close);
    const dma50Values = rollingAvg(monthlyCloses, 3);
    const dma200Values = rollingAvg(monthlyCloses, 10);

    const priceGroup = {
      group: 'Price',
      source: 'yfinance',
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
          data: monthlyQuotes.map((q, i) => ({ x: monthlyLabels[i], y: r2(q.close) })),
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

    // ── Median PE from periods ────────────────────────────────────────────────
    const peValues = periods
      .map((p) => p.pe)
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    let medianPe = null;
    if (peValues.length > 0) {
      const mid = Math.floor(peValues.length / 2);
      medianPe = peValues.length % 2 === 0
        ? r2((peValues[mid - 1] + peValues[mid]) / 2)
        : r2(peValues[mid]);
    }

    // ── 2. PE Ratio group ─────────────────────────────────────────────────────
    // Bar: Earnings Yield % = (1 / PE) × 100 — varies per snapshot since PE varies.
    //   Useful for comparing against bond/FD rates to judge valuation.
    // Line: PE ratio (price-derived) + Median PE (flat reference line).
    const peGroup = {
      group: 'PE Ratio',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'earningsYield',
          name: 'Earnings Yield %',
          data: periods.map((p, i) => ({
            x: snapshotLabels[i],
            y: p.pe != null && p.pe !== 0 ? r2((1 / p.pe) * 100) : null,
          })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'pe',
          name: 'PE',
          data: periods.map((p, i) => ({ x: snapshotLabels[i], y: r2(p.pe) })),
        },
        {
          dataKey: 'medianPe',
          name: 'Median PE',
          data: periods.map((_, i) => ({ x: snapshotLabels[i], y: medianPe })),
        },
      ],
    };

    // ── 3. Sales & Margin group ───────────────────────────────────────────────
    // Bar: Quarter Sales (Cr) — quarterly fundamental, same across all 12 snapshots.
    // Lines: GPM%, OPM%, NPM% — also fixed quarterly fundamentals.
    //   GPM% = (TotalIncome - COGS) / TotalIncome * 100
    //   OPM% = (TotalIncome - TotalExpenses) / TotalIncome * 100
    //   NPM% = NetProfit / TotalIncome * 100
    // Note: All values are the same for each of the 12 snapshots (single quarter data).
    const salesMarginGroup = {
      group: 'Sales & Margin',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'quarterSales',
          name: 'Quarter Sales (Cr)',
          data: periods.map((p, i) => ({ x: snapshotLabels[i], y: r2(p.totalIncomeCr) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'gpm',
          name: 'GPM %',
          data: periods.map((p, i) => ({
            x: snapshotLabels[i],
            y: p.totalIncomeCr && p.cogsCr != null
              ? r2(((p.totalIncomeCr - p.cogsCr) / p.totalIncomeCr) * 100) : null,
          })),
        },
        {
          dataKey: 'opm',
          name: 'OPM %',
          data: periods.map((p, i) => ({
            x: snapshotLabels[i],
            y: p.totalIncomeCr && p.totalExpCr != null
              ? r2(((p.totalIncomeCr - p.totalExpCr) / p.totalIncomeCr) * 100) : null,
          })),
        },
        {
          dataKey: 'npm',
          name: 'NPM %',
          data: periods.map((p, i) => ({
            x: snapshotLabels[i],
            y: p.totalIncomeCr && p.netProfitCr != null
              ? r2((p.netProfitCr / p.totalIncomeCr) * 100) : null,
          })),
        },
      ],
    };

    // ── 4. EV / EBITDA (EV / PBDITA) group ───────────────────────────────────
    // Bar: Enterprise Value (Cr) — price-derived, varies per trading day snapshot.
    // Line: EV/PBDITA (price-derived) + Median EV multiple (flat reference line).
    const evEbitdaValues = periods.map((p) => p.evPbdita).filter((v) => v != null).sort((a, b) => a - b);
    let MEDIAN_EV_EBITDA = null;
    if (evEbitdaValues.length > 0) {
      const mid = Math.floor(evEbitdaValues.length / 2);
      MEDIAN_EV_EBITDA = evEbitdaValues.length % 2 === 0
        ? r2((evEbitdaValues[mid - 1] + evEbitdaValues[mid]) / 2)
        : r2(evEbitdaValues[mid]);
    }
    const evEbitdaGroup = {
      group: 'EV / EBITDA',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'ev',
          name: 'Enterprise Value (Cr)',
          data: periods.map((p, i) => ({ x: snapshotLabels[i], y: r2(p.ev) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'evToEbitda',
          name: 'EV / PBDITA',
          data: periods.map((p, i) => ({ x: snapshotLabels[i], y: r2(p.evPbdita) })),
        },
        {
          dataKey: 'medianEvMultiple',
          name: `Median EV Multiple = ${MEDIAN_EV_EBITDA}`,
          data: periods.map((_, i) => ({ x: snapshotLabels[i], y: MEDIAN_EV_EBITDA })),
        },
      ],
    };

    // ── 5. Price to Book group ────────────────────────────────────────────────
    // Bar: Stock Price (₹) = MarketCap × 1e7 / Shares — price-derived, varies per snapshot.
    // Line: P/B ratio (price-derived) + Median PBV (flat reference line).
    const pbValues = periods.map((p) => p.pb).filter((v) => v != null).sort((a, b) => a - b);
    let MEDIAN_PBV = null;
    if (pbValues.length > 0) {
      const mid = Math.floor(pbValues.length / 2);
      MEDIAN_PBV = pbValues.length % 2 === 0
        ? r2((pbValues[mid - 1] + pbValues[mid]) / 2)
        : r2(pbValues[mid]);
    }
    const priceToBookGroup = {
      group: 'Price to Book',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'pricePerShare',
          name: 'Stock Price (₹)',
          data: periods.map((p, i) => ({
            x: snapshotLabels[i],
            y: p.marketCapCr != null && p.shares != null && p.shares > 0
              ? r2((p.marketCapCr * 1e7) / p.shares)
              : null,
          })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'priceToBV',
          name: 'Price to BV',
          data: periods.map((p, i) => ({ x: snapshotLabels[i], y: r2(p.pb) })),
        },
        {
          dataKey: 'medianPBV',
          name: `Median PBV = ${MEDIAN_PBV}`,
          data: periods.map((_, i) => ({ x: snapshotLabels[i], y: MEDIAN_PBV })),
        },
      ],
    };

    // ── 6. Market Cap / Sales group ───────────────────────────────────────────
    // Bar: Market Cap (Cr) — price-derived, varies per trading day snapshot.
    // Line: MC / TTM Sales — MarketCap varies per snapshot; TTM Sales = latest quarter × 4.
    // TTM Sales proxy = latest period's TotalIncome × 4 (annualised from single quarter).
    // Note: Quarter Sales (TotalIncome) is a quarterly fundamental — same across all 12 snapshots,
    //   so it is NOT used as the bar. Market Cap is used instead as it is price-derived.
    const latestTotalIncomeCr = periods[PERIOD_COUNT - 1].totalIncomeCr;
    const ttmSalesCr = latestTotalIncomeCr != null ? latestTotalIncomeCr * 4 : null;
    const mcSalesValues = periods
      .map((p) => (p.marketCapCr != null && ttmSalesCr ? r2(p.marketCapCr / ttmSalesCr) : null))
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    let MEDIAN_MC_SALES = null;
    if (mcSalesValues.length > 0) {
      const mid = Math.floor(mcSalesValues.length / 2);
      MEDIAN_MC_SALES = mcSalesValues.length % 2 === 0
        ? r2((mcSalesValues[mid - 1] + mcSalesValues[mid]) / 2)
        : r2(mcSalesValues[mid]);
    }

    const mcSalesGroup = {
      group: 'Market Cap / Sales',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'marketCap',
          name: 'Market Cap (Cr)',
          data: periods.map((p, i) => ({ x: snapshotLabels[i], y: r2(p.marketCapCr) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'mcToSales',
          name: 'Market Cap / Sales',
          data: periods.map((p, i) => {
            const ratio = p.marketCapCr != null && ttmSalesCr
              ? r2(p.marketCapCr / ttmSalesCr)
              : null;
            return { x: snapshotLabels[i], y: ratio };
          }),
        },
        {
          dataKey: 'medianMcToSales',
          name: `Median Market Cap to Sales = ${MEDIAN_MC_SALES}`,
          data: periods.map((_, i) => ({ x: snapshotLabels[i], y: MEDIAN_MC_SALES })),
        },
      ],
    };

    res.json({
      company: companyName,
      symbol,
      quarter: quarterLabel,
      chartGroups: [
        priceGroup,
        peGroup,
        salesMarginGroup,
        evEbitdaGroup,
        priceToBookGroup,
        mcSalesGroup,
      ],
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getCharts };
