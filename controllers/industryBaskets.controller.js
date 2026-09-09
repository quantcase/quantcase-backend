'use strict';

const prisma         = require('../config/prisma');
const cache          = require('../lib/cache');
const classification = require('../config/iitClassification.json');

// ── Industry basket definitions ───────────────────────────────────────────────
// Each basket groups related basic_industry values under a common theme.
// `etfTicker` is the suggested ETF vehicle shown on the UI card.
// `signal_thresholds` drives BUY / WAIT / AVOID from composite_score + velocity.

const INDUSTRY_BASKETS = [
  {
    id: 'private-banks',
    title: 'Private Banks',
    etfTicker: 'PVTBNK ETF',
    description: 'Private sector commercial banks — retail lending, corporate credit, CASA growth.',
    category: 'Financial Services',
    industries: ['Private Sector Bank'],
  },
  {
    id: 'capital-goods',
    title: 'Capital Goods',
    etfTicker: 'INFRA ETF',
    description: 'Engineering, heavy machinery, and infrastructure capex plays benefiting from government spending.',
    category: 'Industrials',
    industries: [
      'Heavy Electrical Equipment',
      'Cables - Electricals',
      'Compressors, Pumps & Diesel Engines',
      'Castings & Forgings',
      'Construction Vehicles',
      'Abrasives & Bearings',
      'Explosives',
    ],
  },
  {
    id: 'fmcg-foods',
    title: 'FMCG — Foods',
    etfTicker: 'FMCG ETF',
    description: 'Packaged food, dairy, edible oil and consumer staples with steady demand regardless of economic cycle.',
    category: 'FMCG',
    industries: [
      'Diversified FMCG',
      'Dairy Products',
      'Edible Oil',
      'Animal Feed',
      'Cigarettes & Tobacco Products',
      'Breweries & Distilleries',
    ],
  },
  {
    id: 'it-services',
    title: 'IT Services',
    etfTicker: 'ITBEES ETF',
    description: 'Large-cap IT services and software consulting companies exporting technology services globally.',
    category: 'Information Technology',
    industries: [
      'Computers - Software & Consulting',
      'BPO/KPO',
    ],
  },
  {
    id: 'chemicals',
    title: 'Chemicals',
    etfTicker: 'CHEMX ETF',
    description: 'Specialty and commodity chemicals serving pharma, agriculture, and industrial end-markets.',
    category: 'Chemicals',
    industries: [
      'Specialty Chemicals',
      'Commodity Chemicals',
      'Dyes And Pigments',
      'Carbon Black',
      'Fertilizers',
    ],
  },
  {
    id: 'real-estate',
    title: 'Real Estate',
    etfTicker: 'HOUSING ETF',
    description: 'Residential and commercial real estate developers, REITs, and housing finance companies.',
    category: 'Real Estate',
    industries: [
      'Real Estate Investment Trust (REIT)',
      'Real Estate Developer',
    ],
  },
  {
    id: 'power-generation',
    title: 'Power Gen',
    etfTicker: 'PSUINFRA ETF',
    description: 'Public sector power generators, transmission utilities, and energy infrastructure operators.',
    category: 'Energy',
    industries: [
      'Power Generation',
      'Power Transmission',
      'Coal',
    ],
  },
  {
    id: 'telecom',
    title: 'Telecom',
    etfTicker: 'TELECOM ETF',
    description: 'Telecom operators and tower companies with recurring revenue from voice, data, and enterprise services.',
    category: 'Telecom',
    industries: [
      'Telecommunication - Service Provider',
      'Telecommunication - Equipment',
    ],
  },
];

// ── Signal derivation ─────────────────────────────────────────────────────────
// Derives BUY / WAIT / AVOID from the aggregated cluster metrics for a basket.
//
// Logic (mirrors the spirit of the IIT rotation detector):
//   BUY  — composite_score ≥ 60 AND velocity_3w ≥ 0  (strong and not falling)
//   AVOID — composite_score < 40 OR velocity_3w <= -4  (weak or deteriorating)
//   WAIT  — everything else

