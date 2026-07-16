'use strict';

/**
 * GET /api/discover/screens
 *
 * Curated screener cards personalised to the user's sectors.
 *
 * Reads the precomputed screens in qc_screens / qc_screen_tickers (seeded by
 * prisma/seedScreens.js) rather than running the live screeners in
 * controllers/baskets.controller.js. Those derive membership from the full
 * universe on every call — 5 years x 76 KPIs x ~2900 companies out of
 * prowess_values_new per screen — which cost ~40s+ for the three cards here, to
 * render what the UI shows as three counts per card. Membership only moves when
 * fundamentals are refreshed, so it is computed offline and served as an
 * indexed read. Re-run the seed to refresh.
 *
 * The "IN YOUR SECTORS" stat stays per-user: it intersects each screen's stored
 * basic_industry values with the industries the user actually holds.
 */

const prisma = require('../../config/prisma');
const { resolveHoldings } = require('./resolve-holdings.service');
const identity = require('./identity');

const QC_SCORE_THRESHOLD = 75;

async function getDiscoverScreens(userId) {
  // User's held industries (for the personalised "IN YOUR SECTORS" stat) and the
  // curated screens are independent — fetch concurrently.
  const [holdingsResult, screens] = await Promise.all([
    resolveHoldings(userId).catch(() => ({ holdings: [] })),
    prisma.screen.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        tickers: {
          select: { qcScore: true, basicIndustry: true },
        },
      },
    }),
  ]);

  const userIndustries = new Set(
    (holdingsResult.holdings || [])
      .map(h => identity.lookup(h.ticker)?.basicIndustry)
      .filter(Boolean)
  );

  return {
    screens: screens.map(screen => {
      const names = screen.tickers.length;
      const highScore = screen.tickers.filter(t => t.qcScore != null && t.qcScore > QC_SCORE_THRESHOLD).length;
      const inYourSectors = userIndustries.size
        ? screen.tickers.filter(t => t.basicIndustry && userIndustries.has(t.basicIndustry)).length
        : 0;

      return {
        id:          screen.slug,
        icon:        screen.icon,
        badge_label: `${names} NAMES`,
        badge_kind:  screen.badgeKind,
        title:       screen.title,
        description: screen.description,
        stats: [
          { value: names,         label: 'NAMES' },
          { value: highScore,     label: `QC SCORE >${QC_SCORE_THRESHOLD}` },
          { value: inYourSectors, label: 'IN YOUR SECTORS' },
        ],
        href: screen.href,
      };
    }),
  };
}

module.exports = { getDiscoverScreens };
