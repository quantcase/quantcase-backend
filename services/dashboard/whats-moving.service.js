'use strict';

/**
 * GET /api/portfolio/whats-moving?limit=4
 *
 * Personalised feed of QC-score movements and upcoming earnings for the symbols
 * the user holds.
 *
 * Fidelity note (current-state only): there is no MOD/lens score-history table,
 * so "upgrade/downgrade" movement is derived from the week-over-week change in
 * the IIT composite score (iit_weekly_stock_scores). True per-MOD score history
 * is a future enhancement — see delivery notes.
 */

const prisma = require('../../config/prisma');
const { resolveHoldings } = require('./resolve-holdings.service');
const { resolveShadowHoldings } = require('./resolve-shadow-holdings.service');
const { fetchModScores } = require('./mod-scores');
const identity = require('./identity');
const { fetchMarketSnapshots } = require('../../utils/formulaRegistry/dataFetcherMarket');

async function getWhatsMoving(userId, { limit = 10 } = {}) {
  const { empty, holdings } = await resolveHoldings(userId);

  // Invested portfolio has holdings → real book.
  if (!empty && holdings.length > 0) {
    return buildFeed(holdings, { limit, holdingsType: 'holdings' });
  }

  // Invested portfolio empty → fall back to shadow/tracker holdings (watchlist feed).
  const trackers = await resolveShadowHoldings(userId);
  if (trackers.length === 0) return { items: [], holdings_type: 'holdings' };

  return buildFeed(trackers, { limit, holdingsType: 'trackers' });
}

/**
 * Build the movement feed from a unified holdings list.
 *
 * For 'trackers' (shadow) the symbols are watched, not held — invested_value is 0
 * for every row, so book-weight is meaningless and each item is surfaced with
 * held=false ("Watching · not held.").
 */
async function buildFeed(holdings, { limit, holdingsType }) {
  const isTrackers = holdingsType === 'trackers';

  const tickers = holdings.map(h => h.ticker);
  // Trackers are watched, not held — leave holdingByTicker empty so held=false.
  const holdingByTicker = isTrackers ? new Map() : new Map(holdings.map(h => [h.ticker, h]));
  const totalInvested = holdings.reduce((s, h) => s + (h.invested_value || 0), 0) || 1;

  const [snaps, modMap, scoreDeltas] = await Promise.all([
    fetchMarketSnapshots(prisma, tickers),
    fetchModScores(tickers),
    fetchScoreDeltas(tickers),
  ]);

  const items = [];

  // ── Score-movement items (from IIT composite WoW delta) ─────────────────────
  for (const t of tickers) {
    const delta = scoreDeltas[t];
    if (!delta || delta.curr == null || delta.prev == null) continue;
    const diff = Math.round(delta.curr) - Math.round(delta.prev);
    if (diff === 0) continue;

    items.push(buildItem({
      symbol: t, snaps, holdingByTicker, totalInvested, modMap,
      kind: diff > 0 ? 'score_upgrade' : 'score_downgrade',
      headline_label: `QC score ${diff > 0 ? 'upgraded' : 'downgraded'}`,
      headline_detail: `${Math.round(delta.prev)} → ${Math.round(delta.curr)}`,
      body: bestModTakeaway(modMap[t]) || `Composite QC score moved ${diff > 0 ? 'up' : 'down'} ${Math.abs(diff)} pts week over week.`,
      sortKey: Math.abs(diff),
    }));
  }

  // ── Upcoming/recent earnings items ──────────────────────────────────────────
  const earnings = await fetchRecentEarnings(tickers);
  for (const e of earnings) {
    items.push(buildItem({
      symbol: e.ticker, snaps, holdingByTicker, totalInvested, modMap,
      kind: 'earnings',
      headline_label: 'Earnings call',
      headline_detail: [e.fiscal_year, e.quarter].filter(Boolean).join(' '),
      body: `${e.quarter ?? ''} ${e.fiscal_year ?? ''} results available.`.trim(),
      sortKey: 0.5, // rank below strong score moves but above ties
    }));
  }

  items.sort((a, b) => b._sortKey - a._sortKey);
  return {
    holdings_type: holdingsType,
    items: items.slice(0, limit).map(({ _sortKey, ...rest }) => rest),
  };
}

