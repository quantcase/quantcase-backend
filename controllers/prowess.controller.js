'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
const YahooFinance = require('yahoo-finance2').default;

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── CSV: osc_fundamental_ind_qtr_v4.csv ──────────────────────────────────────
// Rows 0–4 : header block (source, exchange, finance type, units, quarter labels)
// Row 5    : indicator names (repeating every 20 cols)
// Row 6+   : company data; col 0 = Company Name
//
// Layout   : 8 quarters × 20 indicators = 160 data cols (cols 1–160)
// Quarters : Mar 2024 → Jun 2024 → Sep 2024 → Dec 2024 →
//            Mar 2025 → Jun 2025 → Sep 2025 → Dec 2025  (oldest → latest)
// Quarter labels are in row 4 directly — no back-calculation needed.
//
// Per-quarter indicator offsets (0-based within each 20-col block):
//   0  Shares Outstanding
//   1  Market Capitalisation         (Rs. Crore)
//   2  Total Returns (%)
//   3  Adjusted EPS
//   4  Adjusted Cash EPS
//   5  P/E (Price to Earnings Ratio)
//   6  P/B (Price to Book Value Ratio)
//   7  Book Value per Share          (Indian Rupee)
//   8  Yield
//   9  Enterprise value              (Rs. Crore)
//  10  Market Capitalisation / Enterprise Value
//  11  Enterprise Value / PBDITA
//  12  Cost of goods sold            (Rs. Crore)
//  13  Total income from continuing operations (Rs. Crore)
//  14  Total expenses                (Rs. Crore)
//  15  Net Profit                    (Rs. Crore)
//  16  Earnings per share before extraordinary item (₹)
//  17  Months
//  18  Source
//  19  Date signed

const COLS_PER_PERIOD = 20;
const PERIOD_COUNT = 8;

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
  NTRM_MONTHS: 17,
  NTRM_SOURCE: 18,
  NTRM_DATE_SIGNED: 19,
};

// ── Lazy-loaded data ──────────────────────────────────────────────────────────

let _identityMap = null;
let _fundamentalData = null; // { quarterLabels: string[], companyMap: { [name]: row } }

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

function loadFundamentalData() {
  if (_fundamentalData) return _fundamentalData;
  const raw = fs.readFileSync(
    path.join(__dirname, '../lib/osc_fundamental_ind_qtr_v4.csv'),
    'utf-8'
  );
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const allRows = csvParse.parse(content, { relax_column_count: true });

  // Row 4 contains quarter labels (e.g. "Mar 2024"), one per col per period
  const quarterRow = allRows[4];
  const quarterLabels = [];
  for (let i = 0; i < PERIOD_COUNT; i++) {
    quarterLabels.push(quarterRow[1 + i * COLS_PER_PERIOD] || `Q${i + 1}`);
  }

  const companyMap = {};
  for (const row of allRows.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) companyMap[name] = row;
  }

  _fundamentalData = { quarterLabels, companyMap };
  return _fundamentalData;
}

/** Resolve NSE symbol → company row, returns null if not found */
function findCompanyRow(symbol) {
  const identityMap = loadIdentityMap();
  const { companyMap } = loadFundamentalData();
  const companyName = identityMap[symbol.toUpperCase()];
  if (!companyName) return null;
  return companyMap[companyName] ?? null;
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

/** Extract one period's data from a company row (periodIndex: 0 = oldest, 7 = latest) */
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
 *   2. PE Ratio       — bar=Earnings Yield %, line=PE + Median PE
 *   3. Sales & Margin — bar=Quarter Sales (Cr), lines=GPM%/OPM%/NPM%
 *   4. EV / EBITDA    — bar=EV (Cr), line=EV/PBDITA + Median
 *   5. Price to Book  — bar=Stock Price (₹), line=P/B + Median PBV
 *   6. Market Cap / Sales — bar=Market Cap (Cr), line=MC/TTM Sales + Median
 */
async function getCharts(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const ticker = symbol + '.NS';

    const companyRow = findCompanyRow(symbol);
    if (!companyRow) {
      return res.status(404).json({
        error: `Symbol "${symbol}" not found in Prowess identity mapping or fundamentals data.`,
      });
    }
    const companyName = companyRow[0];

    const { quarterLabels } = loadFundamentalData();
    const periods = Array.from({ length: PERIOD_COUNT }, (_, i) => periodData(companyRow, i));
    const quarterLabel = quarterLabels[PERIOD_COUNT - 1];

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

    // ── 2. PE Ratio group ─────────────────────────────────────────────────────
    const peValues = periods.map((p) => p.pe).filter((v) => v != null).sort((a, b) => a - b);
    let medianPe = null;
    if (peValues.length > 0) {
      const mid = Math.floor(peValues.length / 2);
      medianPe = peValues.length % 2 === 0
        ? r2((peValues[mid - 1] + peValues[mid]) / 2)
        : r2(peValues[mid]);
    }

    const peGroup = {
      group: 'PE Ratio',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'earningsYield',
          name: 'Earnings Yield %',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.pe != null && p.pe !== 0 ? r2((1 / p.pe) * 100) : null,
          })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'pe',
          name: 'PE',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.pe) })),
        },
        {
          dataKey: 'medianPe',
          name: 'Median PE',
          data: periods.map((_, i) => ({ x: quarterLabels[i], y: medianPe })),
        },
      ],
    };

    // ── 3. Sales & Margin group ───────────────────────────────────────────────
    const salesMarginGroup = {
      group: 'Sales & Margin',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'quarterSales',
          name: 'Quarter Sales (Cr)',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.totalIncomeCr) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'gpm',
          name: 'GPM %',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.totalIncomeCr && p.cogsCr != null
              ? r2(((p.totalIncomeCr - p.cogsCr) / p.totalIncomeCr) * 100) : null,
          })),
        },
        {
          dataKey: 'opm',
          name: 'OPM %',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.totalIncomeCr && p.totalExpCr != null
              ? r2(((p.totalIncomeCr - p.totalExpCr) / p.totalIncomeCr) * 100) : null,
          })),
        },
        {
          dataKey: 'npm',
          name: 'NPM %',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.totalIncomeCr && p.netProfitCr != null
              ? r2((p.netProfitCr / p.totalIncomeCr) * 100) : null,
          })),
        },
      ],
    };

    // ── 4. EV / EBITDA group ──────────────────────────────────────────────────
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
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.ev) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'evToEbitda',
          name: 'EV / PBDITA',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.evPbdita) })),
        },
        {
          dataKey: 'medianEvMultiple',
          name: `Median EV Multiple = ${MEDIAN_EV_EBITDA}`,
          data: periods.map((_, i) => ({ x: quarterLabels[i], y: MEDIAN_EV_EBITDA })),
        },
      ],
    };

    // ── 5. Price to Book group ────────────────────────────────────────────────
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
            x: quarterLabels[i],
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
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.pb) })),
        },
        {
          dataKey: 'medianPBV',
          name: `Median PBV = ${MEDIAN_PBV}`,
          data: periods.map((_, i) => ({ x: quarterLabels[i], y: MEDIAN_PBV })),
        },
      ],
    };

    // ── 6. Market Cap / Sales group ───────────────────────────────────────────
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
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.marketCapCr) })),
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
            return { x: quarterLabels[i], y: ratio };
          }),
        },
        {
          dataKey: 'medianMcToSales',
          name: `Median Market Cap to Sales = ${MEDIAN_MC_SALES}`,
          data: periods.map((_, i) => ({ x: quarterLabels[i], y: MEDIAN_MC_SALES })),
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