function deriveSignal(compositeScore, velocity3w) {
  if (compositeScore == null) return 'WAIT';
  const score = parseFloat(compositeScore);
  const vel   = velocity_3w_safe(velocity3w);

  if (score >= 60 && vel >= 0)   return 'BUY';
  if (score < 40  || vel <= -4)  return 'AVOID';
  return 'WAIT';
}

function velocity_3w_safe(v) {
  if (v == null) return 0;
  const n = parseInt(v);
  return isNaN(n) ? 0 : n;
}

// ── Aggregate cluster rows for a basket ───────────────────────────────────────
// Multiple basic_industry rows roll up into one basket-level snapshot.
// We take the median composite_score and sum the stock counts.

function aggregateBasketMetrics(clusterRows) {
  if (!clusterRows.length) return null;

  const scores = clusterRows
    .map(r => r.composite_score != null ? parseFloat(r.composite_score) : null)
    .filter(s => s != null)
    .sort((a, b) => a - b);

  const medianScore = scores.length
    ? scores[Math.floor(scores.length / 2)]
    : null;

  const velocity = clusterRows
    .map(r => r.velocity_3w != null ? parseInt(r.velocity_3w) : null)
    .filter(v => v != null);
  const avgVelocity = velocity.length
    ? Math.round(velocity.reduce((a, b) => a + b, 0) / velocity.length)
    : null;

  const breadths = clusterRows
    .map(r => r.breadth_pct != null ? parseFloat(r.breadth_pct) : null)
    .filter(b => b != null);
  const avgBreadth = breadths.length
    ? parseFloat((breadths.reduce((a, b) => a + b, 0) / breadths.length).toFixed(1))
    : null;

  const stockCount = clusterRows.reduce((sum, r) => sum + (r.stock_count ?? 0), 0);
  const ranks = clusterRows.map(r => r.rank).filter(r => r != null);
  const bestRank = ranks.length ? Math.min(...ranks) : null;

  return {
    composite_score: medianScore != null ? parseFloat(medianScore.toFixed(1)) : null,
    velocity_3w:     avgVelocity,
    breadth_pct:     avgBreadth,
    stock_count:     stockCount,
    best_rank:       bestRank,
    industry_count:  clusterRows.length,
  };
}

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/industry-baskets
 * Returns all industry basket definitions enriched with the latest IIT signal.
 * No pagination — the full list is small (8 baskets).
 */
async function getIndustryBaskets(req, res) {
  const data = await cache.getOrSet('qc:iit:industry-baskets', 86400, async () => {
    // Resolve latest scoring week
    const latestRow = await prisma.iitClusterScore.findFirst({
      orderBy: { week_date: 'desc' },
      select:  { week_date: true },
    });

    const weekDate = latestRow?.week_date ?? null;
    const asOfDate = weekDate ? weekDate.toISOString().slice(0, 10) : null;

    // Pull all cluster scores for the latest week in one query
    let clusterMap = {};
    if (weekDate) {
      const rows = await prisma.iitClusterScore.findMany({
        where: { week_date: weekDate },
        select: {
          basic_industry:  true,
          composite_score: true,
          velocity_3w:     true,
          breadth_pct:     true,
          stock_count:     true,
          rank:            true,
        },
      });
      for (const row of rows) {
        clusterMap[row.basic_industry] = row;
      }
    }

    const baskets = INDUSTRY_BASKETS.map(basket => {
      const matchedRows = basket.industries
        .map(ind => clusterMap[ind])
        .filter(Boolean);

      const metrics = aggregateBasketMetrics(matchedRows);
      const signal  = metrics
        ? deriveSignal(metrics.composite_score, metrics.velocity_3w)
        : 'WAIT';

      return {
        id:          basket.id,
        title:       basket.title,
        etfTicker:   basket.etfTicker,
        description: basket.description,
        category:    basket.category,
        industries:  basket.industries,
        signal,
        metrics,
      };
    });

    // Summary counts for the footer
    const buys   = baskets.filter(b => b.signal === 'BUY').length;
    const waits  = baskets.filter(b => b.signal === 'WAIT').length;
    const avoids = baskets.filter(b => b.signal === 'AVOID').length;

    return {
      as_of_date: asOfDate,
      summary: { buy: buys, wait: waits, avoid: avoids },
      baskets,
    };
  });

  res.json(data);
}

