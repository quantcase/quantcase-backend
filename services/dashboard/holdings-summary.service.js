'use strict';

/**
 * GET /api/portfolio/summary
 *
 * Top-line valuation + cap/sector allocation for the Holdings panel. Computed
 * server-side so client and server agree.
 *
 * Fidelity note: full valuation (equity_value, today's change, value_trend) is
 * exact for smallcase-connected users (share quantity available). First-party
 * CSV portfolios have no quantity, so those figures are approximated from the
 * cost basis — see resolve-holdings.service.js.
 */

const prisma = require('../../config/prisma');
const { resolveHoldings } = require('./resolve-holdings.service');
const { resolveShadowHoldings, getShadowSyncedAt } = require('./resolve-shadow-holdings.service');
const identity = require('./identity');
const { fetchMarketSnapshots, fetchMonthlyClose } = require('../../utils/formulaRegistry/dataFetcherMarket');

const TREND_MONTHS = 12;

async function getHoldingsSummary(userId) {
  const resolved = await resolveHoldings(userId);

  // Invested portfolio empty → fall back to shadow/tracker holdings.
  if (resolved.empty || resolved.holdings.length === 0) {
    const trackers = await resolveShadowHoldings(userId);
    if (trackers.length === 0) return { empty: true, holdings_type: 'holdings' };
    return buildTrackerSummary(userId, trackers);
  }

  const { source, synced_at, holdings, totals } = resolved;
  const tickers = holdings.map(h => h.ticker);

  const snaps = await fetchMarketSnapshots(prisma, tickers);

  // ── Today's change: Σ qty × (close − prevClose) when quantity is known ───────
  let todayChange = 0;
  let todayComputable = false;
  for (const h of holdings) {
    const snap = snaps[h.ticker];
    if (h.quantity != null && snap?.close != null && snap?.prevClose != null) {
      todayChange += h.quantity * (snap.close - snap.prevClose);
      todayComputable = true;
    }
  }

  const equityValue   = totals.current_value ?? totals.invested_value;
  const investedValue = totals.invested_value;
  const prevValue     = todayComputable ? equityValue - todayChange : null;
  const today_change_value = todayComputable ? Math.round(todayChange) : null;
  const today_change_pct   = (todayComputable && prevValue) ? round2(todayChange / prevValue * 100) : null;

  // ── Allocation segments (cap + industry) ────────────────────────────────────
  const cap_segments      = buildSegments(holdings, h => identity.lookup(h.ticker)?.capLabel || 'Unclassified');
  const industry_segments = buildIndustrySegments(holdings);

  // ── Value trend (monthly) + 6m / ytd returns ────────────────────────────────
  const { value_trend, return_6m_pct, ytd_change_pct } = await buildValueTrend(holdings, source);

  return {
    empty:              false,
    holdings_type:      'holdings',
    source, // 'smallcase' | 'firstparty' — lets the FE know when figures are approximate
    stock_count:        holdings.length,
    fund_count:         0, // mutual-fund holdings not modeled yet (see delivery notes)
    synced_at:          synced_at ? new Date(synced_at).toISOString() : null,
    equity_value:       Math.round(equityValue),
    invested_value:     Math.round(investedValue),
    today_change_value,
    today_change_pct,
    ytd_change_pct,
    return_6m_pct,
    value_trend,
    cap_segments,
    industry_segments,
  };
}

/**
 * Tracker fallback: shadow holdings have no cost basis (amount_invested is 0),
 * so valuation is limited to what live market_data affords. Allocation is by
 * tracker count (equal weight) rather than invested value.
 */
async function buildTrackerSummary(userId, trackers) {
  const synced_at = await getShadowSyncedAt(userId);
  const n = trackers.length;

  // Equal-weighted "today's change %": simple mean of each tracker's 1D move.
  const moves = trackers.map(t => t.market_data?.change_percent).filter(v => v != null);
  const today_change_pct = moves.length
    ? round2(moves.reduce((s, v) => s + v, 0) / moves.length)
    : null;

  // No invested value → value-based fields are meaningless. Weight allocation by count.
  const cap_segments      = buildCountSegments(trackers, t => identity.lookup(t.ticker)?.capLabel || 'Unclassified');
  const industry_segments = rollupIndustry(buildCountSegments(trackers, t => identity.lookup(t.ticker)?.basicIndustry || 'Other'));

  return {
    empty:              false,
    holdings_type:      'trackers',
    source:             'shadow',
    stock_count:        n,
    fund_count:         0,
    synced_at:          synced_at ? new Date(synced_at).toISOString() : null,
    equity_value:       null,   // zero-cost watchlist — no market value without quantity/cost
    invested_value:     0,
    today_change_value: null,
    today_change_pct,
    ytd_change_pct:     null,
    return_6m_pct:      null,
    value_trend:        [],
    cap_segments,
    industry_segments,
  };
}

