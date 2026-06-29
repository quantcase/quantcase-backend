'use strict';

const prisma = require('../config/prisma');
const { ProwessHelper } = require('../utils/prowessHelper');

const CHART_YEARS = 6;
const CAP         = 200; // max displayed YoY growth % to keep chart scale sane

// ── Math helpers ──────────────────────────────────────────────────────────────

function yoyGrowth(prev, curr) {
  if (prev == null || curr == null || prev === 0) return null;
  return parseFloat(((curr - prev) / Math.abs(prev) * 100).toFixed(1));
}

function cagr(base, latest, years) {
  if (base == null || latest == null || years <= 0 || base <= 0) return null;
  return parseFloat(((Math.pow(latest / base, 1 / years) - 1) * 100).toFixed(1));
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Trimmed mean: drop the highest and lowest value when n >= 4 to reduce outlier distortion.
// Falls back to regular median for small sets.
function trimmedMean(arr) {
  if (arr.length < 4) return median(arr);
  const s = arr.slice().sort((a, b) => a - b).slice(1, -1); // drop min and max
  return s.reduce((sum, v) => sum + v, 0) / s.length;
}

function capGrowth(v) {
  if (v == null) return null;
  return Math.max(-CAP, Math.min(CAP, v));
}

// ── nse_equity_new EPS helpers ────────────────────────────────────────────────

// Fetch annual EPS snapshots for one or more symbols from nse_equity_new.
// Uses the first available row in April each year (posted just after Indian fiscal year close).
// Returns { [symbol]: [ { fiscal_year: 'FY2025', eps, as_of }, ... ] }
async function fetchNseEpsAnnual(symbols) {
  if (!symbols.length) return {};
  const escaped = symbols.map(s => `'${s.replace(/'/g, "''")}'`).join(',');

  const rows = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT ON (symbol, EXTRACT(YEAR FROM datetime))
           symbol,
           EXTRACT(YEAR FROM datetime)::int   AS cal_year,
           eps::float                          AS eps,
           datetime                            AS as_of
    FROM   nse_equity_new
    WHERE  symbol  = ANY(ARRAY[${escaped}])
      AND  eps     IS NOT NULL
      AND  EXTRACT(MONTH FROM datetime) IN (3, 4)
    ORDER  BY symbol,
              EXTRACT(YEAR FROM datetime) ASC,
              datetime DESC
  `);

  const out = {};
  for (const r of rows) {
    const fy = `FY${r.cal_year}`;
    if (!out[r.symbol]) out[r.symbol] = [];
    out[r.symbol].push({ fiscal_year: fy, eps: r.eps, as_of: r.as_of });
  }
  return out;
}

// ── Signal lookup helpers ─────────────────────────────────────────────────────

function signalObj(signals, metric) {
  return signals.find(s => s.metric === metric) ?? null;
}

// ── Industry EPS line from nse_equity_new ────────────────────────────────────
// Finds all peer tickers in the same basic_industry, fetches their annual EPS
// from nse_equity_new, computes median EPS per fiscal year, and derives YoY growth.

async function fetchIndustryEpsLine(subjectTicker) {
  const call = await prisma.earnings_calls.findFirst({
    where:  { company: subjectTicker },
    select: { basic_industry: true },
  });
  if (!call?.basic_industry) {
    return { industryLabel: null, byYear: {}, cagrYears: 5, industryCagr: null, peerCount: 0 };
  }

  const industry = call.basic_industry;

  const peerRows = await prisma.earnings_calls.findMany({
    where:    { basic_industry: industry },
    select:   { company: true },
    distinct: ['company'],
  });
  const peerTickers = peerRows.map(r => r.company);

  // Fetch annual EPS for all peers from nse_equity_new
  const epsMap = await fetchNseEpsAnnual(peerTickers);
  const peersWithData = Object.keys(epsMap).filter(t => epsMap[t].length >= 2);
  if (peersWithData.length === 0) {
    return { industryLabel: industry, byYear: {}, cagrYears: 5, industryCagr: null, peerCount: 0 };
  }

  // Compute median EPS per fiscal year across all peers
  const epsByYear = {};
  for (const ticker of peersWithData) {
    for (const { fiscal_year, eps } of epsMap[ticker]) {
      if (!epsByYear[fiscal_year]) epsByYear[fiscal_year] = [];
      epsByYear[fiscal_year].push(eps);
    }
  }
  const medianEpsByYear = {};
  for (const [fy, vals] of Object.entries(epsByYear)) {
    medianEpsByYear[fy] = trimmedMean(vals);
  }

  // YoY growth of median EPS per year.
  // Null out sign-crossing transitions (e.g. near-zero → positive after NPA cycle)
  // to avoid extreme percentages blowing out the chart scale.
  const sortedYears = Object.keys(medianEpsByYear).sort();
  const byYear = {};
  for (let i = 1; i < sortedYears.length; i++) {
    const prevFY  = sortedYears[i - 1];
    const currFY  = sortedYears[i];
    const prevEPS = medianEpsByYear[prevFY];
    const currEPS = medianEpsByYear[currFY];
    const sameSign = (prevEPS > 0 && currEPS > 0) || (prevEPS < 0 && currEPS < 0);
    const growth = sameSign && prevEPS !== 0
      ? parseFloat(((currEPS - prevEPS) / Math.abs(prevEPS) * 100).toFixed(1))
      : null;
    byYear[currFY] = { growth_pct: growth, peer_count: epsByYear[currFY]?.length ?? 0 };
  }

  // Industry CAGR: oldest positive base within 5Y of the latest positive year
  const latestPosFY = sortedYears.slice().reverse().find(fy => medianEpsByYear[fy] > 0);
  let industryCagr = null;
  let cagrYears = 5;
  if (latestPosFY) {
    const latestYear = parseInt(latestPosFY.replace('FY', ''), 10);
    const bases = sortedYears.filter(fy => {
      const yr = parseInt(fy.replace('FY', ''), 10);
      return medianEpsByYear[fy] > 0 && yr < latestYear && (latestYear - yr) <= 5;
    });
    if (bases.length > 0) {
      const baseFY   = bases[0];
      const baseYear = parseInt(baseFY.replace('FY', ''), 10);
      cagrYears      = latestYear - baseYear;
      industryCagr   = cagr(medianEpsByYear[baseFY], medianEpsByYear[latestPosFY], cagrYears);
    }
  }

  return { industryLabel: industry, byYear, cagrYears, industryCagr, peerCount: peersWithData.length };
}

// ── Main service ──────────────────────────────────────────────────────────────

async function getEarningsQuality(ticker) {
  const sym = ticker.toUpperCase();

  const latestRow = await prisma.lensScore.findFirst({
    where:   { ticker: sym, lens_slug: 'earning-quality' },
    select:  { call_id: true, lens_data: true, computed_at: true, is_stale: true, z_score: true },
    orderBy: { computed_at: 'desc' },
  });

  if (!latestRow) {
    return { ticker: sym, available: false, error: 'earning-quality lens not computed for ticker' };
  }

  const ld         = latestRow.lens_data ?? {};
  const topSignals = Array.isArray(ld.top_signals) ? ld.top_signals : [];

  // ── Fetch company EPS + peer industry line + supporting KPIs in parallel ──
  const prowess = new ProwessHelper(prisma);

  const [companyEpsMap, industryLine, annualBatch] = await Promise.all([
    fetchNseEpsAnnual([sym]),
    fetchIndustryEpsLine(sym),
    prowess.getAnnualBatch(sym, ['ROE', 'ROA', 'CFO', 'PAT']),
  ]);

  const companyEpsSeries = companyEpsMap[sym] ?? [];
  const roeSeries = (annualBatch['ROE'] ?? []).filter(p => p.value != null);
  const roaSeries = (annualBatch['ROA'] ?? []).filter(p => p.value != null);
  const cfoSeries = (annualBatch['CFO'] ?? []).filter(p => p.value != null);
  const patSeries = (annualBatch['PAT'] ?? []).filter(p => p.value != null);

  // ── Company EPS CAGR (up to 5Y, positive base only) ──────────────────────
  const recentEps    = companyEpsSeries.slice(-(CHART_YEARS + 1));
  const latestEpspt  = recentEps.at(-1);
  let companyCagr      = null;
  let companyCagrYears = 5;
  if (latestEpspt?.eps > 0) {
    for (let i = 0; i < recentEps.length - 1; i++) {
      const candidate = recentEps[i];
      if (candidate.eps > 0) {
        const baseYear   = parseInt(candidate.fiscal_year.replace('FY', ''), 10);
        const latestYear = parseInt(latestEpspt.fiscal_year.replace('FY', ''), 10);
        const years      = latestYear - baseYear;
        if (years > 0 && years <= 5) {
          companyCagr      = cagr(candidate.eps, latestEpspt.eps, years);
          companyCagrYears = years;
          break;
        }
      }
    }
  }

  // ── YoY bar chart from nse_equity_new EPS ────────────────────────────────
  const barEps  = companyEpsSeries.slice(-(CHART_YEARS + 1));
  const companyBars = [];
  for (let i = 1; i < barEps.length; i++) {
    const prev = barEps[i - 1];
    const curr = barEps[i];
    companyBars.push({
      fiscal_year:        curr.fiscal_year,
      label:              curr.fiscal_year.replace(/FY(\d{4})/, (_, y) => 'FY' + y.slice(2)),
      actual_date:        curr.as_of instanceof Date ? curr.as_of.toISOString().slice(0, 10) : String(curr.as_of).slice(0, 10),
      company_growth_pct: yoyGrowth(prev.eps, curr.eps),
    });
  }

  // ── Attach industry line; cap extremes ───────────────────────────────────
  const bars = companyBars.map(b => {
    const coRaw  = b.company_growth_pct;
    const indRaw = industryLine.byYear[b.fiscal_year]?.growth_pct ?? null;
    const coCap  = capGrowth(coRaw);
    const indCap = capGrowth(indRaw);
    return {
      ...b,
      company_growth_pct:                          coCap,
      ...(coRaw !== coCap  && coRaw  != null ? { company_growth_pct_raw:  coRaw  } : {}),
      industry_growth_pct:                         indCap,
      ...(indRaw !== indCap && indRaw != null ? { industry_growth_pct_raw: indRaw } : {}),
      industry_peer_count: industryLine.byYear[b.fiscal_year]?.peer_count ?? null,
    };
  });

  // ── Relative outperformance ───────────────────────────────────────────────
  const industryCagrPct = industryLine.industryCagr;
  const relativeOutperformance = companyCagr != null && industryCagrPct != null
    ? parseFloat((companyCagr - industryCagrPct).toFixed(1))
    : null;

  // ── Beat rate from overlapping bars ──────────────────────────────────────
  let beatCount = 0, beatTotal = 0;
  for (const b of bars) {
    if (b.company_growth_pct != null && b.industry_growth_pct != null) {
      beatTotal++;
      if (b.company_growth_pct > b.industry_growth_pct) beatCount++;
    }
  }
  const llmBeatSignal  = signalObj(topSignals, 'EPS_BEAT_RATE');
  const finalBeatCount = beatTotal > 0 ? beatCount : (llmBeatSignal?.actual_value ?? null);
  const finalBeatTotal = beatTotal > 0 ? beatTotal : (() => {
    const t = llmBeatSignal?.total_periods ?? llmBeatSignal?.value_targeted;
    if (t != null) return Number(t);
    const m = (llmBeatSignal?.label ?? '').match(/\d+\s+of\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  })();

  // ── Consistency score from bars ───────────────────────────────────────────
  const llmConsistency  = signalObj(topSignals, 'EPS_CONSISTENCY_SCORE');
  let consistencyScore  = llmConsistency?.actual_value ?? null;
  let consistencyStatus = llmConsistency?.status ?? null;
  if (consistencyScore == null && bars.length > 0) {
    const pos   = bars.filter(b => b.company_growth_pct != null && b.company_growth_pct > 0).length;
    const total = bars.filter(b => b.company_growth_pct != null).length;
    if (total > 0) {
      consistencyScore  = Math.round((pos / total) * 5);
      consistencyStatus = consistencyScore >= 4 ? 'Strong' : consistencyScore >= 3 ? 'Moderate' : 'Weak';
    }
  }

  // ── Forward estimate: LLM-only (no estimates in Prowess/NSE) ─────────────
  const growthEstSignal = signalObj(topSignals, 'EPS_GROWTH_ESTIMATE');
  const forwardEstimate = growthEstSignal?.actual_value ?? null;

  // ── Insight cards ─────────────────────────────────────────────────────────
  const insightBeatRate    = signalObj(topSignals, 'INSIGHT_BEAT_RATE');
  const insightCagr        = signalObj(topSignals, 'INSIGHT_CAGR_ASSESSMENT');
  const insightForward     = signalObj(topSignals, 'INSIGHT_FORWARD_ESTIMATE');
  const insightConsistency = signalObj(topSignals, 'INSIGHT_CONSISTENCY');

  const insightCards = [
    insightBeatRate ?? {
      metric:    'INSIGHT_BEAT_RATE',
      label:     finalBeatCount != null && finalBeatTotal != null
        ? `Beat industry ${finalBeatCount} of ${finalBeatTotal} years` : 'Beat Rate',
      statement: null,
      status:    finalBeatCount != null && finalBeatTotal != null && finalBeatTotal > 0
        ? (finalBeatCount / finalBeatTotal >= 0.7 ? 'Positive' : 'Neutral') : 'Neutral',
    },
    insightCagr ?? {
      metric:    'INSIGHT_CAGR_ASSESSMENT',
      label:     companyCagr != null
        ? `${companyCagr}% ${companyCagrYears}Y CAGR${companyCagr >= 0 ? ' — positive' : ' — drag'}` : 'CAGR Assessment',
      statement: null,
      status:    companyCagr != null ? (companyCagr >= 10 ? 'Positive' : companyCagr >= 0 ? 'Neutral' : 'Negative') : 'Neutral',
    },
    insightForward ?? {
      metric:    'INSIGHT_FORWARD_ESTIMATE',
      label:     forwardEstimate != null ? `Forward est. — ${forwardEstimate}% growth` : 'Forward Estimate',
      statement: growthEstSignal?.statement ?? null,
      status:    forwardEstimate != null ? (forwardEstimate >= 8 ? 'Positive' : forwardEstimate >= 0 ? 'Stable' : 'Negative') : 'Stable',
    },
    insightConsistency ?? {
      metric:    'INSIGHT_CONSISTENCY',
      label:     consistencyScore != null
        ? `Growth Consistency — ${consistencyScore >= 4 ? 'Strong' : consistencyScore >= 3 ? 'Moderate' : 'Weak'}` : 'Growth Consistency',
      statement: llmConsistency?.statement ?? null,
      status:    consistencyStatus ?? 'Moderate',
    },
  ];

  // ── 4 KPI tiles ───────────────────────────────────────────────────────────
  const tiles = [
    {
      metric:       'EPS_CAGR_COMPANY',
      label:        `Company EPS CAGR (${companyCagrYears}Y)`,
      unit:         '%',
      actual_value: companyCagr,
      statement:    `Computed from nse_equity_new TTM EPS — ${companyCagrYears}Y window`,
      confidence:   'actual',
    },
    {
      metric:       'EPS_CAGR_INDUSTRY',
      label:        `Industry EPS CAGR (${industryLine.cagrYears}Y)`,
      unit:         '%',
      actual_value: industryCagrPct,
      statement:    industryLine.industryLabel
        ? `${industryLine.industryLabel} — median of ${industryLine.peerCount} peers (nse_equity_new)`
        : null,
      confidence:   'actual',
    },
    {
      metric:       'EPS_RELATIVE_OUTPERFORMANCE',
      label:        'Relative Outperformance',
      unit:         '%',
      actual_value: relativeOutperformance,
      direction:    relativeOutperformance != null ? (relativeOutperformance >= 0 ? 'beat' : 'miss') : null,
      statement:    relativeOutperformance != null
        ? `Avg annual beat vs industry: ${relativeOutperformance >= 0 ? '+' : ''}${relativeOutperformance}%` : null,
    },
    {
      metric:       'EPS_GROWTH_ESTIMATE',
      label:        growthEstSignal?.label ?? 'FY26E EPS Growth (Est.)',
      unit:         '%',
      actual_value: forwardEstimate,
      guided_value: growthEstSignal?.guided_value ?? null,
      statement:    growthEstSignal?.statement ?? null,
    },
  ];

  return {
    ticker:      sym,
    call_id:     latestRow.call_id,
    available:   true,
    is_stale:    latestRow.is_stale,
    computed_at: latestRow.computed_at,
    score:       ld.score   ?? null,
    status:      ld.status  ?? null,
    z_score:     latestRow.z_score ?? null,
    takeaway:    ld.takeaway     ?? null,
    highlights:  ld.highlights   ?? [],
    risks:       ld.risks        ?? [],
    key_metrics: ld.key_metrics  ?? {},
    industry:    industryLine.industryLabel,
    chart_window_years: CHART_YEARS,

    tiles,
    chart_bars: bars,

    beat_rate: {
      count: finalBeatCount,
      total: finalBeatTotal,
      label: finalBeatCount != null && finalBeatTotal != null
        ? `Beat industry ${finalBeatCount} of ${finalBeatTotal} years` : null,
    },

    consistency: {
      score:     consistencyScore,
      status:    consistencyStatus,
      statement: llmConsistency?.statement ?? null,
    },

    insight_cards: insightCards,

    financial_context: {
      eps_series:    companyEpsSeries,
      latest_pat:    patSeries.at(-1)?.value  ?? null,
      latest_pat_fy: patSeries.at(-1)?.fiscal_year ?? null,
      latest_roe:    roeSeries.at(-1)?.value  ?? null,
      latest_roa:    roaSeries.at(-1)?.value  ?? null,
      timeseries: {
        ROE: roeSeries,
        ROA: roaSeries,
        CFO: cfoSeries,
        PAT: patSeries,
      },
    },

    top_signals: topSignals,
  };
}

module.exports = { getEarningsQuality };
