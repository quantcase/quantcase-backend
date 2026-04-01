'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
const YahooFinance = require('yahoo-finance2').default;

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── CSV structure notes ────────────────────────────────────────────────────────
// osc_identity.csv     : "Company Name" ↔ "NSE symbol" mapping (row 0 = header)
// osc_fundamental_ind_qtr.csv : company rows (row 6+), 12 period blocks of 18 cols
//   Col 0 = Company Name; periods L-11 … L, each starting at col 1 + period_index*18
//   Within each period block (0-based offset):
//     0  Date                    (DD-MM-YYYY)
//     1  Shares Outstanding      (units)
//     2  Market Capitalisation   (Rs. Crore)
//     3  Total Returns (%)
//     4  Adjusted EPS            (annualised TTM)
//     5  Adjusted Cash EPS
//     6  P/E
//     7  P/B
//     8  Book Value per Share    (₹)
//     9  Yield
//    10  Enterprise value        (Rs. Crore)
//    11  Market Capitalisation / Enterprise Value
//    12  Enterprise Value / PBDITA
//    13  Cost of goods sold      (Rs. Crore)
//    14  Total income from continuing operations  (Rs. Crore)
//    15  Total expenses          (Rs. Crore)
//    16  Net Profit              (Rs. Crore)
//    17  Earnings per share before extraordinary item  (₹)
//
// Fundamentals (cols 13-17) are the same across all 12 periods — single-quarter snapshot.
// Price-derived fields (cols 2,4-12) vary daily across the 12 trading days.

const COLS_PER_PERIOD = 18;
const PERIOD_COUNT = 12; // L-11 … L

const OFF = {
  DATE: 0,
  SHARES: 1,
  MARKET_CAP: 2,
  ADJ_EPS: 4,
  PE: 6,
  PB: 7,
  BVPS: 8,
  EV: 10,
  EV_PBDITA: 12,
  COGS: 13,
  TOTAL_INCOME: 14,
  TOTAL_EXPENSES: 15,
  NET_PROFIT: 16,
  EPS_BASIC: 17,
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
    path.join(__dirname, '../lib/osc_fundamental_ind_qtr.csv'),
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
 * Derive quarter labels (Mon-YY format) for the 12 periods, anchored to the
 * latest nse_date in the company row. Indian quarters end in Mar/Jun/Sep/Dec.
 * L = latest quarter, L-1 = previous, etc.
 */
function deriveQuarterLabels(companyRow) {
  // Parse latest period's date (DD-MM-YYYY) to find its quarter-end month
  const latestDateStr = companyRow[1 + (PERIOD_COUNT - 1) * COLS_PER_PERIOD];
  const parts = (latestDateStr || '').split('-');
  let anchorYear = new Date().getFullYear();
  let anchorMonth = new Date().getMonth(); // 0-based

  if (parts.length === 3) {
    const [, mm, yyyy] = parts;
    anchorMonth = parseInt(mm, 10) - 1; // 0-based
    anchorYear = parseInt(yyyy, 10);
  }

  // Snap to nearest Indian quarter-end month: Mar(2), Jun(5), Sep(8), Dec(11)
  const quarterEndMonths = [2, 5, 8, 11];
  const snapToQEnd = (month) => quarterEndMonths.reduce((prev, cur) =>
    Math.abs(cur - month) < Math.abs(prev - month) ? cur : prev
  );

  let qMonth = snapToQEnd(anchorMonth);
  let qYear = anchorYear;
  // If snapped month is ahead of anchor, step back one quarter
  if (qMonth > anchorMonth) {
    qMonth -= 3;
    if (qMonth < 0) { qMonth += 12; qYear -= 1; }
  }

  const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const labels = [];
  for (let i = PERIOD_COUNT - 1; i >= 0; i--) {
    labels[i] = `${monthShort[qMonth]}-${String(qYear).slice(2)}`;
    qMonth -= 3;
    if (qMonth < 0) { qMonth += 12; qYear -= 1; }
  }
  return labels;
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
    date: row[start + OFF.DATE] || null,
    shares: toFloat(row[start + OFF.SHARES]),
    marketCapCr: toFloat(row[start + OFF.MARKET_CAP]),
    adjEps: toFloat(row[start + OFF.ADJ_EPS]),
    pe: toFloat(row[start + OFF.PE]),
    pb: toFloat(row[start + OFF.PB]),
    bvps: toFloat(row[start + OFF.BVPS]),
    ev: toFloat(row[start + OFF.EV]),
    evPbdita: toFloat(row[start + OFF.EV_PBDITA]),
    cogsCr: toFloat(row[start + OFF.COGS]),
    totalIncomeCr: toFloat(row[start + OFF.TOTAL_INCOME]),
    totalExpCr: toFloat(row[start + OFF.TOTAL_EXPENSES]),
    netProfitCr: toFloat(row[start + OFF.NET_PROFIT]),
    epsBasic: toFloat(row[start + OFF.EPS_BASIC]),
  };
}


// ── Controller ────────────────────────────────────────────────────────────────

