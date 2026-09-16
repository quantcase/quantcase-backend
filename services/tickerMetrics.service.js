'use strict';

const peerIdentity = require('../lib/peerIdentity');
const prisma = require('../config/prisma');
const { createMultiCompanyResolutionContext, resolveMetric } = require('../utils/formulaRegistry');
const { fetchMarketSnapshots, DAILY_SERIES_FIELDS } = require('../utils/formulaRegistry/dataFetcherMarket');

// Identity CSV column indices (0-based) — company name/industry classification,
// not a fundamentals source, so this stays untouched (same CSV screener.
// controller.js#getTickerInfo already relies on for identity/classification).
const ID_COL_NAME          = peerIdentity.COL_NAME;
const ID_COL_INDUSTRY_GRP  = peerIdentity.COL_INDUSTRY_GRP;
const ID_COL_NSE_BASIC_IND = peerIdentity.COL_NSE_BASIC_IND;
const ID_COL_NSE_SYMBOL    = peerIdentity.COL_NSE_SYMBOL;

const AI_INSIGHT_TYPES = ['management', 'opportunity', 'deal'];
const PEERS_CONFIG_KEY = 'peers.columns';

// Maps a peers.columns ScreenConfigItem's kpi_abbr to the named field the
// peers[] API contract already exposes, plus which frequency to resolve it
// at. Peers' response shape is a fixed set of named fields (frontend already
// consumes cmp/pe/marketCapCr/...), unlike financials/charts' generic row/
// series arrays keyed directly by kpi_abbr — this mapping is what lets the
// ScreenConfig stay generic while the contract stays stable. `divYld` has no
// entry yet, in practice — DIVIDEND_YIELD exists in the catalogue
// (registry_enabled) but has zero source rows anywhere in
// prowess_values_new (verified), so it resolves null until real data is
// ingested through the normal Prowess pipeline. No CSV fallback.
//
// Per-field frequency, not one blanket override: PBT/TAX_EXP have zero
// quarterly data anywhere in prowess_values_new (a real, confirmed ingestion
// gap — see 2.2's findings), so ROCE's formula only ever resolves at annual
// frequency (a real stored value there); the "Qtr"-named fields genuinely
// need quarterly data by definition, so they keep that frequency regardless.
const PEER_COLUMN_MAP = {
  PRICE:         { field: 'cmp',          frequency: 'daily' },
  PE_TTM:        { field: 'pe',           frequency: 'quarterly' },
  MCAP_SNAPSHOT: { field: 'marketCapCr',  frequency: 'daily' },
  DIVIDEND_YIELD: { field: 'divYld',      frequency: 'quarterly' },
  PAT:           { field: 'npQtrCr',      frequency: 'quarterly' },
  PAT_CAGR:      { field: 'qtrProfitVar', frequency: 'quarterly' },
  REV_OP:        { field: 'salesQtrCr',   frequency: 'quarterly' },
  REV_CAGR:      { field: 'qtrSalesVar',  frequency: 'quarterly' },
  ROCE:          { field: 'roce',         frequency: 'quarterly' },
};

let _symbolIndex = null; // { SYMBOL: idRow }

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

