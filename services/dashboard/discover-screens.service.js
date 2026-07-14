'use strict';

/**
 * GET /api/discover/screens
 *
 * Curated screener cards personalised to the user's sectors. Reuses the existing
 * basket screeners (controllers/baskets.controller.js) to compute real counts,
 * then adds an "IN YOUR SECTORS" stat by intersecting each screen's results with
 * the industries the user holds.
 */

const prisma = require('../../config/prisma');
const { resolveHoldings } = require('./resolve-holdings.service');
const identity = require('./identity');
const { runScreener } = require('../../controllers/baskets.controller');

const QC_SCORE_THRESHOLD = 75;

/** Latest IIT composite score per symbol → count above threshold. */
async function countHighScore(symbols) {
  if (!symbols.length) return 0;
  const upper = [...new Set(symbols.map(s => s.toUpperCase()))];
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (ticker) ticker, composite_score::float AS score
    FROM iit_weekly_stock_scores
    WHERE ticker = ANY(${upper}) AND composite_score IS NOT NULL
    ORDER BY ticker, week_date DESC
  `;
  return rows.filter(r => r.score != null && r.score > QC_SCORE_THRESHOLD).length;
}

// The dashboard surfaces a small, fixed set of cards (icon keys agreed with FE).
// Basket ids below correspond to the 11 screens in controllers/baskets.controller.js
// ("Screens for Quantcase.txt"). The old basket ids these cards pointed at
// (promoter-buying-signal, value-buying, market-crash-bargains) no longer exist —
// remapped to the closest equivalents in the new set.
const CARDS = [
  {
    id: 'quality-compounders',
    basketId: 'quality-compounders-at-a-discount',
    icon: 'activity',
    badge_kind: 'warning',
    title: 'Quality compounders — cheap vs history & industry',
    description: 'Long-term earnings growth with strong ROE and low debt, trading below its own historical PE and industry average.',
    high_score_metric: 'QC SCORE >75',
    href: '/screener/home?screen=quality-compounders',
  },
  {
    id: 'cash-rich-growing',
    basketId: 'cheap-on-book-strong-returns',
    icon: 'trending-up',
    badge_kind: 'new',
    title: 'Cheap on book, strong returns',
    description: 'Trading below 2x book value with ROE and ROCE above 12%, low debt and healthy cash conversion.',
    high_score_metric: 'QC SCORE >75',
    href: '/screener/home?screen=cash-rich-growing',
  },
  {
    id: '52w-lows',
    basketId: 'near-lows-quality-intact',
    icon: 'refresh',
    badge_kind: 'info',
    title: '52-week lows — fundamentals intact',
    description: 'Trading near its 52-week low and 50%+ below all-time high, but still profitable with strong capital returns.',
    high_score_metric: 'QC SCORE >75',
    href: '/screener/home?screen=52w-lows',
  },
];

async function getDiscoverScreens(userId) {
  // User's held industries (for the personalised "IN YOUR SECTORS" stat).
  const { holdings } = await resolveHoldings(userId).catch(() => ({ holdings: [] }));
  const userIndustries = new Set(
    (holdings || [])
      .map(h => identity.lookup(h.ticker)?.basicIndustry)
      .filter(Boolean)
  );

  const screens = await Promise.all(CARDS.map(async card => {
    let stocks = [];
    try {
      stocks = (await runScreener(card.basketId)) ?? [];
    } catch {
      stocks = [];
    }

    const names   = stocks.length;
    const symbols = stocks.map(s => s.symbol).filter(Boolean);

    const [highScore] = await Promise.all([countHighScore(symbols)]);
    const inYourSectors = userIndustries.size
      ? stocks.filter(s => {
          const ind = identity.lookup(s.symbol)?.basicIndustry;
          return ind && userIndustries.has(ind);
        }).length
      : 0;

    return {
      id:          card.id,
      icon:        card.icon,
      badge_label: `${names} NAMES`,
      badge_kind:  card.badge_kind,
      title:       card.title,
      description: card.description,
      stats: [
        { value: names,         label: 'NAMES' },
        { value: highScore,     label: card.high_score_metric },
        { value: inYourSectors, label: 'IN YOUR SECTORS' },
      ],
      href: card.href,
    };
  }));

  return { screens };
}

module.exports = { getDiscoverScreens };