/**
 * GET /api/prowess/:symbol/charts
 *
 * Chart groups:
 *   1. Price          — yfinance monthly (10 years)
 *   2. PE Ratio       — Prowess PE series (12 trading days) + Median PE (DB)
 *   3. Sales & Margin — Prowess single-quarter fundamentals + derived margins
 *   4. EV / EBITDA    — Prowess EV/PBDITA series (12 trading days)
 *   5. Price to Book  — Prowess P/B series (12 trading days)
 *   6. Market Cap / Sales — Prowess MC/TTM Sales (12 trading days)
 *
 * Groups 2-6: bar series = 12-period values; line series = 12-period trend.
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

    // ── Extract all 12 periods (oldest → newest) ──────────────────────────────
    const periods = Array.from({ length: PERIOD_COUNT }, (_, i) => periodData(companyRow, i));
    const dailyLabels = deriveQuarterLabels(companyRow);

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

    // ── Median PE from CSV periods ────────────────────────────────────────────
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
    // Bar: Adjusted EPS (TTM-annualised, single latest value).
    // Line: PE (daily, 12 points) + Median PE (flat).
    const peGroup = {
      group: 'PE Ratio',
      source: 'prowess',
      barSeries: [
        {
          dataKey: 'ttmEps',
          name: 'Adj. EPS (TTM)',
          data: periods.map((p, i) => ({ x: dailyLabels[i], y: r2(p.adjEps) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'pe',
          name: 'PE',
          data: periods.map((p, i) => ({ x: dailyLabels[i], y: r2(p.pe) })),
        },
        {
          dataKey: 'medianPe',
          name: 'Median PE',
          data: periods.map((_, i) => ({ x: dailyLabels[i], y: medianPe })),
        },
      ],
    };

    // ── 3. Sales & Margin group ───────────────────────────────────────────────
    // Bar: Total Income (Cr) per period. Lines: OPM%, GPM%, NPM% per period.
    //   OPM% = (TotalIncome - TotalExpenses) / TotalIncome * 100
    //   GPM% = (TotalIncome - COGS) / TotalIncome * 100
    //   NPM% = NetProfit / TotalIncome * 100
    const salesMarginGroup = {
      group: 'Sales & Margin',
      source: 'prowess',
      barSeries: [
        {
          dataKey: 'quarterSales',
          name: 'Quarter Sales',
          data: periods.map((p, i) => ({ x: dailyLabels[i], y: r2(p.totalIncomeCr) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'gpm',
          name: 'GPM %',
          data: periods.map((p, i) => ({
            x: dailyLabels[i],
            y: p.totalIncomeCr && p.cogsCr != null
              ? r2(((p.totalIncomeCr - p.cogsCr) / p.totalIncomeCr) * 100) : null,
          })),
        },
        {
          dataKey: 'opm',
          name: 'OPM %',
          data: periods.map((p, i) => ({
            x: dailyLabels[i],
            y: p.totalIncomeCr && p.totalExpCr != null
              ? r2(((p.totalIncomeCr - p.totalExpCr) / p.totalIncomeCr) * 100) : null,
          })),
        },
        {
          dataKey: 'npm',
          name: 'NPM %',
          data: periods.map((p, i) => ({
            x: dailyLabels[i],
            y: p.totalIncomeCr && p.netProfitCr != null
              ? r2((p.netProfitCr / p.totalIncomeCr) * 100) : null,
          })),
        },
      ],
    };

    // ── 4. EV / EBITDA (EV / PBDITA) group ───────────────────────────────────
    // Prowess computes EV/PBDITA directly (PBDITA ≈ EBITDA for Indian companies).
    // Bar: Enterprise Value (Cr) at latest date.
    // Line: EV/PBDITA (daily, 12 points) + median.
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
      barSeries: [
        {
          dataKey: 'ev',
          name: 'Enterprise Value (Cr)',
          data: periods.map((p, i) => ({ x: dailyLabels[i], y: r2(p.ev) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'evToEbitda',
          name: 'EV / PBDITA',
          data: periods.map((p, i) => ({ x: dailyLabels[i], y: r2(p.evPbdita) })),
        },
        {
          dataKey: 'medianEvMultiple',
          name: `Median EV Multiple = ${MEDIAN_EV_EBITDA}`,
          data: periods.map((_, i) => ({ x: dailyLabels[i], y: MEDIAN_EV_EBITDA })),
        },
      ],
    };

    // ── 5. Price to Book group ────────────────────────────────────────────────
    // Prowess provides BVPS (fixed per quarter) and P/B (varies daily).
    // Bar: BVPS at latest date. Line: P/B (daily, 12 points) + median.
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
      barSeries: [
        {
          dataKey: 'bookValue',
          name: 'Book Value per Share (₹)',
          data: periods.map((p, i) => ({ x: dailyLabels[i], y: r2(p.bvps) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'priceToBV',
          name: 'Price to BV',
          data: periods.map((p, i) => ({ x: dailyLabels[i], y: r2(p.pb) })),
        },
        {
          dataKey: 'medianPBV',
          name: `Median PBV = ${MEDIAN_PBV}`,
          data: periods.map((_, i) => ({ x: dailyLabels[i], y: MEDIAN_PBV })),
        },
      ],
    };

    // ── 6. Market Cap / Sales group ───────────────────────────────────────────
    // MarketCap varies daily; TotalIncome (quarterly) is fixed.
    // TTM Sales proxy = TotalIncome × 4 (annualised from single quarter).
    // Bar: Quarter Sales (Cr). Line: MC / TTM Sales (daily, 12 points) + median.
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
      barSeries: [
        {
          dataKey: 'sales',
          name: 'Sales (Cr)',
          data: periods.map((p, i) => ({ x: dailyLabels[i], y: r2(p.totalIncomeCr) })),
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
            return { x: dailyLabels[i], y: ratio };
          }),
        },
        {
          dataKey: 'medianMcToSales',
          name: `Median Market Cap to Sales = ${MEDIAN_MC_SALES}`,
          data: periods.map((_, i) => ({ x: dailyLabels[i], y: MEDIAN_MC_SALES })),
        },
      ],
    };

    res.json({
      company: companyName,
      symbol,
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