function roundTo(v, decimals) {
  if (v == null || isNaN(v)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/**
 * Resolves every peers.columns item for one company against its slice of the
 * shared multi-company resolution context — same resolveMetric path GET
 * /admin/kpis/:abbr/preview uses, so peer numbers can never silently diverge
 * from what admin sees there (replaces the old CSV-sourced values and the
 * completely disconnected, non-registry `computeRoce` formula).
 */
async function _resolvePeerColumns(resCtx, config) {
  if (!resCtx || !config || !Array.isArray(config.items)) return {};
  const out = {};
  await Promise.all(config.items.map(async (item) => {
    if (!item.kpi_abbr) return;
    if (item.company_group_slug && !(await resCtx.isCompanyInGroup(item.company_group_slug))) return;
    const mapping = PEER_COLUMN_MAP[item.kpi_abbr];
    let freq = mapping?.frequency;
    if (!freq) {
      freq = DAILY_SERIES_FIELDS && DAILY_SERIES_FIELDS[item.kpi_abbr] ? 'daily' : 'quarterly';
    }
    let res = await resolveMetric(item.kpi_abbr, resCtx, { frequency: freq });
    if (res.value == null && (freq === 'quarterly' || freq === 'annual')) {
      const altFreq = freq === 'quarterly' ? 'annual' : 'quarterly';
      const altRes = await resolveMetric(item.kpi_abbr, resCtx, { frequency: altFreq });
      if (altRes.value != null) res = altRes;
    }
    const decimals = item.decimal_places ?? config.decimal_places;
    const val = roundTo(res.value, decimals);
    out[item.kpi_abbr] = val;
    if (mapping?.field) {
      out[mapping.field] = val;
    }
  }));
  return out;
}

/**
 * Fetch the full metrics row for a list of NSE symbols.
 *
 * Runs a small constant number of bulk queries regardless of list size (via
 * createMultiCompanyResolutionContext — batched annual/quarterly/market-
 * snapshot fetches, not one round trip per company), then resolves every
 * peers.columns item per company against its slice of that shared context.
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

  const [config, resCtxMap, modScoreRows, snapshots] = await Promise.all([
    prisma.screenConfig.findUnique({ where: { key: PEERS_CONFIG_KEY }, include: { items: { orderBy: { display_order: 'asc' } } } }),
    createMultiCompanyResolutionContext({ symbols: known }),
    // Use post_html_analysis (l3) — the active MOD-score pipeline — instead of
    // the legacy ai_insights table which is rarely refreshed and often empty.
    prisma.postHtmlAnalysis.findMany({
      where: { ticker: { in: known }, layer_id: 'l3', type: { in: AI_INSIGHT_TYPES } },
      select: { ticker: true, type: true, result: true },
    }),
    fetchMarketSnapshots(prisma, known),
  ]);

  // modScoresMap[ticker][type] = { score, verdict }
  // result.score is numeric; result.verdict.rating is title-cased ("Moderate"),
  // so we uppercase it to match the STRONG/MODERATE/WEAK convention the
  // frontend's verdictColor() and ScoreChip expect.
  const modScoresMap = {};
  for (const row of modScoreRows) {
    const t = row.ticker.toUpperCase();
    if (!modScoresMap[t]) modScoresMap[t] = {};
    const result = row.result || {};
    modScoresMap[t][row.type] = {
      score:   typeof result.score === 'number' ? result.score : null,
      verdict: result.verdict?.rating ? String(result.verdict.rating).toUpperCase() : null,
    };
  }

  const tickers = await Promise.all(known.map(async (sym) => {
    const idRow     = symbolIndex[sym];
    const resCtx    = resCtxMap.get(sym);
    const columns   = config ? await _resolvePeerColumns(resCtx, config) : {};
    const modScores = modScoresMap[sym] || {};
    const snap      = snapshots[sym] || {};

    let peType = null;
    if (snap.pe != null) {
      peType = 'default';
    } else if (snap.pe_consolidated != null) {
      peType = 'consolidated';
    } else if (snap.pe_standalone != null) {
      peType = 'standalone';
    }

    return {
      symbol: sym,
      name:          (idRow[ID_COL_NAME] || '').trim(),
      basicIndustry: (idRow[ID_COL_NSE_BASIC_IND] || '').trim() || null,
      industryGroup: (idRow[ID_COL_INDUSTRY_GRP]  || '').trim() || null,
      cmp:           null,
      pe:            null,
      peType,
      marketCapCr:   null,
      divYld:        null,
      npQtrCr:       null,
      qtrProfitVar:  null,
      salesQtrCr:    null,
      qtrSalesVar:   null,
      roce:          null,
      ...columns,
      management:    modScores.management  ?? null,
      opportunity:   modScores.opportunity ?? null,
      deal:          modScores.deal        ?? null,
    };
  }));

  return { tickers, notFound };
}

let _quarterLabelsCache = null;
let _quarterLabelsExpiry = 0;
const LABELS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory cache

/**
 * Latest and year-ago quarter labels the metrics are drawn from.
 * Uses a fast grouped query with 1-hour in-memory cache to avoid heavy full table scans.
 */
async function getQuarterLabels() {
  const now = Date.now();
  if (_quarterLabelsCache && now < _quarterLabelsExpiry) {
    return _quarterLabelsCache;
  }

  try {
    const rows = await prisma.$queryRaw`
      SELECT fiscal_year, quarter
      FROM prowess_values_new
      WHERE call_id LIKE 'prowess_qtr_%'
        AND fiscal_year IS NOT NULL
        AND quarter IS NOT NULL
      GROUP BY fiscal_year, quarter
    `;
    const sorted = [...new Set(rows.map((r) => `${r.fiscal_year}|${r.quarter}`))].sort();
    const fmt = (key) => {
      if (!key) return null;
      const [fy, q] = key.split('|');
      return `${q} ${fy}`;
    };
    _quarterLabelsCache = {
      latestQuarter:  fmt(sorted.at(-1)),
      yearAgoQuarter: sorted.length > 4 ? fmt(sorted.at(-5)) : null,
    };
    _quarterLabelsExpiry = now + LABELS_CACHE_TTL_MS;
    return _quarterLabelsCache;
  } catch (err) {
    if (_quarterLabelsCache) return _quarterLabelsCache;
    throw err;
  }
}

module.exports = { getMetricsForTickers, getQuarterLabels };
