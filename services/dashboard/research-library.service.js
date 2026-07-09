'use strict';

/**
 * GET /api/research-library/summary
 *
 * Counts for the research-library banner, scoped to the user's book.
 *
 * Note: there is no per-user "last visit" tracking, so `new_ic_notes` counts
 * AI insights refreshed for held tickers in the last NEW_WINDOW_DAYS. There is
 * also no forward earnings-calendar table, and earnings_calls.call_date is a
 * free-text "MMM YYYY" string (not date-filterable), so `catalysts_next_30_days`
 * counts held tickers whose most recent earnings call is within CATALYST_WINDOW_DAYS
 * (parsed client-side) — a proxy for "active catalysts". Both are documented proxies.
 */

const prisma = require('../../config/prisma');
const { resolveHoldings } = require('./resolve-holdings.service');

const NEW_WINDOW_DAYS      = 7;
const CATALYST_WINDOW_DAYS = 30;
const DEFAULT_SUBTITLE      = 'DRHP verdicts, management commentary & thesis updates';

async function getResearchLibrarySummary(userId) {
  const { holdings } = await resolveHoldings(userId).catch(() => ({ holdings: [] }));
  const tickers = [...new Set((holdings || []).map(h => h.ticker.toUpperCase()))];

  if (tickers.length === 0) {
    return { new_ic_notes: 0, catalysts_next_30_days: 0, subtitle: DEFAULT_SUBTITLE };
  }

  const newSince = new Date(Date.now() - NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [new_ic_notes, callRows] = await Promise.all([
    prisma.aiInsight.count({
      where: { ticker: { in: tickers }, updated_at: { gte: newSince } },
    }),
    // Latest call per ticker (call_id-desc), call_date parsed client-side.
    prisma.earnings_calls.findMany({
      where:   { company: { in: tickers } },
      orderBy: { id: 'desc' },
      select:  { company: true, call_date: true },
    }),
  ]);

  const cutoff = Date.now() - CATALYST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set();
  let catalysts_next_30_days = 0;
  for (const r of callRows) {
    const t = r.company.toUpperCase();
    if (seen.has(t)) continue;
    seen.add(t);
    const when = parseMonthYear(r.call_date);
    if (when != null && when >= cutoff) catalysts_next_30_days += 1;
  }

  return { new_ic_notes, catalysts_next_30_days, subtitle: DEFAULT_SUBTITLE };
}

/** Parse a "MMM YYYY" string (e.g. "Nov 2025") → epoch ms, or null if unparseable. */
function parseMonthYear(s) {
  if (!s) return null;
  const t = Date.parse(`01 ${s}`);
  return Number.isNaN(t) ? null : t;
}

module.exports = { getResearchLibrarySummary };
