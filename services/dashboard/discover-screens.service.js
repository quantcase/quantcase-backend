'use strict';

/**
 * GET /api/discover/screens
 *
 * Curated screener cards personalised to the user's sectors. Reuses the existing
 * Prowess-backed basket screeners (controllers/baskets.controller.js) to compute
 * real counts, then adds an "IN YOUR SECTORS" stat by intersecting each screen's
 * results with the industries the user holds.
 */

const prisma = require('../../config/prisma');
const { resolveHoldings } = require('./resolve-holdings.service');
const identity = require('./identity');
const { SCREENERS, buildSymbolIndex } = require('../../controllers/baskets.controller');
const prowess = require('../../lib/prowess');

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
const CARDS = [
  {
    id: 'promoter-buying',
    basketId: 'promoter-buying-signal',
    icon: 'activity',
    badge_kind: 'warning',
    title: 'Promoter buying — material disclosures',
    description: 'Promoters increased their own stake at valuations below the 3-year average.',
    high_score_metric: 'QC SCORE >75',
    href: '/screener/home?screen=promoter-buying',
  },
  {
    id: 'cash-rich-growing',
    basketId: 'value-buying',
    icon: 'trending-up',
    badge_kind: 'new',
    title: 'Cash-rich & growing',
    description: 'Low P/E and P/B with positive free cash flow and healthy return on equity.',
    high_score_metric: 'QC SCORE >75',
    href: '/screener/home?screen=cash-rich-growing',
  },
  {
    id: '52w-lows',
    basketId: 'market-crash-bargains',
    icon: 'refresh',
    badge_kind: 'info',
    title: '52-week lows — fundamentals intact',
    description: 'Quality names down sharply from highs on market fear, not deteriorating fundamentals.',
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

  // Prowess data is loaded once and shared across all screens.
  const { companyMap, nameToSymbol } = buildSymbolIndex();
  const shData = prowess.loadShareholdingData();

  const screens = await Promise.all(CARDS.map(async card => {
    const runner = SCREENERS[card.basketId];
    let stocks = [];
    try {
      stocks = runner ? runner(companyMap, nameToSymbol, shData) : [];
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
