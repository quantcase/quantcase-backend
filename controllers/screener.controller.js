'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
const technicalAnalysis = require('../lib/technicalAnalysis');
const financials = require('../lib/financials');
const { generateDecisionIntelligence } = require('../utils/decisionIntelligence');
const { fundamentalsIntelligencePrompt } = require('../prompts/fundamentals_intelligence');
const { loadSkillConfig } = require('../utils/skillConfig');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { resolveMetric, resolveIndicatorSeries } = require('../utils/formulaRegistry/index');
const prisma = require('../config/prisma');

// ── Peer comparison helpers (reuse Prowess CSV data) ────────────────────────

const peerIdentity = require('../lib/peerIdentity');

// Identity CSV column indices (0-based) — kept for local peer-table lookups
const ID_COL_NAME          = peerIdentity.COL_NAME;
const ID_COL_INDUSTRY_GRP  = peerIdentity.COL_INDUSTRY_GRP;
const ID_COL_NSE_BASIC_IND = peerIdentity.COL_NSE_BASIC_IND;
const ID_COL_NSE_SYMBOL    = peerIdentity.COL_NSE_SYMBOL;

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

let _peerFundMap         = null; // { companyName: row[] }
let _peerFundQtrs        = null; // string[]
let _modMap              = null; // { companyName: row[] } from osc_mod_qtr_v1.csv
let _shareholdingMap     = null; // { companyName: row[] } from osc_shareholding_qtr_v1.csv
let _shareholdingPeriods = null; // number of periods in shareholding CSV
const SH_COLS_PER_PERIOD = 35;
const SH_OFF = { PROMOTER: 1, NON_PROMOTER: 15, MF_DII: 17, FII: 22, PUBLIC_NON_INST: 27 };

