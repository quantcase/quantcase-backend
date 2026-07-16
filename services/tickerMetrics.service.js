'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
const peerIdentity = require('../lib/peerIdentity');
const { fetchMarketSnapshots } = require('../utils/formulaRegistry/dataFetcherMarket');
const prisma = require('../config/prisma');

// Identity CSV column indices (0-based)
const ID_COL_NAME          = peerIdentity.COL_NAME;
const ID_COL_INDUSTRY_GRP  = peerIdentity.COL_INDUSTRY_GRP;
const ID_COL_NSE_BASIC_IND = peerIdentity.COL_NSE_BASIC_IND;
const ID_COL_NSE_SYMBOL    = peerIdentity.COL_NSE_SYMBOL;

// Fundamental CSV layout (same as prowess.controller / screener.controller)
const PEER_COLS_PER_PERIOD = 20;
const PEER_PERIOD_COUNT    = 8;
const PEER_OFF = { SHARES: 0, MARKET_CAP: 1, ADJ_EPS: 3, PE: 5, PB: 6, YIELD: 8,
                   EV: 9, TOTAL_INCOME: 13, NET_PROFIT: 15 };

// osc_mod_qtr_v1.csv layout — 54 data cols per period (col 0 = Company Name, then groups of 54)
const MOD_COLS_PER_PERIOD = 54;
const MOD_OFF = {
  NET_PROFIT:  30,
  INTEREST:    23,
  PAID_CAP:    32,
  RESERVES:    33,
  BORROWINGS:  36,
};

const AI_INSIGHT_TYPES = ['management', 'opportunity', 'deal'];

let _peerFundMap  = null; // { companyName: row[] }
let _peerFundQtrs = null; // string[]
let _modMap       = null; // { companyName: row[] }
let _symbolIndex  = null; // { SYMBOL: idRow }

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
  for (const row of all.slice(6)) {
    const name = (row[0] || '').trim();
    if (name) _modMap[name] = row;
  }
  return _modMap;
}

/**
 * Symbol → identity row index. Built once so batch lookups are O(1) per ticker
 * instead of a linear scan of ~2000 rows per symbol.
 */