/** Count-weighted bucketing → [{ label, value:0, count, pct }] sorted largest-first. */
function buildCountSegments(holdings, labelFn) {
  const buckets = new Map();
  const total = holdings.length || 1;
  for (const h of holdings) {
    const label = labelFn(h);
    const b = buckets.get(label) ?? { label, value: 0, count: 0 };
    b.count += 1;
    buckets.set(label, b);
  }
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .map(s => ({ label: s.label, value: 0, count: s.count, pct: Math.round(s.count / total * 100) }));
}

/** Roll everything past the top 5 into a single "Other" bucket. */
function rollupIndustry(segs) {
  if (segs.length <= 6) return segs;
  const top   = segs.slice(0, 5);
  const other = segs.slice(5).reduce(
    (acc, s) => ({ label: 'Other', value: 0, count: acc.count + s.count, pct: acc.pct + s.pct }),
    { label: 'Other', value: 0, count: 0, pct: 0 }
  );
  return [...top, other];
}

/** Generic bucketing → [{ label, value, count, pct }] sorted largest-first. */
function buildSegments(holdings, labelFn) {
  const buckets = new Map();
  let total = 0;
  for (const h of holdings) {
    const label = labelFn(h);
    const value = h.current_value ?? h.invested_value ?? 0;
    total += value;
    const b = buckets.get(label) ?? { label, value: 0, count: 0 };
    b.value += value;
    b.count += 1;
    buckets.set(label, b);
  }
  const segs = [...buckets.values()].sort((a, b) => b.value - a.value);
  return segs.map(s => ({
    label: s.label,
    value: Math.round(s.value),
    count: s.count,
    pct:   total > 0 ? Math.round(s.value / total * 100) : 0,
  }));
}

/** Industry segments: top 5 by value + a rolled-up "Other" bucket. */
function buildIndustrySegments(holdings) {
  const all = buildSegments(holdings, h => identity.lookup(h.ticker)?.basicIndustry || 'Other');
  if (all.length <= 6) return all;

  const top   = all.slice(0, 5);
  const rest  = all.slice(5);
  const other = rest.reduce(
    (acc, s) => ({ label: 'Other', value: acc.value + s.value, count: acc.count + s.count, pct: acc.pct + s.pct }),
    { label: 'Other', value: 0, count: 0, pct: 0 }
  );
  return [...top, other];
}

/**
 * Monthly value trend + 6-month / YTD returns.
 * For smallcase (quantity known): Σ qty × monthlyClose per month.
 * For first-party (no quantity): approximate with an equal-weighted index of
 * each holding's monthly close normalised to its cost basis.
 */
async function buildValueTrend(holdings, source) {
  const since = new Date(Date.now() - (TREND_MONTHS + 1) * 30 * 24 * 60 * 60 * 1000);

  const series = await Promise.all(
    holdings.map(async h => ({
      holding: h,
      monthly: await fetchMonthlyClose(prisma, h.ticker, { since }),
    }))
  );

  // Union of month buckets across holdings.
  const monthSet = new Set();
  for (const s of series) for (const m of s.monthly) monthSet.add(iso(m.month));
  const months = [...monthSet].sort();

  // Per-holding month → close map.
  const closeMaps = series.map(s => {
    const map = new Map();
    for (const m of s.monthly) map.set(iso(m.month), m.close);
    return { holding: s.holding, map };
  });

  const value_trend = months.map(month => {
    let value = 0;
    for (const { holding, map } of closeMaps) {
      const close = map.get(month);
      if (close == null) continue;
      if (holding.quantity != null) {
        value += holding.quantity * close;
      } else {
        // First-party approximation: cost basis scaled by close/latestClose.
        const latest = lastValue(map);
        if (latest) value += holding.invested_value * (close / latest);
      }
    }
    return { date: month, value: Math.round(value) };
  }).filter(pt => pt.value > 0);

  const return_6m_pct  = pctChange(value_trend, 6);
  const ytd_change_pct = ytdChange(value_trend);

  return { value_trend, return_6m_pct, ytd_change_pct };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function iso(d) { return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10); }
function lastValue(map) { let v = null; for (const val of map.values()) if (val != null) v = val; return v; }
function round2(n) { return Math.round(n * 100) / 100; }

function pctChange(trend, monthsBack) {
  if (trend.length < 2) return null;
  const last = trend[trend.length - 1];
  const idx  = Math.max(0, trend.length - 1 - monthsBack);
  const base = trend[idx];
  if (!base?.value) return null;
  return round2((last.value - base.value) / base.value * 100);
}

function ytdChange(trend) {
  if (trend.length < 2) return null;
  const last = trend[trend.length - 1];
  const year = last.date.slice(0, 4);
  // First point in the current calendar year (or earliest available).
  const base = trend.find(pt => pt.date.slice(0, 4) === year) ?? trend[0];
  if (!base?.value || base === last) return null;
  return round2((last.value - base.value) / base.value * 100);
}

module.exports = { getHoldingsSummary };