function loadPeerIdentity() {
  return peerIdentity.load();
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

function loadShareholding() {
  if (_shareholdingMap) return { shMap: _shareholdingMap, periods: _shareholdingPeriods };
  const raw = fs.readFileSync(path.join(__dirname, '../lib/osc_shareholding_qtr_v1.csv'), 'utf-8');
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const all = csvParse.parse(content, { relax_column_count: true });
  const maxCols = Math.max(...all.slice(6, 16).map((r) => r.length));
  _shareholdingPeriods = Math.floor((maxCols - 1) / SH_COLS_PER_PERIOD);
  _shareholdingMap = {};
  for (const row of all.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) _shareholdingMap[name] = row;
  }
  return { shMap: _shareholdingMap, periods: _shareholdingPeriods };
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
    const companyName       = idRow ? (idRow[ID_COL_NAME] || '').trim() : null;
    const industryGroup     = idRow ? (idRow[ID_COL_INDUSTRY_GRP] || '').trim() : null;
    const basicIndustry     = idRow ? (idRow[ID_COL_NSE_BASIC_IND] || '').trim() : null;

    // BFSI flag — drives label and column visibility decisions passed to the frontend
    const BFSI_INDUSTRY_KEYWORDS = ['bank', 'insurance', 'nbfc', 'financial services', 'microfinance', 'housing finance'];
    const isBfsi = BFSI_INDUSTRY_KEYWORDS.some(
      (kw) => (industryGroup || '').toLowerCase().includes(kw) ||
               (basicIndustry || '').toLowerCase().includes(kw)
    );
    const description       = idRow ? (idRow[8]  || '').trim() || null : null;
    const website           = idRow ? (idRow[50] || '').trim() || null : null;
    const isin              = idRow ? (idRow[21] || '').trim() || null : null;
    const cin               = idRow ? (idRow[4]  || '').trim() || null : null;
    const incorporationYear = idRow ? (idRow[6]  || '').trim() || null : null;
    const ownershipGroup    = idRow ? (idRow[17] || '').trim() || null : null;
    const mainProduct       = idRow ? (idRow[12] || '').trim() || null : null;
    const listingDate       = idRow ? (idRow[26] || '').trim() || null : null;
    const email             = idRow ? (idRow[44] || '').trim() || null : null;
    const bseCode           = idRow ? (idRow[33] || '').trim() || null : null;

    // dividendYield from osc_fundamental_ind_qtr_v4.csv (PEER_OFF.YIELD = offset 8, latest period)
    const { fundMap: _fundMapForYield } = loadPeerFundamentals();
    const _fundRowForYield = companyName ? (_fundMapForYield[companyName] || null) : null;
    const dividendYield = _fundRowForYield
      ? r2(peerPeriodVal(_fundRowForYield, PEER_PERIOD_COUNT - 1, PEER_OFF.YIELD))
      : null;
    const epsForward    = null;

    // ── 2. Price data from nse_equity ──────────────────────────────────────
    const oneYearAgo   = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const fiftyDaysAgo = new Date(Date.now() -  50 * 24 * 60 * 60 * 1000);
    const twohundDaysAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

    const [latestPriceRows, yearPriceRows, mktCapRows, peRows, annualRows, quarterlyRows, priceAvgRows, priceYearAgoRows] = await Promise.all([
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
      // Annual KPI values — audited full-year figures for ratios, YoY, balance sheet
      companyName
        ? prisma.$queryRaw`
            SELECT kpi_abbr, value, raw_value, unit, multiplier, fiscal_year, quarter, period_type
            FROM prowess_values_new
            WHERE company = ${companyName}
              AND call_id LIKE 'prowess_new_%'
            ORDER BY fiscal_year DESC, quarter DESC, source_type ASC
          `
        : Promise.resolve([]),
      // Quarterly KPI values — P&L (period_type='quarterly') + balance sheet snapshots ('snapshot')
      companyName
        ? prisma.$queryRaw`
            SELECT kpi_abbr, value, raw_value, unit, multiplier, fiscal_year, quarter
            FROM prowess_values_new
            WHERE company = ${companyName}
              AND call_id LIKE 'prowess_qtr_%'
              AND period_type IN ('quarterly', 'snapshot')
            ORDER BY fiscal_year ASC, quarter ASC
          `
        : Promise.resolve([]),
      // 50d and 200d averages
      prisma.$queryRaw`
        SELECT
          AVG(close::numeric) FILTER (WHERE datetime >= ${fiftyDaysAgo})    AS avg50,
          AVG(close::numeric) FILTER (WHERE datetime >= ${twohundDaysAgo})  AS avg200
        FROM nse_equity WHERE symbol = ${sym}
      `,
      // Price ~1 year ago for 52W change
      prisma.$queryRaw`
        SELECT close FROM nse_equity
        WHERE symbol = ${sym} AND datetime <= ${oneYearAgo}
        ORDER BY datetime DESC LIMIT 1
      `,
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

    const avgRow = priceAvgRows[0] ?? null;
    const fiftyDayAverage      = avgRow?.avg50  != null ? r2(parseFloat(avgRow.avg50))  : null;
    const twoHundredDayAverage = avgRow?.avg200 != null ? r2(parseFloat(avgRow.avg200)) : null;

    const priceYearAgoVal = priceYearAgoRows[0]?.close != null ? parseFloat(priceYearAgoRows[0].close) : null;
    const week52Change = price != null && priceYearAgoVal != null && priceYearAgoVal !== 0
      ? r2((price - priceYearAgoVal) / Math.abs(priceYearAgoVal))
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

    // ── 6. KPI helpers — built from annual (audited) rows only ─────────────
    // Pick latest consolidated value per abbr (ORDER BY ensures C before S for same period)
    const kpiMap = {};
    for (const row of annualRows) {
      const abbr = row.kpi_abbr;
      if (!kpiMap[abbr]) kpiMap[abbr] = row;
    }

    // All annual values per abbr for YoY and multi-year calculations
    const kpiByPeriod = {};
    for (const row of annualRows) {
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

    // ── 7b. Quarterly trend — built from standalone quarterly rows ──────────
    const TREND_ABBRS = new Set([
      'REV_OP', 'TOTAL_INCOME', 'PAT', 'EPS_BASIC', 'CFO',
      // EBITDA components (full formula path: PBT+FIN_COST+DEP_AMORT)
      // fallback path when PBT absent: (REV_OP - TOTAL_OPEX) + DEP_AMORT
      'PBT', 'FIN_COST', 'DEP_AMORT', 'TOTAL_OPEX',
      // cfoProxy add-backs (non-cash items available every quarter)
      'PROV_CONT',
      // Balance sheet — debt
      'BORR_TOTAL', 'DEBT_LT', 'DEBT_ST', 'NET_WORTH',
      // Balance sheet — equity approximation components (available at H1/H2 snapshots)
      'CURR_ASSETS', 'ASSET_PPE', 'ASSET_CWIP', 'OTH_ASSET_NC',
      'CURR_LIAB', 'PROV_LT', 'PROV_ST',
      // BFSI equity components (available every quarter for insurance/banks)
      'EQ_SHARE_CAP', 'RES_SURPLUS',
      // Interest coverage components
      'IC',
    ]);
    const trendPeriods = {};
    for (const row of quarterlyRows) {
      if (!TREND_ABBRS.has(row.kpi_abbr)) continue;
      const key = `${row.fiscal_year}|${row.quarter}`;
      if (!trendPeriods[key]) trendPeriods[key] = { fiscal_year: row.fiscal_year, quarter: row.quarter };
      trendPeriods[key][row.kpi_abbr] = row.value != null ? parseFloat(row.value) : null;
    }
    const quarterlyTrend = Object.values(trendPeriods)
      .sort((a, b) => {
        if (a.fiscal_year !== b.fiscal_year) return (a.fiscal_year ?? '').localeCompare(b.fiscal_year ?? '');
        return (a.quarter ?? '').localeCompare(b.quarter ?? '');
      })
      .map((p) => {
        // EBITDA: try registry formula (PBT+FIN_COST+DEP_AMORT); fall back to
        // (REV_OP - TOTAL_OPEX) + DEP_AMORT when quarterly data lacks PBT
        let ebitdaVal = resolveMetric('EBITDA', { kpiMap: p }).value;
        if (ebitdaVal == null && p.REV_OP != null && p.TOTAL_OPEX != null) {
          const opProfit = p.REV_OP - p.TOTAL_OPEX;
          ebitdaVal = opProfit + (p.DEP_AMORT ?? 0);
        }
        ebitdaVal = r2(ebitdaVal);

        const totalDebtVal = p.BORR_TOTAL ?? ((p.DEBT_LT != null || p.DEBT_ST != null)
          ? (p.DEBT_LT ?? 0) + (p.DEBT_ST ?? 0) : null);
        // totalEquity:
        //   1. Stored NET_WORTH (rarely present quarterly)
        //   2. BFSI: EQ_SHARE_CAP + RES_SURPLUS — exact book value, available every quarter
        //   3. Non-BFSI H1/H2 snapshots: Assets − Liabilities approximation
        let totalEquityVal = p.NET_WORTH ?? null;
        if (totalEquityVal == null && p.EQ_SHARE_CAP != null && p.RES_SURPLUS != null) {
          totalEquityVal = p.EQ_SHARE_CAP + p.RES_SURPLUS;
        }
        if (totalEquityVal == null &&
            p.CURR_ASSETS != null && p.CURR_LIAB != null && p.BORR_TOTAL != null) {
          const assets = p.CURR_ASSETS + (p.ASSET_PPE ?? 0) + (p.ASSET_CWIP ?? 0) + (p.OTH_ASSET_NC ?? 0);
          const liabs  = p.CURR_LIAB + p.BORR_TOTAL + (p.PROV_LT ?? 0) + (p.PROV_ST ?? 0);
          totalEquityVal = assets - liabs;
        }

        // Interest coverage: stored IC → (PBT+FIN_COST)/FIN_COST → EBITDA/FIN_COST
        // Null for BFSI (no FIN_COST field — interest is operating revenue for them)
        let icVal = p.IC ?? null;
        if (icVal == null && p.FIN_COST != null && p.FIN_COST !== 0) {
          if (p.PBT != null) {
            icVal = (p.PBT + p.FIN_COST) / p.FIN_COST;
          } else if (ebitdaVal != null) {
            icVal = ebitdaVal / p.FIN_COST;
          }
        }

        // cfoProxy (non-BFSI): PAT + DEP_AMORT + PROV_CONT — first two lines of indirect method.
        // Omits working capital changes so it overstates CFO in working-capital-intensive quarters;
        // use stored CFO when available (BFSI H1, or if data ever expands).
        const cfoVal = p.CFO ?? null;
        const cfoProxyVal = (cfoVal == null && p.PAT != null && p.DEP_AMORT != null)
          ? p.PAT + p.DEP_AMORT + (p.PROV_CONT ?? 0)
          : null;

        return {
          period:           `${p.quarter ?? ''} ${p.fiscal_year ?? ''}`.trim(),
          revenue:          p.REV_OP ?? p.TOTAL_INCOME ?? null,
          netIncome:        p.PAT ?? null,
          eps:              p.EPS_BASIC ?? null,
          cfo:              cfoVal,
          cfoProxy:         cfoProxyVal != null ? r2(cfoProxyVal) : null,
          cfoLabel:         cfoVal != null ? 'CFO' : (cfoProxyVal != null ? 'Est. CFO' : null),
          ebitda:           ebitdaVal,
          ebitdaLabel:      isBfsi ? 'Op. Profit' : 'EBITDA',
          totalDebt:        totalDebtVal != null ? r2(totalDebtVal) : null,
          totalEquity:      totalEquityVal != null ? r2(totalEquityVal) : null,
          interestCoverage: icVal != null ? r2(icVal) : null,
        };
      });

    // ── 7b-ii. Dividend yield + fundamentals trend from peer fund CSV ─────────
    const dividendYieldTrend = [];
    const fundamentalsTrend  = [];
    if (companyName) {
      const { fundMap: dyFundMap, qtrs: dyQtrs } = loadPeerFundamentals();
      const dyRow = dyFundMap[companyName];
      if (dyRow) {
        for (let i = 0; i < PEER_PERIOD_COUNT; i++) {
          const period = dyQtrs[i] ?? `Q${i + 1}`;
          dividendYieldTrend.push({ period, dividendYield: r2(peerPeriodVal(dyRow, i, PEER_OFF.YIELD)) });
          fundamentalsTrend.push({
            period,
            eps:          r2(peerPeriodVal(dyRow, i, PEER_OFF.ADJ_EPS)),
            pe:           r2(peerPeriodVal(dyRow, i, PEER_OFF.PE)),
            pb:           r2(peerPeriodVal(dyRow, i, PEER_OFF.PB)),
            bookValue:    r2(peerPeriodVal(dyRow, i, 7)),
            revenue:      r2(peerPeriodVal(dyRow, i, PEER_OFF.TOTAL_INCOME)),
            netProfit:    r2(peerPeriodVal(dyRow, i, PEER_OFF.NET_PROFIT)),
          });
        }
      }
    }

    // ── 7c. Registry-driven derived metrics ─────────────────────────────────
    // Build a flat numeric map from the latest period (prowess_values_new).
    const flatKpiMap = {};
    for (const [abbr, row] of Object.entries(kpiMap)) {
      if (row.value != null) flatKpiMap[abbr] = parseFloat(row.value);
    }
    if (flatKpiMap['BORR_TOTAL'] == null && (flatKpiMap['DEBT_LT'] != null || flatKpiMap['DEBT_ST'] != null)) {
      flatKpiMap['BORR_TOTAL'] = (flatKpiMap['DEBT_LT'] ?? 0) + (flatKpiMap['DEBT_ST'] ?? 0);
    }

    // Build prevKpiMap from the period immediately before the latest — needed for CAPEX
    // delta resolution (CAPEX = Δ gross PPE).  annualRows is ordered DESC so we just find
    // the first row whose fiscal_year+quarter differs from the latest.
    const latestFy  = annualRows[0]?.fiscal_year;
    const latestQtr = annualRows[0]?.quarter;
    let prevFy = null, prevQtr = null;
    for (const row of annualRows) {
      if (row.fiscal_year !== latestFy || row.quarter !== latestQtr) {
        prevFy = row.fiscal_year; prevQtr = row.quarter;
        break;
      }
    }
    const flatPrevKpiMap = {};
    if (prevFy != null) {
      const prevRawMap = {};
      for (const row of annualRows) {
        if (row.fiscal_year === prevFy && row.quarter === prevQtr && !prevRawMap[row.kpi_abbr]) {
          prevRawMap[row.kpi_abbr] = row; // first = consolidated (ORDER BY source_type ASC)
        }
      }
      for (const [abbr, row] of Object.entries(prevRawMap)) {
        if (row.value != null) flatPrevKpiMap[abbr] = parseFloat(row.value);
      }
      if (flatPrevKpiMap['BORR_TOTAL'] == null && (flatPrevKpiMap['DEBT_LT'] != null || flatPrevKpiMap['DEBT_ST'] != null)) {
        flatPrevKpiMap['BORR_TOTAL'] = (flatPrevKpiMap['DEBT_LT'] ?? 0) + (flatPrevKpiMap['DEBT_ST'] ?? 0);
      }
    }

    const _formulaUsed = {}; // provenance for admin endpoint — not in public response
    function rk(field, abbr, extra = {}) {
      const res = resolveMetric(abbr, { kpiMap: { ...flatKpiMap, ...extra }, prevKpiMap: flatPrevKpiMap });
      if (res.source !== 'stored') {
        _formulaUsed[field] = { source: res.source, formula: res.formula, inputs: res.inputs, inputValues: res.inputValues };
      }
      return res.value; // raw unrounded; callers apply r2()
    }

    const ebitdaRaw        = rk('ebitda',          'EBITDA');
    const roeRaw           = rk('returnOnEquity',   'ROE');
    const roaRaw           = rk('returnOnAssets',   'ROA');
    const roceRaw          = rk('roce',             'ROCE');
    const ebitdaMrgRaw     = rk('ebitdaMargins',    'EBITDA_MARGIN',  { EBITDA: ebitdaRaw });
    const profMrgRaw       = rk('profitMargins',    'PROFIT_MARGIN');
    const grossMrgRaw      = rk('grossMargins',     'GROSS_MARGIN');
    const opMrgRaw         = rk('operatingMargins', 'OP_MARGIN');
    const fcfRaw           = rk('freeCashflow',     'FCF');
    const currRatRaw       = rk('currentRatio',     'CURRENT_RATIO');
    const quickRatRaw      = rk('quickRatio',       'QUICK_RATIO');
    const netDebtRaw       = rk('netDebt',          'NET_DEBT');
    const netDebtEbRaw     = rk('netDebtEbitda',    'NET_DEBT_EBITDA', { NET_DEBT: netDebtRaw, EBITDA: ebitdaRaw });
    const deRaw            = rk('debtToEquity',     'DE');

    const ebitda           = r2(ebitdaRaw);
    const roe              = r2(roeRaw);
    const roa              = r2(roaRaw);
    const roce             = r2(roceRaw);
    const ebitdaMargins    = r2(ebitdaMrgRaw);
    const profitMargins    = r2(profMrgRaw);
    const grossMargins     = r2(grossMrgRaw);
    const operatingMargins = r2(opMrgRaw);
    const freeCashflow     = r2(fcfRaw);
    const currentRatio     = r2(currRatRaw);
    const quickRatio       = r2(quickRatRaw);
    const netDebt          = r2(netDebtRaw);
    const netDebtEbitda    = r2(netDebtEbRaw);

    // EV = marketCap + totalDebt - cash (requires market data — not in registry)
    const totalDebtAbs    = flatKpiMap['BORR_TOTAL'] ?? null;
    const cashEquivAbs    = flatKpiMap['CASH_EQUIV']  ?? null;
    const enterpriseValue = marketCapAbs != null
      ? r2(marketCapAbs + (totalDebtAbs ?? 0) - (cashEquivAbs ?? 0))
      : null;
    const evToEbitda = enterpriseValue != null && ebitda != null && ebitda !== 0
      ? r2(enterpriseValue / ebitda)
      : null;

    // ── 7d. Shareholding from osc_shareholding_qtr_v1.csv ───────────────────
    let shPromoter = null, shFii = null, shDii = null, shPublic = null, shInstitutions = null;
    if (companyName) {
      const { shMap, periods } = loadShareholding();
      const shRow = shMap[companyName];
      if (shRow) {
        for (let i = periods - 1; i >= 0; i--) {
          const base = 1 + i * SH_COLS_PER_PERIOD;
          const promoter = peerToFloat(shRow[base + SH_OFF.PROMOTER]);
          if (promoter != null) {
            shPromoter     = r2(promoter);
            shDii          = r2(peerToFloat(shRow[base + SH_OFF.MF_DII]));
            shFii          = r2(peerToFloat(shRow[base + SH_OFF.FII]));
            shPublic       = r2(peerToFloat(shRow[base + SH_OFF.PUBLIC_NON_INST]));
            shInstitutions = r2(peerToFloat(shRow[base + SH_OFF.NON_PROMOTER]));
            break;
          }
        }
      }
    }

    // ── 8. Market-data and per-share metrics (not in registry — need price/shares) ──
    const eqCapCr           = kpiValCr('EQ_SHARE_CAP'); // Cr
    const FACE_VALUE        = 10;
    const sharesOutstandingCount = eqCapCr != null ? Math.round((eqCapCr * 1e7) / FACE_VALUE) : null;

    const netWorthAbs    = kpiVal('NET_WORTH');
    const revAbsForMargin = kpiVal('REV_OP') ?? kpiVal('TOTAL_INCOME');
    const cfoAbs         = kpiVal('CFO');
    const epsBasic       = kpiVal('EPS_BASIC') ?? kpiVal('EPS_DILUTED');

    // gross profits absolute (used in response; margins already via registry)
    const grossProfits = flatKpiMap['TOTAL_INCOME'] != null && flatKpiMap['TOTAL_COGS'] != null
      ? r2(flatKpiMap['TOTAL_INCOME'] - flatKpiMap['TOTAL_COGS']) : null;

    const bookValue = netWorthAbs != null && sharesOutstandingCount != null && sharesOutstandingCount !== 0
      ? r2(netWorthAbs / sharesOutstandingCount) : null;

    const evToRevenue = enterpriseValue != null && revAbsForMargin != null && revAbsForMargin !== 0
      ? r2(enterpriseValue / revAbsForMargin) : null;

    const revenuePerShare = revAbsForMargin != null && sharesOutstandingCount != null && sharesOutstandingCount !== 0
      ? r2(revAbsForMargin / sharesOutstandingCount) : null;

    const totalCashPerShare = cashEquivAbs != null && sharesOutstandingCount != null && sharesOutstandingCount !== 0
      ? r2(cashEquivAbs / sharesOutstandingCount) : null;

    const cfoEbitdaPct = cfoAbs != null && ebitda != null && ebitda !== 0
      ? r2((cfoAbs / ebitda) * 100) : null;

    const forwardPE   = price != null && epsForward != null && epsForward !== 0
      ? r2(price / (epsForward * 4)) : null;
    const dividendRate = dividendYield != null && price != null
      ? r2((dividendYield / 100) * price) : null;
    const payoutRatio  = dividendRate != null && epsBasic != null && epsBasic !== 0
      ? r2((dividendRate / epsBasic) * 100) : null;

    const pbRatio = price != null && bookValue != null && bookValue !== 0
      ? r2(price / bookValue)
      : (marketCapAbs != null && netWorthAbs != null && netWorthAbs !== 0
          ? r2(marketCapAbs / netWorthAbs) : null);

    const ebitdaGrowth = kpiYoy('PBT');
    const fcfGrowth    = kpiYoy('CFO');

    // PEG ratio = trailingPE / EPS growth rate (%)
    // epsGrowthRate from kpiYoy is a fraction (e.g. 0.15 = 15%); multiply by 100 for PEG denominator
    const epsGrowthFraction = kpiYoy('EPS_BASIC');
    const pegRatio = trailingPE != null && epsGrowthFraction != null && epsGrowthFraction > 0
      ? r2(trailingPE / (epsGrowthFraction * 100))
      : null;

    // Interest coverage — prefer stored IC from Prowess; fallback: (PBT + FIN_COST) / FIN_COST
    const icStored    = kpiVal('IC');
    const finCostAbs  = kpiVal('FIN_COST');
    const pbtAbs      = kpiVal('PBT');
    const interestCoverage = icStored != null
      ? r2(icStored)
      : (finCostAbs != null && finCostAbs !== 0 && pbtAbs != null
          ? r2((pbtAbs + finCostAbs) / finCostAbs)
          : null);
    const interestCoverageGrowth = kpiYoy('IC');

    // EPS 3Y CAGR — route through registry (EPS_CAGR_3Y, window=3, annual ASC series)
    const epsSeriesAsc = [...(kpiByPeriod['EPS_BASIC'] ?? [])].reverse()
      .map((r) => ({ value: r.value != null ? parseFloat(r.value) : null, fiscal_year: r.fiscal_year, period: r.quarter }));
    const epsCagr3y = r2(resolveMetric('EPS_CAGR_3Y', { series: epsSeriesAsc }).value);

    function epsCagrLabel(cagr) {
      if (cagr == null) return null;
      if (cagr >= 20) return 'Excellent';
      if (cagr >= 12) return 'Good';
      if (cagr >= 5)  return 'Moderate';
      if (cagr >= 0)  return 'Weak';
      return 'Negative';
    }

    // ROCE 3Y avg — route through registry (ROCE_3Y_AVG, window=3, annual ASC series)
    const roceSeriesAsc = [...(kpiByPeriod['ROCE'] ?? [])].reverse()
      .map((r) => ({ value: r.value != null ? parseFloat(r.value) : null }));
    const roce3yAvg = r2(resolveMetric('ROCE_3Y_AVG', { series: roceSeriesAsc }).value);

    // ROE 3Y avg — build per-period ROE series (PAT/NET_WORTH), then route through registry
    const patPeriodMap = {}, nwPeriodMap = {};
    for (const r of (kpiByPeriod['PAT'] ?? [])) {
      const k = `${r.fiscal_year}|${r.quarter}`;
      if (!patPeriodMap[k]) patPeriodMap[k] = r.value != null ? parseFloat(r.value) : null;
    }
    for (const r of (kpiByPeriod['NET_WORTH'] ?? [])) {
      const k = `${r.fiscal_year}|${r.quarter}`;
      if (!nwPeriodMap[k]) nwPeriodMap[k] = r.value != null ? parseFloat(r.value) : null;
    }
    const roeSeriesAsc = Object.keys(patPeriodMap).filter((k) => k in nwPeriodMap).sort()
      .map((k) => {
        const pat = patPeriodMap[k], nw = nwPeriodMap[k];
        return { value: (pat != null && nw != null && nw !== 0) ? (pat / nw) * 100 : null };
      });
    const roe3yAvg = r2(resolveMetric('ROE_3Y_AVG', { series: roeSeriesAsc }).value);

    // PE valuation label based on trailing PE
    function peValuationLabel(pe) {
      if (pe == null) return null;
      if (pe < 10) return 'Undervalued';
      if (pe < 20) return 'Fair value';
      if (pe < 35) return 'Moderately valued';
      return 'Expensive';
    }

    // deRaw was resolved via registry (stored or computed); round for display
    const de = r2(deRaw);
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
        name:            companyName || sym,
        exchange:        'NSE',
        sector:          industryGroup  || null,
        industry:        basicIndustry  || null,
        isBfsi,
        mainProduct:     mainProduct,
        description,
        website,
        email,
        isin,
        cin,
        bseCode,
        incorporationYear,
        listingDate,
        ownershipGroup,
        employees:       null,
        country:         'India',
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
        grossProfits,
        grossMargins,
        ebitda,
        ebitdaGrowth,
        ebitdaMargins,
        operatingMargins,
        netProfit:        kpiVal('PAT'),
        netProfitGrowth:  kpiYoy('PAT'),
        profitMargins,
        operatingCashflow: kpiVal('CFO'),
        cfoGrowth:        kpiYoy('CFO'),
        freeCashflow,
        fcfGrowth,
        earningsGrowth:   kpiYoy('EPS_BASIC'),
        revenuePerShare,
        reserves:         kpiVal('NET_WORTH') != null && kpiVal('EQ_SHARE_CAP') != null
          ? r2(kpiVal('NET_WORTH') - kpiVal('EQ_SHARE_CAP'))
          : kpiVal('NET_WORTH'),
        reservesGrowth:   kpiYoy('NET_WORTH'),
        quarterlyTrend,
        quarterlyTrendMeta: {
          ebitdaLabel:                 isBfsi ? 'Op. Profit' : 'EBITDA',
          showInterestCoverage:        !isBfsi,
          cfoIsEstimated:              !isBfsi,  // non-BFSI cfo is always the proxy; BFSI gets real CFO at H1
          cfoTooltip:                  isBfsi
            ? 'Cash from operations (H1 filing only)'
            : 'Estimated: Net profit + D&A + Provisions. Excludes working capital changes.',
        },
        dividendYieldTrend,
        fundamentalsTrend,
      },

      valuation: {
        peRatio:          trailingPE,
        peValuationLabel: peValuationLabel(trailingPE),
        forwardPE,
        pbRatio,
        pegRatio,
        evToEbitda,
        evToRevenue,
        enterpriseValue,
        profitMargins,
        industryPE:       null,
        industryPELabel:  null,
      },

      efficiency: {
        returnOnEquity:          roe,
        returnOnAssets:          roa,
        debtToEquity:            de,
        debtGrowth:              kpiYoy('DE'),
        currentRatio,
        quickRatio,
        totalCash:               cashEquivAbs,
        totalDebt:               totalDebtAbs,
        totalCashPerShare,
        interestCoverage,
        interestCoverageGrowth,
      },

      perShare: {
        eps:          kpiVal('EPS_BASIC') ?? kpiVal('EPS_DILUTED'),
        epsForward,
        bookValue,
        dividendRate: null,
        dividendYield,
        payoutRatio,
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
        heldPercentInsiders:     shPromoter,
        heldPercentInstitutions: shInstitutions,
        earningsQuarterlyGrowth: kpiYoy('PAT'),
        fiftyDayAverage,
        twoHundredDayAverage,
        week52Change,
      },

      ratios: {
        roce,
        roce3yAvg,
        roe,
        roe3yAvg,
        debtStatus: debtStatus(de),
      },

      ownership: {
        promoter:     shPromoter,
        institutions: shInstitutions,
        fii:          shFii,
        dii:          shDii,
        public:       shPublic,
        publicLabel:  shPublic != null ? (shPublic > 25 ? 'High retail' : shPublic > 10 ? 'Moderate retail' : 'Low retail') : null,
      },

      financials: {
        eps_cagr_3y:       epsCagr3y,
        eps_cagr_3y_label: epsCagrLabel(epsCagr3y),
        ebitda_ev_yield:   ebitda != null && enterpriseValue != null && enterpriseValue !== 0
          ? r2((ebitda / enterpriseValue) * 100) : null,
        cfo_ebitda_pct:    cfoEbitdaPct,
        net_debt_ebitda:   netDebtEbitda,
      },

    });
  } catch (err) {
    next(err);
  }
}