function loadSymbolIndex() {
  if (_symbolIndex) return _symbolIndex;
  const { rows } = peerIdentity.load();
  _symbolIndex = {};
  for (const row of rows) {
    const sym = (row[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase();
    if (sym && !_symbolIndex[sym]) _symbolIndex[sym] = row;
  }
  return _symbolIndex;
}

function toFloat(val) {
  if (val === '' || val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }

/** Extract one metric from a Prowess row at a given period index */
function peerPeriodVal(row, periodIndex, offset) {
  const start = 1 + periodIndex * PEER_COLS_PER_PERIOD;
  return toFloat(row[start + offset]);
}

/**
 * ROCE = EBIT / Capital Employed × 100
 *   EBIT = (Net Profit + Interest) × 4 (annualised from latest quarter)
 *   Capital Employed = Paid-up Capital + Reserves + Borrowings
 */
function computeRoce(modRow) {
  if (!modRow) return null;
  const totalCols   = modRow.length - 1;
  const periodCount = Math.floor(totalCols / MOD_COLS_PER_PERIOD);
  const lastPeriod  = periodCount - 1;
  if (lastPeriod < 0) return null;
  const base = 1 + lastPeriod * MOD_COLS_PER_PERIOD;

  const netProfit  = toFloat(modRow[base + MOD_OFF.NET_PROFIT]);
  const interest   = toFloat(modRow[base + MOD_OFF.INTEREST]);
  const paidCap    = toFloat(modRow[base + MOD_OFF.PAID_CAP]);
  const reserves   = toFloat(modRow[base + MOD_OFF.RESERVES]);
  const borrowings = toFloat(modRow[base + MOD_OFF.BORROWINGS]);

  if (netProfit == null || interest == null || paidCap == null ||
      reserves == null || borrowings == null) return null;

  const ebitAnnualised  = (netProfit + interest) * 4;
  const capitalEmployed = paidCap + reserves + borrowings;
  if (capitalEmployed <= 0) return null;
  return r2((ebitAnnualised / capitalEmployed) * 100);
}

/**
 * Build the metrics row for one symbol from pre-fetched maps.
 * Shape matches the `peers[]` entries of GET /api/screener/:symbol/peers.
 */
function buildRow(symbol, ctx) {
  const { symbolIndex, fundMap, modMap, snapsMap, aiInsightsMap } = ctx;
  const idRow = symbolIndex[symbol];
  if (!idRow) return null;

  const companyName = (idRow[ID_COL_NAME] || '').trim();
  const fundRow     = fundMap[companyName] || null;
  const snap        = snapsMap[symbol] || null;
  const LATEST      = PEER_PERIOD_COUNT - 1;
  const YEAR_AGO    = LATEST - 4;

  const cmp = r2(snap?.close ?? null);
  let marketCap = r2(snap?.market_cap_cr ?? null);

  // Fallback: market cap column from the Prowess fund CSV (already in Cr)
  if (marketCap == null && fundRow) {
    const csvMcap = peerPeriodVal(fundRow, LATEST, PEER_OFF.MARKET_CAP);
    if (csvMcap != null) marketCap = r2(csvMcap);
  }

  let pe           = r2(snap?.pe ?? null);
  let divYld       = null;
  let npQtr        = null;
  let salesQtr     = null;
  let qtrProfitVar = null;
  let qtrSalesVar  = null;

  if (fundRow) {
    // PE fallback: Prowess CSV if DB had no entry
    if (pe == null) pe = r2(peerPeriodVal(fundRow, LATEST, PEER_OFF.PE));

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

  const aiScores = aiInsightsMap[symbol] || {};

  return {
    symbol,
    name:          companyName,
    basicIndustry: (idRow[ID_COL_NSE_BASIC_IND] || '').trim() || null,
    industryGroup: (idRow[ID_COL_INDUSTRY_GRP]  || '').trim() || null,
    cmp:           cmp ?? null,
    pe:            pe ?? null,
    marketCapCr:   marketCap ?? null,
    divYld,
    npQtrCr:       npQtr,
    qtrProfitVar,
    salesQtrCr:    salesQtr,
    qtrSalesVar,
    roce:          computeRoce(modMap[companyName] || null),
    management:    aiScores.management  ?? null,
    opportunity:   aiScores.opportunity ?? null,
    deal:          aiScores.deal        ?? null,
  };
}

/**
 * Fetch the full metrics row for a list of NSE symbols.
 *
 * Runs a fixed two queries regardless of list size (market snapshots + AI
 * insights), then joins against the cached Prowess CSVs in memory.
 *
 * @param {string[]} symbols  NSE symbols, any case
 * @returns {Promise<{ tickers: object[], notFound: string[] }>}
 *   `tickers` preserves the caller's order, minus unknown symbols.
 *   `notFound` lists symbols absent from the identity CSV.
 */
async function getMetricsForTickers(symbols) {
  const symbolIndex = loadSymbolIndex();

  // Normalise + dedupe, preserving caller order
  const seen = new Set();
  const requested = [];
  for (const s of symbols) {
    const sym = String(s).trim().toUpperCase();
    if (sym && !seen.has(sym)) { seen.add(sym); requested.push(sym); }
  }

  const known    = requested.filter((s) => symbolIndex[s]);
  const notFound = requested.filter((s) => !symbolIndex[s]);

  if (known.length === 0) return { tickers: [], notFound };

  const { fundMap } = loadPeerFundamentals();
  const modMap = loadModData();

  const [snapsMap, aiInsightRows] = await Promise.all([
    fetchMarketSnapshots(prisma, known),
    prisma.aiInsight.findMany({
      where: { ticker: { in: known }, type: { in: AI_INSIGHT_TYPES } },
      select: { ticker: true, type: true, insight: true },
    }),
  ]);

  // aiInsightsMap[ticker][type] = { score, verdict }
  const aiInsightsMap = {};
  for (const row of aiInsightRows) {
    const t = row.ticker.toUpperCase();
    if (!aiInsightsMap[t]) aiInsightsMap[t] = {};
    aiInsightsMap[t][row.type] = {
      score:   row.insight?.score   ?? null,
      verdict: row.insight?.verdict ?? null,
    };
  }

  const ctx = { symbolIndex, fundMap, modMap, snapsMap, aiInsightsMap };
  const tickers = known.map((sym) => buildRow(sym, ctx)).filter(Boolean);

  return { tickers, notFound };
}

/** Latest and year-ago quarter labels the metrics are drawn from. */
function getQuarterLabels() {
  const { qtrs } = loadPeerFundamentals();
  const LATEST = PEER_PERIOD_COUNT - 1;
  return { latestQuarter: qtrs[LATEST], yearAgoQuarter: qtrs[LATEST - 4] || null };
}

module.exports = { getMetricsForTickers, getQuarterLabels };
