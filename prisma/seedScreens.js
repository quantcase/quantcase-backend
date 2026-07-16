'use strict';

/**
 * Seeds qc_screens / qc_screen_tickers from the live screeners.
 *
 * Run:  node prisma/seedScreens.js            # seed the dashboard's 3 cards
 *       node prisma/seedScreens.js --all      # seed every basket in BASKETS
 *
 * This does the expensive work ONCE (each screener scans the full universe out of
 * prowess_values_new, ~11-13s a piece) so that GET /api/discover/screens can serve
 * an indexed read instead of recomputing it per request. Re-run after fundamentals
 * are refreshed; screen membership only moves when the underlying data does.
 *
 * Idempotent: re-running replaces each screen's ticker list in a transaction.
 */

const prisma = require('../config/prisma');
const peerIdentity = require('../lib/peerIdentity');
const { BASKETS, SCREENERS, runScreener } = require('../controllers/baskets.controller');

// Card presentation for the dashboard's three screens. Anything not listed here
// still seeds under --all, using its basket definition for title/description.
const CARD_META = {
  'quality-compounders-at-a-discount': {
    slug: 'quality-compounders',
    icon: 'activity',
    badgeKind: 'warning',
    title: 'Quality compounders — cheap vs history & industry',
    description: 'Long-term earnings growth with strong ROE and low debt, trading below its own historical PE and industry average.',
    href: '/screener/home?screen=quality-compounders',
    sortOrder: 1,
  },
  'cheap-on-book-strong-returns': {
    slug: 'cash-rich-growing',
    icon: 'trending-up',
    badgeKind: 'new',
    title: 'Cheap on book, strong returns',
    description: 'Trading below 2x book value with ROE and ROCE above 12%, low debt and healthy cash conversion.',
    href: '/screener/home?screen=cash-rich-growing',
    sortOrder: 2,
  },
  'near-lows-quality-intact': {
    slug: '52w-lows',
    icon: 'refresh',
    badgeKind: 'info',
    title: '52-week lows — fundamentals intact',
    description: 'Trading near its 52-week low and 50%+ below all-time high, but still profitable with strong capital returns.',
    href: '/screener/home?screen=52w-lows',
    sortOrder: 3,
  },
};

/** Latest composite score per ticker, for the "QC SCORE >75" stat. */
async function fetchQcScores(symbols) {
  if (!symbols.length) return {};
  const upper = [...new Set(symbols.map(s => s.toUpperCase()))];
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (ticker) ticker, composite_score::float AS score
    FROM iit_weekly_stock_scores
    WHERE ticker = ANY(${upper}) AND composite_score IS NOT NULL
    ORDER BY ticker, week_date DESC
  `;
  return Object.fromEntries(rows.map(r => [r.ticker, r.score]));
}

async function seedScreen(basketId, meta) {
  const basket = BASKETS.find(b => b.id === basketId);
  const started = Date.now();

  const stocks = (await runScreener(basketId)) ?? [];
  const symbols = stocks.map(s => s.symbol).filter(Boolean);
  const qcScores = await fetchQcScores(symbols);

  const slug = meta?.slug ?? basketId;
  const data = {
    slug,
    basketId,
    category:    basket?.category ?? null,
    icon:        meta?.icon ?? null,
    badgeKind:   meta?.badgeKind ?? null,
    title:       meta?.title ?? basket?.title ?? basketId,
    description: meta?.description ?? basket?.description ?? null,
    conditions:  basket?.conditions ?? null,
    href:        meta?.href ?? `/screener/home?screen=${slug}`,
    sortOrder:   meta?.sortOrder ?? 99,
    isActive:    true,
    computedAt:  new Date(),
  };

  const rows = stocks.map((s, i) => {
    const ident = peerIdentity.getIdentity(s.symbol);
    return {
      ticker:        s.symbol,
      companyName:   s.companyName ?? ident?.companyName ?? null,
      marketCapCr:   s.marketCapCr ?? null,
      pe:            s.pe ?? null,
      qcScore:       qcScores[s.symbol.toUpperCase()] ?? null,
      basicIndustry: ident?.basicIndustry ?? null,
      sortOrder:     i,
    };
  });

  await prisma.$transaction(async tx => {
    const screen = await tx.screen.upsert({
      where: { slug }, create: data, update: data,
    });
    // Replace membership wholesale — simpler and safer than diffing.
    await tx.screenTicker.deleteMany({ where: { screenId: screen.id } });
    if (rows.length) {
      await tx.screenTicker.createMany({
        data: rows.map(r => ({ ...r, screenId: screen.id })),
        skipDuplicates: true,
      });
    }
  }, { timeout: 60000 });

  const withScore = rows.filter(r => r.qcScore > 75).length;
  console.log(`  ✔ ${slug.padEnd(28)} ${String(rows.length).padStart(4)} names  ` +
              `${String(withScore).padStart(3)} qc>75   (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return rows.length;
}

async function main() {
  const all = process.argv.includes('--all');
  const ids = all
    ? BASKETS.map(b => b.id).filter(id => SCREENERS[id])
    : Object.keys(CARD_META);

  console.log(`Seeding ${ids.length} screen(s)${all ? ' (--all)' : ''}…\n`);
  const t0 = Date.now();
  let total = 0;
  for (const id of ids) {
    try {
      total += await seedScreen(id, CARD_META[id]);
    } catch (err) {
      console.error(`  ✘ ${id} failed: ${err.message}`);
    }
  }
  console.log(`\nDone: ${total} tickers across ${ids.length} screens in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
