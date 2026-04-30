'use strict';

const prisma           = require('../config/prisma');
const classification   = require('../config/iitClassification.json');

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtWow(delta) {
  if (delta == null) return '—';
  if (delta > 0)  return `+${delta}`;
  if (delta < 0)  return `−${Math.abs(delta)}`;
  return '—';
}

function fmtScoreWow(delta) {
  if (delta == null) return null;
  const d = parseFloat(delta);
  if (d > 0)  return `+${d}`;
  if (d < 0)  return `−${Math.abs(d)}`;
  return '→ 0';
}

function rankStability(rankTrend) {
  if (!rankTrend) return null;
  const arrows = rankTrend.replace(/\s/g, '');
  if (arrows === '→→') return 'Stable';
  if (arrows.includes('↑')) return 'Improving';
  if (arrows.includes('↓')) return 'Declining';
  return 'Stable';
}

function valuationLabel(score) {
  if (score == null) return null;
  const s = parseFloat(score);
  if (s < 33) return 'Expensive';
  if (s > 66) return 'Cheap';
  return 'Fair';
}

function buildRankHistory(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.week_date) - new Date(b.week_date));
  const total  = sorted.length;
  return sorted.map((r, i) => ({
    week: i === total - 1 ? 'Now' : `W-${total - 1 - i}`,
    rank: r.rank,
  }));
}

// ── Rotation signal detection (score-only, no LLM) ───────────────────────────

