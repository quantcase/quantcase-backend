'use strict';

const prisma = require('../../config/prisma');

/**
 * Upsert per-stock scores for a given week.
 * Unique key: (week_date, ticker)
 *
 * @param {Array}  stockScores  — rows from the scoring step
 * @param {string} weekDate     'YYYY-MM-DD'
 * @param {string} regime
 */
async function saveStockScores(stockScores, weekDate, regime) {
  const date = new Date(weekDate);

  const ops = stockScores.map(s =>
    prisma.iitWeeklyStockScore.upsert({
      where:  { week_date_ticker: { week_date: date, ticker: s.ticker } },
      create: {
        week_date:            date,
        ticker:               s.ticker,
        basic_industry:       s.basic_industry,
        economic_model:       s.economic_model,
        regime,
        momentum_score:       s.momentum_score,
        growth_score:         s.growth_score,
        profitability_score:  s.profitability_score,
        balance_sheet_score:  s.balance_sheet_score,
        breadth_score:        s.breadth_score,
        sentiment_score:      s.sentiment_score,
        valuation_score:      s.valuation_score,
        composite_score:      s.composite_score,
        factor_weights:       s.factor_weights ?? undefined,
        data_flags:           s.data_flags     ?? undefined,
      },
      update: {
        basic_industry:       s.basic_industry,
        economic_model:       s.economic_model,
        regime,
        momentum_score:       s.momentum_score,
        growth_score:         s.growth_score,
        profitability_score:  s.profitability_score,
        balance_sheet_score:  s.balance_sheet_score,
        breadth_score:        s.breadth_score,
        sentiment_score:      s.sentiment_score,
        valuation_score:      s.valuation_score,
        composite_score:      s.composite_score,
        factor_weights:       s.factor_weights ?? undefined,
        data_flags:           s.data_flags     ?? undefined,
      },
    })
  );

  const results = await prisma.$transaction(ops);
  console.log(`[IIT] Persisted ${results.length} stock scores for week ${weekDate}`);
}

/**
 * Upsert cluster scores for a given week.
 * Unique key: (week_date, basic_industry)
 *
 * @param {Array}  clusterScores  — rows from attachWoWDeltas
 * @param {string} weekDate       'YYYY-MM-DD'
 * @param {string} regime
 */
async function saveClusterScores(clusterScores, weekDate, regime) {
  const date = new Date(weekDate);

  const ops = clusterScores.map(c =>
    prisma.iitClusterScore.upsert({
      where:  { week_date_basic_industry: { week_date: date, basic_industry: c.basic_industry } },
      create: {
        week_date:           date,
        basic_industry:      c.basic_industry,
        median_score:        c.median_score,
        breadth_pct:         c.breadth_pct,
        composite_score:     c.composite_score,
        rank:                c.rank,
        rank_prev:           c.rank_prev,
        wow_delta:           c.wow_delta,
        velocity_3w:         c.velocity_3w,
        rank_trend:          c.rank_trend,
        quartile:            c.quartile,
        score_wow_delta:     c.score_wow_delta,
        stock_count:         c.stock_count,
        scored_stock_count:  c.scored_stock_count,
        regime,
        low_confidence:      c.low_confidence ?? false,
      },
      update: {
        median_score:        c.median_score,
        breadth_pct:         c.breadth_pct,
        composite_score:     c.composite_score,
        rank:                c.rank,
        rank_prev:           c.rank_prev,
        wow_delta:           c.wow_delta,
        velocity_3w:         c.velocity_3w,
        rank_trend:          c.rank_trend,
        quartile:            c.quartile,
        score_wow_delta:     c.score_wow_delta,
        stock_count:         c.stock_count,
        scored_stock_count:  c.scored_stock_count,
        regime,
        low_confidence:      c.low_confidence ?? false,
      },
    })
  );

  const results = await prisma.$transaction(ops);
  console.log(`[IIT] Persisted ${results.length} cluster scores for week ${weekDate}`);
}

module.exports = { saveStockScores, saveClusterScores };