/**
 * GET /api/industry-baskets/:basketId/stocks
 * Returns constituent stocks for all industries in the basket.
 * Query params:
 *   page  (default 1)
 *   size  (default 50, max 200)
 *   sort  (field name, default 'composite_score')
 *   order ('asc' | 'desc', default 'desc')
 */
async function getIndustryBasketStocks(req, res) {
  const { basketId } = req.params;
  const basket = INDUSTRY_BASKETS.find(b => b.id === basketId);
  if (!basket) {
    return res.status(404).json({ error: `Industry basket '${basketId}' not found` });
  }

  // Resolve latest scoring week
  const latestRow = await prisma.iitClusterScore.findFirst({
    orderBy: { week_date: 'desc' },
    select:  { week_date: true },
  });

  if (!latestRow) {
    return res.status(404).json({ error: 'No IIT data available. Run the scoring job first.' });
  }

  const weekDate = latestRow.week_date;
  const asOfDate = weekDate.toISOString().slice(0, 10);

  // Fetch all constituent stocks for this basket's industries
  let stocks = await prisma.iitWeeklyStockScore.findMany({
    where: {
      week_date:      weekDate,
      basic_industry: { in: basket.industries },
    },
    select: {
      ticker:             true,
      basic_industry:     true,
      composite_score:    true,
      momentum_score:     true,
      growth_score:       true,
      profitability_score: true,
      balance_sheet_score: true,
      breadth_score:      true,
      sentiment_score:    true,
      valuation_score:    true,
      data_flags:         true,
    },
  });

  // Sorting
  const allowedSortFields = [
    'composite_score', 'momentum_score', 'growth_score', 'profitability_score',
    'balance_sheet_score', 'breadth_score', 'sentiment_score', 'valuation_score', 'ticker',
  ];
  const sortField = allowedSortFields.includes(req.query.sort) ? req.query.sort : 'composite_score';
  const order     = req.query.order === 'asc' ? 1 : -1;

  stocks.sort((a, b) => {
    const av = a[sortField] != null ? parseFloat(a[sortField]) : -Infinity;
    const bv = b[sortField] != null ? parseFloat(b[sortField]) : -Infinity;
    return (av < bv ? -1 : av > bv ? 1 : 0) * order;
  });

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const size  = Math.min(200, Math.max(1, parseInt(req.query.size) || 50));
  const total = stocks.length;
  const start = (page - 1) * size;
  const fmt = v => v != null ? parseFloat(parseFloat(v).toFixed(1)) : null;
  const items = stocks.slice(start, start + size).map(s => ({
    ticker:          s.ticker,
    basic_industry:  s.basic_industry,
    composite_score: fmt(s.composite_score),
    factors: {
      momentum:      fmt(s.momentum_score),
      growth:        fmt(s.growth_score),
      profitability: fmt(s.profitability_score),
      balance_sheet: fmt(s.balance_sheet_score),
      breadth:       fmt(s.breadth_score),
      sentiment:     fmt(s.sentiment_score),
      valuation:     fmt(s.valuation_score),
    },
    data_flags: s.data_flags ?? null,
  }));

  // Basket-level aggregate for context
  const clusterRows = await prisma.iitClusterScore.findMany({
    where: {
      week_date:      weekDate,
      basic_industry: { in: basket.industries },
    },
    select: {
      basic_industry:  true,
      composite_score: true,
      velocity_3w:     true,
      breadth_pct:     true,
      stock_count:     true,
      rank:            true,
    },
  });
  const metrics = aggregateBasketMetrics(clusterRows);
  const signal  = metrics ? deriveSignal(metrics.composite_score, metrics.velocity_3w) : 'WAIT';

  res.json({
    basket: {
      id:          basket.id,
      title:       basket.title,
      etfTicker:   basket.etfTicker,
      description: basket.description,
      category:    basket.category,
      industries:  basket.industries,
      signal,
      metrics,
    },
    as_of_date: asOfDate,
    pagination: { page, size, total, pages: Math.ceil(total / size) },
    stocks:     items,
  });
}

module.exports = { getIndustryBaskets, getIndustryBasketStocks };