function detectRotation(c) {
  const vel     = c.velocity_3w;
  const breadth = c.breadth_pct != null ? parseFloat(c.breadth_pct) : null;

  if (vel != null && vel >= 5  && breadth != null && breadth >= 55) return 'ROTATION ENTRY';
  if (vel != null && vel <= -4 && breadth != null && breadth <= 35) return 'ROTATION EXIT';
  if (c.wow_delta != null && c.wow_delta > 0 && breadth != null && breadth < 35) return 'TRAP ALERT';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

async function getIndustryIntelligence(req, res) {
  try {
    const { industry, cluster } = req.query;

    // ── Resolve week date ─────────────────────────────────────────────────────
    const latest = await prisma.iitClusterScore.findFirst({
      orderBy: { week_date: 'desc' },
      select:  { week_date: true, regime: true },
    });

    if (!latest) {
      return res.status(404).json({ error: 'No IIT data available. Run the scoring job first.' });
    }

    const weekDate  = latest.week_date;
    const regime    = latest.regime ?? 'Neutral';
    const asOfDate  = weekDate.toISOString().slice(0, 10);

    // ── Core queries (parallel) ────────────────────────────────────────────────
    const twelveWeeksAgo = new Date(weekDate.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);

    const [clusterScores, stockAgg, rankHistoryRows] = await Promise.all([
      // All clusters for current week, ranked
      prisma.iitClusterScore.findMany({
        where:   { week_date: weekDate },
        orderBy: { rank: 'asc' },
      }),
      // Cluster-level avg of momentum/valuation (aggregated from stock scores)
      prisma.iitWeeklyStockScore.groupBy({
        by:    ['basic_industry'],
        where: { week_date: weekDate },
        _avg:  { momentum_score: true, valuation_score: true },
      }),
      // 12-week rank history for all clusters
      prisma.iitClusterScore.findMany({
        where:   { week_date: { gte: twelveWeeksAgo, lte: weekDate } },
        select:  { basic_industry: true, week_date: true, rank: true },
        orderBy: { week_date: 'asc' },
      }),
    ]);

    const clusterMap  = new Map(clusterScores.map(c  => [c.basic_industry, c]));
    const stockAggMap = new Map(stockAgg.map(s        => [s.basic_industry, s._avg]));

    // Group rank history per cluster
    const historyByCluster = new Map();
    for (const r of rankHistoryRows) {
      if (!historyByCluster.has(r.basic_industry)) historyByCluster.set(r.basic_industry, []);
      historyByCluster.get(r.basic_industry).push(r);
    }

    const rankable = clusterScores.filter(c => c.rank != null);
    const n        = rankable.length;

    // ── dashboard helpers ─────────────────────────────────────────────────────
    const topCluster    = rankable[0] ?? null;
    const biggestMover  = rankable.reduce((best, c) => {
      return (c.wow_delta ?? -Infinity) > (best?.wow_delta ?? -Infinity) ? c : best;
    }, null);

    const rotationSignals = rankable
      .map(c => ({ ...c, _signal: detectRotation(c) }))
      .filter(c => c._signal != null);

    const entries  = rotationSignals.filter(c => c._signal === 'ROTATION ENTRY');
    const exits    = rotationSignals.filter(c => c._signal === 'ROTATION EXIT');
    const traps    = rotationSignals.filter(c => c._signal === 'TRAP ALERT');
    const emerging = rankable.filter(c =>
      c.score_wow_delta != null && parseFloat(c.score_wow_delta) >= 15
    );

    // ── high conviction pick ──────────────────────────────────────────────────
    let highConviction = null;
    if (topCluster) {
      const topStock = await prisma.iitWeeklyStockScore.findFirst({
        where:   { week_date: weekDate, basic_industry: topCluster.basic_industry },
        orderBy: { composite_score: 'desc' },
      });
      if (topStock) {
        highConviction = {
          ticker:           topStock.ticker,
          cluster_label:    `${topCluster.basic_industry} #${topCluster.rank}`,
          context:          'Top stock · Top cluster',
          rs_vs_market_pct: null, // (static) needs raw price data from nse_equity
          revisions:        null, // (static) LLM — no analyst revision data
          quality_score:    topStock.composite_score != null ? parseFloat(topStock.composite_score) : null,
        };
      }
    }

    // ── regime weights (from classification.json) ─────────────────────────────
    const baseWeights = classification.factor_weights['Consumption'];
    const regAdj      = classification.regime_adjustments[regime] ?? {};
    const regimeWeights = Object.entries(baseWeights).map(([factor, base]) => {
      const delta    = regAdj[factor] ?? 0;
      const adjusted = Math.max(0, base + delta);
      return {
        label:           `${factor.charAt(0).toUpperCase() + factor.slice(1).replace('_', ' ')} weight`,
        value_pct:       `${adjusted}%`,
        delta:           delta !== 0 ? `${delta > 0 ? '+' : ''}${delta}pp` : null,
        delta_direction: delta > 0 ? 'positive' : delta < 0 ? 'negative' : null,
        note:            null, // (static) LLM narrative
      };
    });

    // ── universe stats (from cluster stock_count + classification) ────────────
    const totalStocks = clusterScores.reduce((s, c) => s + (c.stock_count ?? 0), 0);

    const macroSectorMap = new Map();
    for (const [, v] of Object.entries(classification.hierarchy)) {
      if (!macroSectorMap.has(v.macro_sector_code)) {
        macroSectorMap.set(v.macro_sector_code, { code: v.macro_sector_code, name: v.macro_sector, stock_count: 0 });
      }
    }
    // Add actual stock_count from cluster scores per macro_sector
    for (const c of clusterScores) {
      const hier = classification.hierarchy[c.basic_industry];
      if (hier) {
        const entry = macroSectorMap.get(hier.macro_sector_code);
        if (entry) entry.stock_count += c.stock_count ?? 0;
      }
    }

    // ── deep_dive (when ?industry= provided) ─────────────────────────────────
    let deepDive = {
      available_industries: rankable.map(c => c.basic_industry),
      selected_industry:    null,
    };

    if (industry) {
      const clusterRow = clusterMap.get(industry);
      const hier       = classification.hierarchy[industry];

      // Per-stock factor scores for this cluster
      const stockScores = await prisma.iitWeeklyStockScore.findMany({
        where:  { week_date: weekDate, basic_industry: industry },
        select: {
          growth_score:        true,
          profitability_score: true,
          balance_sheet_score: true,
          momentum_score:      true,
          valuation_score:     true,
          breadth_score:       true,
        },
      });

      const median = (values) => {
        const v = values.filter(x => x != null).sort((a, b) => a - b);
        if (!v.length) return null;
        const m = Math.floor(v.length / 2);
        return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
      };

      const fundamentalsMedian = median([
        ...stockScores.map(s => s.growth_score),
        ...stockScores.map(s => s.profitability_score),
        ...stockScores.map(s => s.balance_sheet_score),
      ].filter(x => x != null));

      // 8-week history for deep dive
      const hist8 = buildRankHistory((historyByCluster.get(industry) ?? []).slice(-8));

      deepDive = {
        available_industries: rankable.map(c => c.basic_industry),
        selected_industry: clusterRow ? {
          name:       industry,
          breadcrumb: ['Industry ranking', hier?.sector, hier?.industry, industry].filter((v, i, a) => v && a.indexOf(v) === i),
          metrics: {
            cluster_rank:          clusterRow.rank,
            rank_stability:        rankStability(clusterRow.rank_trend),
            rank_change_wow:       clusterRow.wow_delta ?? 0,
            rank_label:            clusterRow.rank != null ? `#${clusterRow.rank}` : null,
            rank_change_label:     `${rankStability(clusterRow.rank_trend) ?? '—'} · ${fmtWow(clusterRow.wow_delta)} WoW`,
            composite_score:       clusterRow.composite_score != null ? parseFloat(clusterRow.composite_score) : null,
            score_change_wow:      fmtScoreWow(clusterRow.score_wow_delta),
            score_change_label:    clusterRow.score_wow_delta != null ? `${fmtScoreWow(clusterRow.score_wow_delta)} this week` : null,
            breadth_pct:           clusterRow.breadth_pct != null ? parseFloat(clusterRow.breadth_pct) : null,
            breadth_context:       clusterRow.breadth_pct != null ? `${Math.round(parseFloat(clusterRow.breadth_pct))}% above 20w MA` : null,
            economic_model:        hier?.economic_model ?? null,
            economic_model_detail: null, // (static) narrative label e.g. "Core overweight"
          },
          factor_scores: {
            fundamentals: fundamentalsMedian != null ? Math.round(fundamentalsMedian * 10) / 10 : null,
            momentum:     stockAggMap.get(industry)?.momentum_score != null
                            ? Math.round(parseFloat(stockAggMap.get(industry).momentum_score) * 10) / 10
                            : null,
            breadth:      clusterRow.breadth_pct != null ? parseFloat(clusterRow.breadth_pct) : null,
            revisions:    null, // (static) LLM — no analyst revision data in DB
            sentiment:    null, // (static) LLM — no sell-side coverage data
            valuation:    stockAggMap.get(industry)?.valuation_score != null
                            ? Math.round(parseFloat(stockAggMap.get(industry).valuation_score) * 10) / 10
                            : null,
          },
          rank_history:        hist8,
          factor_news_impacts: null, // (static) LLM — requires news corpus
          overview_text:       null, // (static) LLM — narrative summary
          drivers:             null, // (static) LLM — key driver bullets
          news:                null, // (static) LLM — curated news items
          risks:               null, // (static) LLM — risk text
          catalysts:           null, // (static) LLM — upcoming catalyst text
        } : null,
      };
    }

    // ── stock_ranking (when ?cluster= provided) ───────────────────────────────
    let stockRanking = {
      available_clusters: rankable.map(c => c.basic_industry),
      selected_cluster:   null,
    };

    if (cluster) {
      const clusterRow = clusterMap.get(cluster);
      const hier       = classification.hierarchy[cluster];

      // All clusters in the same industry group (for the dropdown)
      const sameIndustryClusters = hier?.industry
        ? Object.entries(classification.hierarchy)
            .filter(([, v]) => v.industry === hier.industry)
            .map(([k]) => k)
        : [cluster];

      // Stock scores for this cluster, sorted by composite_score desc
      const stocks = await prisma.iitWeeklyStockScore.findMany({
        where:   { week_date: weekDate, basic_industry: cluster },
        orderBy: { composite_score: 'desc' },
        select:  {
          ticker:          true,
          composite_score: true,
          valuation_score: true,
          momentum_score:  true,
        },
      });

      // Company names from earnings_calls
      const companyRows = await prisma.earnings_calls.findMany({
        where:    { company: { in: stocks.map(s => s.ticker) } },
        select:   { company: true, company_name: true },
        distinct: ['company'],
      });
      const companyMap = new Map(companyRows.map(r => [r.company, r.company_name]));

      stockRanking = {
        available_clusters: sameIndustryClusters,
        selected_cluster: clusterRow ? {
          name:       cluster,
          breadcrumb: ['Industry ranking', hier?.sector, hier?.industry, cluster].filter(Boolean),
          stocks: stocks.map((s, i) => ({
            rank:               i + 1,
            symbol:             s.ticker,
            company_name:       companyMap.get(s.ticker) ?? s.ticker,
            rs_vs_cluster_pct:  null, // (static) needs raw price return data (rel3m not stored per stock)
            revision_label:     null, // (static) LLM — no analyst revision data
            revision_direction: null, // (static) LLM
            quality_score:      s.composite_score != null ? parseFloat(s.composite_score) : null,
            valuation_label:    valuationLabel(s.valuation_score),
          })),
          cluster_signals: null, // (static) LLM — narrative cluster signals
          cluster_news:    null, // (static) LLM — curated cluster-level news
        } : null,
      };
    }

    // ── week label ────────────────────────────────────────────────────────────
    const d = new Date(weekDate);
    const weekLabel = `Week ending ${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${d.getFullYear()} · Friday close`;

    // ── Assemble final response ────────────────────────────────────────────────
    return res.json({
      meta: {
        regime,
        regime_previous:          null, // (static) no regime history table
        regime_changed_weeks_ago: null, // (static) no regime history table
        as_of_date:               asOfDate,
        week_ending_label:        weekLabel,
        version:                  '1.1',
      },

      dashboard: {
        summary_tiles: {
          market_regime: {
            value:       regime,
            change:      null, // (static) no regime history
            since_label: null, // (static) no regime history
          },
          top_cluster: topCluster ? {
            name:     topCluster.basic_industry,
            score:    topCluster.composite_score != null ? parseFloat(topCluster.composite_score) : null,
            quartile: topCluster.quartile,
            rank:     topCluster.rank,
          } : null,
          biggest_mover: biggestMover ? {
            name:        biggestMover.basic_industry,
            rank_change: fmtWow(biggestMover.wow_delta),
            label:       `${fmtWow(biggestMover.wow_delta)} ranks this week`,
          } : null,
          news_this_week: null, // (static) LLM — no news data source
        },
        top_5_industries: rankable.slice(0, 5).map(c => ({
          rank:            c.rank,
          name:            c.basic_industry,
          composite_score: c.composite_score != null ? parseFloat(c.composite_score) : null,
          wow:             fmtWow(c.wow_delta),
          quartile:        c.quartile,
          news_tag:        null, // (static) LLM
          news_direction:  null, // (static) LLM
        })),
        bottom_3_industries: rankable.slice(-3).reverse().map(c => ({
          rank:            c.rank,
          name:            c.basic_industry,
          composite_score: c.composite_score != null ? parseFloat(c.composite_score) : null,
          wow:             fmtWow(c.wow_delta),
          quartile:        c.quartile,
          signal:          null, // (static) LLM
        })),
        portfolio_holdings: null, // (static) needs user portfolio context
        rotation_signals: rotationSignals.map(c => ({
          type:       c._signal,
          industry_name: c.basic_industry,
          detail:     `Rank ${fmtWow(c.velocity_3w)} in 3w · Breadth ${c.breadth_pct != null ? Math.round(parseFloat(c.breadth_pct)) : '?'}%`,
          direction:  c._signal === 'ROTATION ENTRY' ? 'up' : c._signal === 'ROTATION EXIT' ? 'down' : 'warn',
        })),
        top_news: null, // (static) LLM — no news intelligence source
      },

      industry_ranking: {
        as_of_date:       asOfDate,
        total_industries: n,
        industries: rankable.map(c => ({
          rank:            c.rank,
          name:            c.basic_industry,
          composite_score: c.composite_score != null ? parseFloat(c.composite_score) : null,
          wow:             fmtWow(c.wow_delta),
          momentum:        stockAggMap.get(c.basic_industry)?.momentum_score != null
                             ? Math.round(parseFloat(stockAggMap.get(c.basic_industry).momentum_score) * 10) / 10
                             : null,
          breadth_pct:     c.breadth_pct != null ? parseFloat(c.breadth_pct) : null,
          revisions:       null, // (static) LLM — no sell-side revision data
          valuation:       stockAggMap.get(c.basic_industry)?.valuation_score != null
                             ? Math.round(parseFloat(stockAggMap.get(c.basic_industry).valuation_score) * 10) / 10
                             : null,
          quartile:        c.quartile,
          news_tag:        null, // (static) LLM
          news_direction:  null, // (static) LLM
          rank_history:    buildRankHistory(historyByCluster.get(c.basic_industry) ?? []),
        })),
      },

      deep_dive: deepDive,

      stock_ranking: stockRanking,

      rotation_alerts: {
        signal_counts: {
          entry_count:           entries.length,
          entry_industries:      entries.map(c => c.basic_industry),
          exit_count:            exits.length,
          exit_industries:       exits.map(c => c.basic_industry),
          trap_count:            traps.length,
          trap_industries:       traps.map(c => c.basic_industry),
          news_confirmed_count:  null, // (static) LLM
          news_confirmed_detail: null, // (static) LLM
        },
        active_signals: {
          entry: entries[0] ? {
            industry:        entries[0].basic_industry,
            detail:          `Rank ${fmtWow(entries[0].velocity_3w)} in 3w · Breadth ${entries[0].breadth_pct != null ? Math.round(parseFloat(entries[0].breadth_pct)) : '?'}%`,
            confirming_news: null, // (static) LLM
          } : null,
          exit: exits[0] ? {
            industry:        exits[0].basic_industry,
            detail:          `Rank ${fmtWow(exits[0].velocity_3w)} in 3w · Breadth ${exits[0].breadth_pct != null ? Math.round(parseFloat(exits[0].breadth_pct)) : '?'}%`,
            confirming_news: null, // (static) LLM
          } : null,
          trap: traps[0] ? {
            industry: traps[0].basic_industry,
            detail:   `Rank ${fmtWow(traps[0].wow_delta)} · Breadth ${traps[0].breadth_pct != null ? Math.round(parseFloat(traps[0].breadth_pct)) : '?'}%`,
          } : null,
          emerging: emerging[0] ? {
            industry: emerging[0].basic_industry,
            detail:   `Score ${fmtScoreWow(emerging[0].score_wow_delta)} in 2w · Watch for breadth confirmation`,
          } : null,
        },
        high_conviction_pick: highConviction,
        regime_weights:       regimeWeights,
      },

      universe_browser: {
        stats: {
          total_stocks:        totalStocks,
          total_macro_sectors: macroSectorMap.size,
          hierarchy_levels:    4,
        },
        macro_sectors: [...macroSectorMap.values()],
      },

      news_intelligence: null, // (static) LLM — not implemented
    });
  } catch (err) {
    console.error('[IIT] Controller error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { getIndustryIntelligence };
