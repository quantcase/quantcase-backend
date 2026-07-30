'use strict';

const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
const technicalAnalysis = require('../lib/technicalAnalysis');
const financials = require('../lib/financials');
const { fundamentalsIntelligencePrompt } = require('../prompts/fundamentals_intelligence');
const { loadSkillConfig } = require('../utils/skillConfig');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { resolveMetric, resolveFormulaSeries, resolveIndicatorSeries, createFlatContext, createSeriesOnlyContext, createSeriesMapContext } = require('../utils/formulaRegistry/index');
const { fetchOhlcvBars, fetchWyckoffBars, fetchMarketSnapshot, fetchMarketSnapshots, fetchMonthlyOhlcv, fetchPeTimeSeries } = require('../utils/formulaRegistry/dataFetcherMarket');
const wyckoff = require('../lib/wyckoff');
const crs = require('../lib/crs');
const { isBFSI } = require('../utils/industryClassifier');
const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');
const { TECHNICALS_QUEUE, technicalsJobId, ensureTechnicalsJob, inFlightTechnicalsJob } = require('../lib/technicalsQueue');
const tickerMetrics = require('../services/tickerMetrics.service');

// ── Cache helpers ────────────────────────────────────────────────────────────

function setCacheTillMidnightIst(res) {
  const nowUtc = new Date();
  const midnight = new Date(nowUtc);
  midnight.setUTCHours(18, 30, 0, 0); // midnight IST = 18:30 UTC
  if (midnight <= nowUtc) midnight.setUTCDate(midnight.getUTCDate() + 1);
  const maxAge = Math.floor((midnight - nowUtc) / 1000);
  res.set('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=60`);
}

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

// TECHNICALS_QUEUE / technicalsJobId / ensureTechnicalsJob / inFlightTechnicalsJob now live
// in lib/technicalsQueue.js (imported above) — shared with the admin bulk-analyze endpoint.

async function getTechnicals(req, res, next) {
  try {
    const symbol      = req.params.symbol.toUpperCase();
    const forceRefresh = req.query.refresh === '1';
    const result = await technicalAnalysis.analyze(symbol);

    const dbInsight = forceRefresh ? null : await prisma.aiInsight.findUnique({
      where: { ticker_type: { ticker: symbol, type: 'technicals' } },
    });

    if (dbInsight?.insight) {
      result.decisionIntelligence = dbInsight.insight;
      result.insightStatus    = 'ready';
      result.insightUpdatedAt = dbInsight.updated_at;
      // Surface an in-flight regeneration (e.g. a prior ?refresh=1) so the caller knows the
      // insight it just received is about to be superseded and can keep polling /status.
      result.insightJob = await inFlightTechnicalsJob(symbol);
    } else {
      result.decisionIntelligence = null;
      result.insightUpdatedAt     = null;
      // Distinguish the states the frontend previously had to guess at: a null insight now
      // always carries either 'generating' (keep polling) or 'failed' (stop polling).
      try {
        const job = await ensureTechnicalsJob(symbol, { force: forceRefresh });
        result.insightJob    = job;
        result.insightStatus = job.status === 'failed' ? 'failed' : 'generating';
      } catch (err) {
        console.error('[getTechnicals] Failed to enqueue job:', err.message);
        result.insightJob    = null;
        result.insightStatus = 'failed';
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

/**
 * Cheap poll target for a pending insight.
 *
 * Deliberately does NOT call technicalAnalysis.analyze() — that re-fetches bars and
 * recomputes every indicator, which is far too expensive to run on a 3-second poll.
 * Reads only the stored insight and the BullMQ job state.
 */
async function getTechnicalsStatus(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const jobId  = technicalsJobId(symbol);

    const [dbInsight, job] = await Promise.all([
      prisma.aiInsight.findUnique({
        where:  { ticker_type: { ticker: symbol, type: 'technicals' } },
        select: { updated_at: true },
      }),
      jobQueue.getQueue(TECHNICALS_QUEUE).getJob(jobId),
    ]);

    const state            = job ? await job.getState() : null;
    const insightUpdatedAt = dbInsight?.updated_at ?? null;

    // Job state is checked BEFORE the stored row: after ?refresh=1 the previous insight is
    // still in the table (the worker overwrites it only on success), so keying off the row
    // alone would report 'ready' for a regeneration that is still running and the caller
    // would never learn the refresh finished. `insightUpdatedAt` is always returned so a
    // stale-but-renderable insight can stay on screen while its replacement is generated.
    if (state === 'active' || state === 'waiting' || state === 'delayed') {
      return res.json({
        symbol,
        insightStatus: 'generating',
        insightJob: {
          id:       jobId,
          status:   state === 'active' ? 'processing' : 'queued',
          progress: job.progress ?? 0,
        },
        insightUpdatedAt,
      });
    }

    if (state === 'failed') {
      return res.json({
        symbol,
        insightStatus: 'failed',
        insightJob: { id: jobId, status: 'failed', progress: job.progress ?? 0, error: job.failedReason || 'Job failed' },
        insightUpdatedAt,
      });
    }

    if (dbInsight) {
      return res.json({ symbol, insightStatus: 'ready', insightJob: null, insightUpdatedAt });
    }

    // No job and no insight: nothing has ever been requested for this symbol. Report
    // 'absent' rather than enqueueing — this endpoint is a read, GET /technicals starts work.
    res.json({ symbol, insightStatus: 'absent', insightJob: null, insightUpdatedAt: null });
  } catch (err) {
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

    // BFSI flag — drives label and column visibility decisions passed to the
    // frontend only (e.g. "Op. Profit" vs "EBITDA" below); the underlying
    // value is computed the same way for every company. This is purely a
    // display concern, unrelated to KPI resolution — a BFSI-specific table
    // with its own rows/formulas is a separate ScreenConfig variant (see
    // ScreenConfig.variant_of_key in prisma/schema.prisma), not a flag
    // threaded through here. This is the canonical classifier
    // (utils/industryClassifier.js) also used by admin.service.js/
    // peerMetrics.js — consolidated from a separate, inconsistent
    // keyword-match that used to live here.
    const isBfsi = isBFSI(basicIndustry);
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

    // ── 2. Price + market data from nse_equity_new ────────────────────────
    const [marketData, marketSnap, annualRows, quarterlyRows] = await Promise.all([
      fetchOhlcvBars(prisma, sym),
      fetchMarketSnapshot(prisma, sym),
      // Annual KPI values — last 6 fiscal years covers YoY, 3Y CAGR, and all ratio lookbacks
      companyName
        ? prisma.$queryRaw`
            SELECT kpi_abbr, value, raw_value, unit, multiplier, fiscal_year, quarter, period_type
            FROM prowess_values_new
            WHERE company = ${companyName}
              AND call_id LIKE 'prowess_new_%'
            ORDER BY fiscal_year DESC, quarter DESC, source_type ASC
            LIMIT 500
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
    ]);

    // ── 3. Price calculations ──────────────────────────────────────────────
    const dailyBars = marketData.dailyBars;
    const latest    = dailyBars.at(-1) ?? null;
    const prev      = dailyBars.length > 1 ? dailyBars.at(-2) : null;

    if (!latest && !companyName) {
      return res.status(404).json({ error: `Symbol "${sym}" not found` });
    }

    const today         = latest ?? null;
    const price         = latest?.close ?? null;
    const prevClose     = prev?.close   ?? null;
    const change        = price != null && prevClose != null ? r2(price - prevClose) : null;
    const changePercent = price != null && prevClose != null && prevClose !== 0
      ? r2((price - prevClose) / prevClose) : null;

    const week52High = dailyBars.length ? r2(Math.max(...dailyBars.map(b => b.high))) : null;
    const week52Low  = dailyBars.length ? r2(Math.min(...dailyBars.map(b => b.low)))  : null;

    const last50Closes  = dailyBars.slice(-50).map(b => b.close).filter(v => v != null);
    const last200Closes = dailyBars.slice(-200).map(b => b.close).filter(v => v != null);
    const fiftyDayAverage      = last50Closes.length  ? r2(last50Closes.reduce((s, v) => s + v, 0)  / last50Closes.length)  : null;
    const twoHundredDayAverage = last200Closes.length ? r2(last200Closes.reduce((s, v) => s + v, 0) / last200Closes.length) : null;

    const priceYearAgoVal = dailyBars[0]?.close ?? null;
    const week52Change = price != null && priceYearAgoVal != null && priceYearAgoVal !== 0
      ? r2((price - priceYearAgoVal) / Math.abs(priceYearAgoVal))
      : null;

    // ── 4. Market cap ──────────────────────────────────────────────────────
    const marketCapCr  = marketSnap?.market_cap_cr ?? null;
    const marketCapAbs = marketCapCr != null ? marketCapCr * 1e7 : null;

    function marketCapLabel(capCr) {
      if (capCr == null) return null;
      if (capCr >= 20000) return 'Large cap';
      if (capCr >= 5000)  return 'Mid cap';
      return 'Small cap';
    }

    // ── 5. P/E ─────────────────────────────────────────────────────────────
    let trailingPE = marketSnap?.pe != null ? r2(marketSnap.pe) : null;

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

    // ── 7. PE fallback from market cap / PAT ──────────────────────────────
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
    const quarterlyTrend = await Promise.all(Object.values(trendPeriods)
      .sort((a, b) => {
        if (a.fiscal_year !== b.fiscal_year) return (a.fiscal_year ?? '').localeCompare(b.fiscal_year ?? '');
        return (a.quarter ?? '').localeCompare(b.quarter ?? '');
      })
      .map(async (p) => {
        // EBITDA: try registry formula (PBT+FIN_COST+DEP_AMORT); fall back to
        // (REV_OP - TOTAL_OPEX) + DEP_AMORT when quarterly data lacks PBT
        let ebitdaVal = (await resolveMetric('EBITDA', createFlatContext({ kpiMap: p }))).value;
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
      }));

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

    async function rk(abbr, extra = {}) {
      const res = await resolveMetric(abbr, createFlatContext({ kpiMap: { ...flatKpiMap, ...extra }, prevKpiMap: flatPrevKpiMap }));
      return res.value; // raw unrounded; callers apply r2()
    }

    const ebitdaRaw        = await rk('EBITDA');
    const roeRaw           = await rk('ROE');
    const roaRaw           = await rk('ROA');
    const roceRaw          = await rk('ROCE');
    const ebitdaMrgRaw     = await rk('EBITDA_MARGIN',  { EBITDA: ebitdaRaw });
    const profMrgRaw       = await rk('PROFIT_MARGIN');
    const grossMrgRaw      = await rk('GROSS_MARGIN');
    const opMrgRaw         = await rk('OP_MARGIN');
    const fcfRaw           = await rk('FCF');
    const currRatRaw       = await rk('CURRENT_RATIO');
    const quickRatRaw      = await rk('QUICK_RATIO');
    const netDebtRaw       = await rk('NET_DEBT');
    const netDebtEbRaw     = await rk('NET_DEBT_EBITDA', { NET_DEBT: netDebtRaw, EBITDA: ebitdaRaw });
    const deRaw            = await rk('DE');

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
    const epsCagr3y = r2((await resolveMetric('EPS_CAGR_3Y', createSeriesOnlyContext({ series: epsSeriesAsc }))).value);

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
    const roce3yAvg = r2((await resolveMetric('ROCE_3Y_AVG', createSeriesOnlyContext({ series: roceSeriesAsc }))).value);

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
    const roe3yAvg = r2((await resolveMetric('ROE_3Y_AVG', createSeriesOnlyContext({ series: roeSeriesAsc }))).value);

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
    setCacheTillMidnightIst(res);
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
    const { text, usage } = await llmStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    logUsage('screener/fundamentals', usage);
    if (!text) return null;
    return parseJson(text);
  } catch (err) {
    console.error('[fundamentalsIntelligence] LLM call failed:', err.message);
    return null;
  }
}

/**
 * Decide whether a cached fundamentals insight still matches the shape the
 * skill currently promises. The signal keys are read from the skill's
 * outputSchema in the DB, so adding a signal stays a DB-only change.
 *
 * A row is regenerated only when it is BOTH missing a promised signal AND
 * older than the skill itself. The `updated_at < skill.updatedAt` half is what
 * makes this loop-free: once a row is regenerated its timestamp is newer than
 * the skill's, so a model that ignores a new signal key costs one extra LLM
 * call for that ticker, not one per request. The missing-key half keeps an
 * unrelated future prompt tweak from invalidating every cached row.
 */
async function isFundamentalsInsightStale(dbInsight) {
  if (!dbInsight?.insight) return true;

  let outputSchema, updatedAt;
  try {
    ({ outputSchema, updatedAt } = await loadSkillConfig('fundamentals-intelligence'));
  } catch (err) {
    // Skill config unreadable — serve what we have rather than regenerating blind.
    console.error('[fundamentalsIntelligence] skill config unreadable:', err.message);
    return false;
  }

  const expectedKeys = Object.keys(outputSchema?.properties?.signals?.properties ?? {});
  if (expectedKeys.length === 0) return false;

  const signals = dbInsight.insight.signals ?? {};
  const missing = expectedKeys.filter((k) => signals[k] == null || signals[k] === '');
  if (missing.length === 0) return false;

  const rowUpdatedAt = dbInsight.updated_at ?? dbInsight.created_at;
  if (updatedAt && rowUpdatedAt && rowUpdatedAt >= updatedAt) return false;

  console.log(`[fundamentalsIntelligence] regenerating ${dbInsight.ticker} — missing signals: ${missing.join(', ')}`);
  return true;
}

async function getFinancials(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const result = await financials.analyze(symbol);

    const dbInsight = await prisma.aiInsight.findUnique({
      where: { ticker_type: { ticker: symbol, type: 'fundamentals' } },
    });

    if (dbInsight?.insight && !(await isFundamentalsInsightStale(dbInsight))) {
      result.fundamentalsIntelligence = dbInsight.insight;
    } else {
      const insight = await generateFundamentalsIntelligence(symbol, result);
      // On LLM failure keep serving the stale insight instead of dropping the
      // whole block to null.
      result.fundamentalsIntelligence = insight ?? dbInsight?.insight ?? null;
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

const SMA_PERIODS = [20, 50, 100, 200];

/**
 * SMA_20/50/100/200 via the Kpi-driven resolver (AVG(PRICE, N), the same
 * formula an admin can inspect/edit at /admin/kpis/SMA_20) instead of
 * taIndicators' own smaSeries — one source of truth shared with
 * technicalAnalysis.js's /technicals endpoint. Seeded from bars getPrices
 * already fetched (createSeriesMapContext), so this adds no extra DB round
 * trip.
 *
 * averageFromSeries doesn't null out on a short window (see
 * createSeriesMapContext's docs — that's deliberate, other formulas like
 * ROE_3Y_AVG rely on it), so the `period - 1` warmup nulling below is applied
 * here to match taIndicators.smaSeries' "null until `period` days of history
 * exist" convention instead of silently showing a partial-window average.
 */
async function resolveSmaSeries(prices) {
  const resCtx = createSeriesMapContext({
    seriesMap: { PRICE: prices.map((p) => ({ value: p.close })) },
    frequency: 'daily',
  });
  const results = await Promise.all(SMA_PERIODS.map((p) => resolveFormulaSeries(`SMA_${p}`, resCtx)));

  const out = {};
  SMA_PERIODS.forEach((period, idx) => {
    out[`sma${period}`] = prices.map((p, i) => ({
      date:  p.date,
      value: i >= period - 1 ? (results[idx][i] ?? null) : null,
    }));
  });
  return out;
}

async function getPrices(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const period1 = req.query.from
      ? new Date(req.query.from)
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // default: 1 year
    const period2 = req.query.to ? new Date(req.query.to) : new Date();

    const rows = await prisma.nse_equity_new.findMany({
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

    const [indicators, smaSeries] = await Promise.all([
      Promise.resolve(resolveIndicatorSeries(prices)),
      resolveSmaSeries(prices),
    ]);
    Object.assign(indicators, smaSeries);

    // CRS (comparative relative strength) lines vs NIFTY 50 and the stock's sector index.
    // Kept out of resolveIndicatorSeries — which is pure and price-only — because these need
    // index price history (nse_equity_new) plus sector resolution. Additive and best-effort:
    // a failure here must never break the core price payload, and the three keys are always
    // present (aligned, all-null when an index isn't backfilled yet) so the contract is stable.
    try {
      Object.assign(indicators, await crs.computeCrsSeries(symbol, prices, period1, period2));
    } catch (err) {
      console.error(`[getPrices] CRS computation failed for ${symbol}:`, err.message);
      Object.assign(indicators, { crsStockVsNifty: [], crsStockVsSector: [], crsSectorVsNifty: [] });
    }

    setCacheTillMidnightIst(res);
    res.json({ symbol, count: prices.length, prices, indicators });
  } catch (err) {
    next(err);
  }
}

// ── Wyckoff ───────────────────────────────────────────────────────────────────

/**
 * GET /api/screener/:symbol/wyckoff
 *
 * Server-side Wyckoff phase analysis — the engine the frontend used to run in the
 * browser (see docs/frontend/FRONTEND_WYCKOFF_API.md).
 *
 * Query: chartYears (int, default 3), includeBars (bool, default true),
 *        minPct (float, overrides the adaptive zigzag threshold).
 *
 * Insufficient history is NOT an HTTP error — it returns 200 with
 * meta.insufficientData so the page can render its own empty state.
 */
async function getWyckoff(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const chartYears = Math.max(1, Math.min(20, parseInt(req.query.chartYears, 10) || 3));
    const includeBars = req.query.includeBars !== 'false';
    const minPctRaw = parseFloat(req.query.minPct);
    const minPct = Number.isFinite(minPctRaw) ? minPctRaw : null;

    const allBars = await fetchWyckoffBars(prisma, symbol);
    if (allBars.length === 0) {
      return res.status(404).json({ error: `No price data found for symbol ${symbol}` });
    }

    const era = wyckoff.selectContiguousDailyEra(allBars);
    // Correct corroborated splits/bonuses before analysis — left raw, a 1:1 bonus reads
    // as a -50% crash and pins the phase to Markdown.
    const splits = wyckoff.backAdjustSplits(era.bars);
    const result = wyckoff.analyzeWyckoff(splits.bars, { minPct });
    const payload = wyckoff.buildWyckoffResponse({
      symbol,
      bars: splits.bars,
      result,
      era,
      totalRows: allBars.length,
      options: { chartYears, includeBars },
      splits,
    });

    setCacheTillMidnightIst(res);
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

// ── Peer comparison ───────────────────────────────────────────────────────────

/**
 * GET /api/screener/:symbol/peers
 *
 * 1. Resolve symbol → NSE Basic Industry classification via osc_identity.csv
 * 2. Collect all peers in the same basic industry
 * 3. Pull latest-quarter fundamentals from osc_fundamental_ind_qtr_v4.csv
 * 4. Bulk-fetch CMP, Market Cap, and PE from DB
 * 5. Return all metrics for all peers
 */
async function getPeers(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();

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
    const nseSymbols = idRows
      .filter((r) => (r[ID_COL_NSE_BASIC_IND] || '').trim() === subjectBasicInd)
      .map((r) => (r[ID_COL_NSE_SYMBOL] || '').trim().toUpperCase())
      .filter(Boolean);

    if (nseSymbols.length === 0) {
      return res.status(404).json({ error: `No peers found for industry "${subjectBasicInd}"` });
    }

    // ── 3. Build metric rows (shared with GET /api/tickers) ──────────────────
    const { tickers } = await tickerMetrics.getMetricsForTickers(nseSymbols);
    const { latestQuarter, yearAgoQuarter } = await tickerMetrics.getQuarterLabels();

    const peers = tickers.map((t) => ({ ...t, isSubject: t.symbol === symbol }));

    // Sort: subject first, then by marketCap desc
    peers.sort((a, b) => {
      if (a.isSubject) return -1;
      if (b.isSubject) return 1;
      return (b.marketCapCr ?? 0) - (a.marketCapCr ?? 0);
    });

    setCacheTillMidnightIst(res);
    res.json({
      symbol,
      basicIndustry: subjectBasicInd,
      industryGroup: subjectIndGrp,
      latestQuarter,
      yearAgoQuarter,
      count: peers.length,
      peers,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getTickerInfo, getTechnicals, getTechnicalsStatus, getFinancials, getPrices, getPeers, getWyckoff };