/** Two most-recent weekly composite scores per ticker → { prev, curr }. */
async function fetchScoreDeltas(tickers) {
  const symbols = [...new Set(tickers.map(t => t.toUpperCase()))];
  const rows = await prisma.$queryRaw`
    SELECT ticker, composite_score::float AS score, rn
    FROM (
      SELECT ticker, composite_score,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY week_date DESC) AS rn
      FROM iit_weekly_stock_scores
      WHERE ticker = ANY(${symbols}) AND composite_score IS NOT NULL
    ) sub
    WHERE rn <= 2
  `;
  const map = {};
  for (const row of rows) {
    const sym = row.ticker.toUpperCase();
    if (!map[sym]) map[sym] = { curr: null, prev: null };
    if (Number(row.rn) === 1) map[sym].curr = row.score;
    else                      map[sym].prev = row.score;
  }
  return map;
}

/**
 * Latest earnings call per held ticker, kept only if reasonably recent.
 *
 * `earnings_calls.call_date` is a free-text "MMM YYYY" string (not date-filterable
 * in SQL), so we order by `id` (the call_id, format TICKER_FYYYYY_QX, which sorts
 * chronologically — same convention as analysis.service.js) and parse call_date
 * client-side for the recency cut-off.
 */
async function fetchRecentEarnings(tickers) {
  const symbols = [...new Set(tickers.map(t => t.toUpperCase()))];
  const rows = await prisma.earnings_calls.findMany({
    where:   { company: { in: symbols } },
    orderBy: { id: 'desc' },
    select:  { company: true, fiscal_year: true, quarter: true, call_date: true },
  });

  const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const t = r.company.toUpperCase();
    if (seen.has(t)) continue;      // rows are call_id-desc → first seen is latest
    seen.add(t);
    const when = parseMonthYear(r.call_date);
    if (when != null && when < cutoff) continue; // stale — skip
    out.push({ ticker: t, fiscal_year: r.fiscal_year, quarter: r.quarter, call_date: r.call_date });
  }
  return out;
}

/** Parse a "MMM YYYY" string (e.g. "Nov 2025") → epoch ms, or null if unparseable. */
function parseMonthYear(s) {
  if (!s) return null;
  const t = Date.parse(`01 ${s}`);
  return Number.isNaN(t) ? null : t;
}

function buildItem({ symbol, snaps, holdingByTicker, totalInvested, modMap, kind, headline_label, headline_detail, body, sortKey }) {
  const snap  = snaps[symbol] ?? null;
  const price = snap?.close ?? null;
  const price_change_pct = (snap?.close != null && snap?.prevClose != null && snap.prevClose !== 0)
    ? round2((snap.close - snap.prevClose) / snap.prevClose * 100)
    : null;

  const held = holdingByTicker.has(symbol);
  const h    = holdingByTicker.get(symbol);
  const weightPct = held ? round1((h.invested_value || 0) / totalInvested * 100) : null;
  const holding_detail = held
    ? (h.quantity != null
        ? `You hold ${trimNum(h.quantity)} shares · ${weightPct}% of equity book.`
        : `${weightPct}% of equity book.`)
    : 'Watching · not held.';

  const qc_score = bestModScore(modMap[symbol]);

  return {
    _sortKey: sortKey,
    id:              `${symbol}-${kind}`,
    symbol,
    price,
    price_change_pct,
    kind,
    headline_label,
    headline_detail,
    body,
    qc_score,
    held,
    holding_detail,
    cta_label:       kind === 'earnings' ? 'Brief' : 'Open',
    href:            `/screener/management?symbol=${symbol}`,
  };
}

function bestModScore(mod) {
  if (!mod) return null;
  return mod.management?.score ?? mod.opportunity?.score ?? mod.deal?.score ?? null;
}
function bestModTakeaway() { return null; } // insight.takeaway not selected in bulk query; kept for extension

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function trimNum(n) { return Number.isInteger(n) ? n : Math.round(n * 100) / 100; }

module.exports = { getWhatsMoving };
