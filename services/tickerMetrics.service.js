'use strict';

const peerIdentity = require('../lib/peerIdentity');
const prisma = require('../config/prisma');
const { createMultiCompanyResolutionContext, resolveMetric } = require('../utils/formulaRegistry');

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
  ROCE:          { field: 'roce',         frequency: 'annual' },
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
  const out = {};
  for (const item of config.items) {
    const mapping = PEER_COLUMN_MAP[item.kpi_abbr];
    if (!mapping) continue; // unmapped item -- skip rather than silently guess a field name
    if (item.company_group_slug && !(await resCtx.isCompanyInGroup(item.company_group_slug))) continue;
    const res = await resolveMetric(item.kpi_abbr, resCtx, { frequency: mapping.frequency });
    const decimals = item.decimal_places ?? config.decimal_places;
    out[mapping.field] = roundTo(res.value, decimals);
  }
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

  const [config, resCtxMap, aiInsightRows] = await Promise.all([
    prisma.screenConfig.findUnique({ where: { key: PEERS_CONFIG_KEY }, include: { items: true } }),
    createMultiCompanyResolutionContext({ symbols: known }),
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

  const tickers = [];
  for (const sym of known) {
    const idRow  = symbolIndex[sym];
    const resCtx = resCtxMap.get(sym);
    const columns   = config ? await _resolvePeerColumns(resCtx, config) : {};
    const aiScores  = aiInsightsMap[sym] || {};

    tickers.push({
      symbol: sym,
      name:          (idRow[ID_COL_NAME] || '').trim(),
      basicIndustry: (idRow[ID_COL_NSE_BASIC_IND] || '').trim() || null,
      industryGroup: (idRow[ID_COL_INDUSTRY_GRP]  || '').trim() || null,
      cmp:           null,
      pe:            null,
      marketCapCr:   null,
      divYld:        null,
      npQtrCr:       null,
      qtrProfitVar:  null,
      salesQtrCr:    null,
      qtrSalesVar:   null,
      roce:          null,
      ...columns,
      management:    aiScores.management  ?? null,
      opportunity:   aiScores.opportunity ?? null,
      deal:          aiScores.deal        ?? null,
    });
  }

  return { tickers, notFound };
}

/**
 * Latest and year-ago quarter labels the metrics are drawn from — a single,
 * DB-derived representative label across the whole company universe
 * (replaces the old CSV's own fixed 8-quarter column structure, which was
 * implicitly the same "one global label" idea). "Year ago" is 4 positions
 * back in the distinct sorted period list, matching the old CSV's positional
 * LATEST-4 semantics.
 */
async function getQuarterLabels() {
  const rows = await prisma.prowessValueNew.findMany({
    where:    { callId: { startsWith: 'prowess_qtr_' } },
    select:   { fiscal_year: true, quarter: true },
    distinct: ['fiscal_year', 'quarter'],
  });
  const sorted = [...new Set(rows.map((r) => `${r.fiscal_year}|${r.quarter}`))].sort();
  const fmt = (key) => {
    if (!key) return null;
    const [fy, q] = key.split('|');
    return `${q} ${fy}`;
  };
  return {
    latestQuarter:  fmt(sorted.at(-1)),
    yearAgoQuarter: sorted.length > 4 ? fmt(sorted.at(-5)) : null,
  };
}

module.exports = { getMetricsForTickers, getQuarterLabels };