async function generateFundamentalsIntelligence(symbol, finResult) {
  try {
    const { model, maxTokens, promptTemplate } = await loadSkillConfig('fundamentals-intelligence');
    const prompt = fundamentalsIntelligencePrompt(symbol, finResult, promptTemplate);
    const text = await llmStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    if (!text) return null;
    return parseJson(text);
  } catch (err) {
    console.error('[fundamentalsIntelligence] LLM call failed:', err.message);
    return null;
  }
}

async function getFinancials(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const result = await financials.analyze(symbol);

    const dbInsight = await prisma.aiInsight.findUnique({
      where: { ticker_type: { ticker: symbol, type: 'fundamentals' } },
    });

    if (dbInsight?.insight) {
      result.fundamentalsIntelligence = dbInsight.insight;
    } else {
      const insight = await generateFundamentalsIntelligence(symbol, result);
      result.fundamentalsIntelligence = insight;
      if (insight) {
        await prisma.aiInsight.upsert({
          where:  { ticker_type: { ticker: symbol, type: 'fundamentals' } },
          create: { ticker: symbol, type: 'fundamentals', insight },
          update: { insight, updated_at: new Date() },
        });
      }
    }

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

    const indicators = resolveIndicatorSeries(prices);

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

    // ── 1. Resolve company name ────────────────────────────────────────────
    const ecRow = await prisma.earnings_calls.findFirst({
      where:  { company: symbol },
      select: { company_name: true },
    });
    const companyName = ecRow?.company_name ?? null;

    // ── 2. Fetch raw data in parallel ──────────────────────────────────────
    const now        = Date.now();
    const tenYearsAgo = new Date(now - 10 * 365 * 24 * 60 * 60 * 1000);
    const twoYearsAgo = new Date(now -  2 * 365 * 24 * 60 * 60 * 1000);

    const [monthlyPriceRows, quarterlyPriceRows, peRowsRes, prowessRows] = await Promise.all([
      // Monthly OHLCV aggregated from nse_equity (price group)
      prisma.$queryRaw`
        SELECT
          DATE_TRUNC('month', datetime) AS month,
          AVG(close)  AS close,
          SUM(volume) AS volume
        FROM nse_equity
        WHERE symbol = ${symbol} AND datetime >= ${tenYearsAgo}
        GROUP BY DATE_TRUNC('month', datetime)
        ORDER BY month ASC
      `,

      // Quarterly last-close for ratio chart price lookups
      prisma.$queryRaw`
        SELECT
          DATE_TRUNC('quarter', datetime) AS quarter_date,
          (ARRAY_AGG(close ORDER BY datetime DESC))[1] AS close
        FROM nse_equity
        WHERE symbol = ${symbol} AND datetime >= ${tenYearsAgo}
        GROUP BY DATE_TRUNC('quarter', datetime)
        ORDER BY quarter_date ASC
      `,

      // PE history (keyed by company name or symbol)
      companyName
        ? prisma.pe_data.findMany({ where: { company: companyName }, orderBy: { date: 'asc' } })
        : prisma.pe_data.findMany({ where: { company: symbol },      orderBy: { date: 'asc' } }),

      // Quarterly prowess KPIs — standalone quarterly P&L + balance sheet for charts
      companyName
        ? prisma.$queryRaw`
            SELECT kpi_abbr, value, raw_value, multiplier, fiscal_year, quarter
            FROM prowess_values_new
            WHERE company = ${companyName}
              AND call_id LIKE 'prowess_qtr_%'
            ORDER BY fiscal_year ASC, quarter ASC
          `
        : Promise.resolve([]),
    ]);

    const peRows = peRowsRes;

    // ── 3. Organise prowess rows into quarterly periods ────────────────────
    // Build { "FY2024|Q1": { REV_OP: X, PAT: Y, ... }, ... }
    const prowessByPeriod = {};
    for (const row of prowessRows) {
      const key = `${row.fiscal_year}|${row.quarter}`;
      if (!prowessByPeriod[key]) prowessByPeriod[key] = { fiscal_year: row.fiscal_year, quarter: row.quarter };
      // raw_value is in Cr; value is raw_value * multiplier
      const crVal = row.raw_value != null && row.raw_value !== ''
        ? parseFloat(row.raw_value)
        : (row.value != null && row.multiplier ? parseFloat(row.value) / row.multiplier : null);
      prowessByPeriod[key][row.kpi_abbr] = crVal;
    }

    // Sorted quarterly periods oldest→newest
    const qPeriods = Object.values(prowessByPeriod).sort((a, b) => {
      if (a.fiscal_year !== b.fiscal_year) return (a.fiscal_year ?? '').localeCompare(b.fiscal_year ?? '');
      return (a.quarter ?? '').localeCompare(b.quarter ?? '');
    });

    // Period label: "Q1 FY2024"
    const fmtPeriodLabel = (p) => `${p.quarter} ${p.fiscal_year}`;

    // ── 4. Price group ─────────────────────────────────────────────────────
    // Monthly bars sorted oldest→newest, labelled "Mon YYYY"
    const monthlyQuotes = monthlyPriceRows
      .filter((q) => q.close != null)
      .map((q) => ({ date: q.month, close: parseFloat(q.close), volume: q.volume ? Number(q.volume) : null }));

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

    // ── 5. Shared helpers for fundamentals-based chart groups ─────────────
    // quarterly price lookup: match period label to quarterly close
    const qPriceMap = {};
    for (const q of quarterlyPriceRows) {
      const label = fmtMonthLabel(q.quarter_date);
      qPriceMap[label] = q.close != null ? parseFloat(q.close) : null;
    }

    // Price for a prowess period: match closest quarterly price bar
    function priceForPeriod(p) {
      const label = fmtPeriodLabel(p);
      if (qPriceMap[label] != null) return qPriceMap[label];
      // Fallback: find nearest quarterly price entry by index
      if (quarterlyPriceRows.length === 0) return null;
      return parseFloat(quarterlyPriceRows[quarterlyPriceRows.length - 1].close);
    }

    const fundLabels = qPeriods.map(fmtPeriodLabel);

    // Median helper
    function median(arr) {
      const sorted = arr.filter((v) => v != null).sort((a, b) => a - b);
      if (!sorted.length) return null;
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
        : Math.round(sorted[mid] * 100) / 100;
    }

    // TTM sum of last 4 quarters up to index i for a given field
    function ttmAt(i, field) {
      const slice = qPeriods.slice(Math.max(0, i - 3), i + 1);
      const vals  = slice.map((p) => p[field]).filter((v) => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((s, v) => s + v, 0);
    }

    // ── 3. PE Ratio group ──────────────────────────────────────────────────
    const allPeValues = peRows.map((r) => r.pe != null ? Number(r.pe) : null).filter((v) => v != null);
    const medianPe = median(allPeValues);

    const peData = qPeriods.map((p, i) => {
      const price  = priceForPeriod(p);
      const ttmEps = ttmAt(i, 'EPS_BASIC') ?? ttmAt(i, 'EPS_DILUTED');
      let pe = price != null && ttmEps != null && ttmEps !== 0
        ? Math.round((price / ttmEps) * 100) / 100 : null;
      // Fallback to pe_data DB
      if (pe == null && peRows.length > 0) {
        pe = Math.round(Number(peRows[Math.min(i, peRows.length - 1)].pe) * 100) / 100;
      }
      return { ttmEps, pe };
    });

    const peGroup = {
      group: 'PE Ratio',
      barSeries: [{ dataKey: 'ttmEps', name: 'TTM EPS',
        data: fundLabels.map((x, i) => ({ x, y: peData[i].ttmEps })) }],
      lineSeries: [
        { dataKey: 'pe',       name: 'PE',        data: fundLabels.map((x, i) => ({ x, y: peData[i].pe })) },
        { dataKey: 'medianPe', name: 'Median PE', data: fundLabels.map((x) => ({ x, y: medianPe })) },
      ],
    };

    // ── 4. Sales & Margin group ────────────────────────────────────────────
    const smRevenue = qPeriods.map((p) => p['REV_OP'] ?? p['TOTAL_INCOME'] ?? null);

    // Margins routed through registry; augment kpiMap with TOTAL_INCOME fallback for GROSS_MARGIN
    const smGpm = qPeriods.map((p) => {
      const km = { ...p, TOTAL_INCOME: p['TOTAL_INCOME'] ?? p['REV_OP'] };
      return r2(resolveMetric('GROSS_MARGIN', { kpiMap: km }).value);
    });
    const smOpm = qPeriods.map((p) =>
      r2(resolveMetric('OP_MARGIN', { kpiMap: p }).value)
    );
    const smNpm = qPeriods.map((p) =>
      r2(resolveMetric('PROFIT_MARGIN', { kpiMap: p }).value)
    );

    const salesMarginGroup = {
      group: 'Sales & Margin',
      barSeries: [{ dataKey: 'quarterSales', name: 'Quarter Sales',
        data: fundLabels.map((x, i) => ({ x, y: smRevenue[i] != null ? Math.round(smRevenue[i] * 100) / 100 : null })) }],
      lineSeries: [
        { dataKey: 'gpm', name: 'GPM %', data: fundLabels.map((x, i) => ({ x, y: smGpm[i] })) },
        { dataKey: 'opm', name: 'OPM %', data: fundLabels.map((x, i) => ({ x, y: smOpm[i] })) },
        { dataKey: 'npm', name: 'NPM %', data: fundLabels.map((x, i) => ({ x, y: smNpm[i] })) },
      ],
    };

    // ── 5. EV / EBITDA group ───────────────────────────────────────────────
    const evEbitdaData = qPeriods.map((p, i) => {
      const price     = priceForPeriod(p);
      // EBITDA via registry (PBT + FIN_COST + DEP_AMORT); derive PBT from PAT+TAX_EXP if absent
      const pbtAugmented = p['PBT'] ?? (p['PAT'] != null && p['TAX_EXP'] != null ? p['PAT'] + p['TAX_EXP'] : null);
      const ebitdaCr = r2(resolveMetric('EBITDA', { kpiMap: { ...p, PBT: pbtAugmented } }).value);

      // EV = marketCap + debt - cash
      const eqCapCr = p['EQ_SHARE_CAP'];
      const FACE_VALUE = 10;
      const shares = eqCapCr != null ? (eqCapCr * 1e7) / FACE_VALUE : null;
      const debtCr = p['BORR_TOTAL'] ?? (((p['DEBT_LT'] ?? 0) + (p['DEBT_ST'] ?? 0)) || null);
      const cashCr = p['CASH_EQUIV'];
      const ev = price != null && shares != null
        ? price * shares / 1e7 + (debtCr ?? 0) - (cashCr ?? 0) : null;

      // TTM EBITDA via registry for each TTM quarter slice
      const ttmKm = {
        PBT:      (ttmAt(i, 'PAT') != null && ttmAt(i, 'TAX_EXP') != null) ? ttmAt(i, 'PAT') + ttmAt(i, 'TAX_EXP') : ttmAt(i, 'PBT'),
        FIN_COST:  ttmAt(i, 'FIN_COST'),
        DEP_AMORT: ttmAt(i, 'DEP_AMORT'),
      };
      const ttmEbitda = r2(resolveMetric('EBITDA', { kpiMap: ttmKm }).value);

      const ratio = ev != null && ttmEbitda != null && ttmEbitda !== 0
        ? Math.round((ev / ttmEbitda) * 100) / 100 : null;

      return { ebitdaCr, ratio };
    });

    const MEDIAN_EV_EBITDA = median(evEbitdaData.map((d) => d.ratio));
    const evEbitdaGroup = {
      group: 'EV / EBITDA',
      barSeries: [{ dataKey: 'ebitda', name: 'EBITDA',
        data: fundLabels.map((x, i) => ({ x, y: evEbitdaData[i].ebitdaCr })) }],
      lineSeries: [
        { dataKey: 'evToEbitda',     name: 'EV / EBITDA',                        data: fundLabels.map((x, i) => ({ x, y: evEbitdaData[i].ratio })) },
        { dataKey: 'medianEvMultiple', name: `Median EV Multiple = ${MEDIAN_EV_EBITDA}`, data: fundLabels.map((x) => ({ x, y: MEDIAN_EV_EBITDA })) },
      ],
    };

    // ── 6. Price to Book group ─────────────────────────────────────────────
    const pbvData = qPeriods.map((p) => {
      const price   = priceForPeriod(p);
      const nwCr    = p['NET_WORTH'];
      const eqCapCr = p['EQ_SHARE_CAP'];
      const FACE_VALUE = 10;
      const shares  = eqCapCr != null ? (eqCapCr * 1e7) / FACE_VALUE : null;
      const bvps    = nwCr != null && shares != null && shares !== 0
        ? Math.round(((nwCr * 1e7) / shares) * 100) / 100 : null;
      const pbv     = price != null && bvps != null && bvps !== 0
        ? Math.round((price / bvps) * 100) / 100 : null;
      return { bvps, pbv };
    });

    const MEDIAN_PBV = median(pbvData.map((d) => d.pbv));
    const priceToBookGroup = {
      group: 'Price to Book',
      barSeries: [{ dataKey: 'bookValue', name: 'Book Value',
        data: fundLabels.map((x, i) => ({ x, y: pbvData[i].bvps })) }],
      lineSeries: [
        { dataKey: 'priceToBV', name: 'Price to BV',              data: fundLabels.map((x, i) => ({ x, y: pbvData[i].pbv })) },
        { dataKey: 'medianPBV', name: `Median PBV = ${MEDIAN_PBV}`, data: fundLabels.map((x) => ({ x, y: MEDIAN_PBV })) },
      ],
    };

    // ── 7. Market Cap / Sales group ────────────────────────────────────────
    const mcSalesData = qPeriods.map((p, i) => {
      const price       = priceForPeriod(p);
      const eqCapCr     = p['EQ_SHARE_CAP'];
      const FACE_VALUE  = 10;
      const shares      = eqCapCr != null ? (eqCapCr * 1e7) / FACE_VALUE : null;
      const marketCapCr = price != null && shares != null ? (price * shares) / 1e7 : null;
      const revCr       = p['REV_OP'] ?? p['TOTAL_INCOME'];
      const ttmRevCr    = ttmAt(i, 'REV_OP') ?? ttmAt(i, 'TOTAL_INCOME');
      const mcToSales   = marketCapCr != null && ttmRevCr != null && ttmRevCr !== 0
        ? Math.round((marketCapCr / ttmRevCr) * 100) / 100 : null;
      return { quarterRevenueCr: revCr != null ? Math.round(revCr * 100) / 100 : null, mcToSales };
    });

    const MEDIAN_MC_SALES = median(mcSalesData.map((d) => d.mcToSales));
    const mcSalesGroup = {
      group: 'Market Cap / Sales',
      barSeries: [{ dataKey: 'sales', name: 'Sales',
        data: fundLabels.map((x, i) => ({ x, y: mcSalesData[i].quarterRevenueCr })) }],
      lineSeries: [
        { dataKey: 'mcToSales',       name: 'Market Cap / Sales',                       data: fundLabels.map((x, i) => ({ x, y: mcSalesData[i].mcToSales })) },
        { dataKey: 'medianMcToSales', name: `Median Market Cap to Sales = ${MEDIAN_MC_SALES}`, data: fundLabels.map((x) => ({ x, y: MEDIAN_MC_SALES })) },
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

      // Fallback: use market cap column from Prowess fund CSV (already in Cr)
      if (needMarketCap && marketCap == null && fundRow) {
        const csvMcap = peerPeriodVal(fundRow, LATEST, PEER_OFF.MARKET_CAP);
        if (csvMcap != null) marketCap = r2(csvMcap);
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
