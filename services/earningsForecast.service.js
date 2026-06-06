'use strict';

const prisma = require('../config/prisma');
const { ProwessHelper } = require('../utils/prowessHelper');

const HOLDING_YEARS  = 3;
const SCENARIO_ORDER = ['bull', 'base', 'bear'];

// ── Price range parser (for takeaway field) ───────────────────────────────────

function parsePriceRanges(text) {
  if (!text) return [];
  const re = /₹([\d,]+(?:\.\d+)?)\s*[–—-]\s*₹([\d,]+(?:\.\d+)?)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      low:  parseFloat(m[1].replace(/,/g, '')),
      high: parseFloat(m[2].replace(/,/g, '')),
    });
  }
  return out;
}

function parseRiskReward(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)x\s*risk/i);
  return m ? parseFloat(m[1]) : null;
}

// ── Signal lookup helpers ─────────────────────────────────────────────────────

function signalValue(signals, metric) {
  return signals.find(s => s.metric === metric)?.actual_value ?? null;
}

function signalObj(signals, metric) {
  return signals.find(s => s.metric === metric) ?? null;
}

// ── Legacy highlight parser (fallback for pre-v1.5 lens data) ────────────────
// Tries to extract EPS CAGR and a margin string from freeform text.
// Returns null for any field it cannot parse — callers must handle null.

function parseLegacyHighlight(text) {
  if (!text) return { epsCagr: null, revCagrLow: null, revCagrHigh: null, marginPct: null, analystView: text };

  // EPS/PAT CAGR: "-8% PAT CAGR" or "22% PAT CAGR"
  let m = text.match(/(-?[\d.]+)%\s+(?:PAT|EPS)\s+CAGR/i);
  const epsCagr = m ? parseFloat(m[1]) : null;

  // Rev CAGR: "12% revenue growth" / "8% revenue CAGR"
  m = text.match(/(-?[\d.]+)%\s+revenue\s+(?:growth|CAGR|decline|contraction)/i);
  const revRaw = m ? parseFloat(m[1]) : null;
  const revCagrLow  = revRaw;
  const revCagrHigh = revRaw;

  // Margin as absolute %: "18% EBITDA margin", "stable margins near 13.5%", "margins compress to 15%"
  m = text.match(/(-?[\d.]+)%\s+EBITDA\s+margin/i)
    || text.match(/(?:stable|flat)\s+(?:margins?\s+(?:near|at|of)\s+)?(-?[\d.]+)%/i)
    || text.match(/margins?\s+(?:compress(?:es)?|contract(?:s)?|expand(?:s)?)\s+to\s+(-?[\d.]+)%/i)
    || text.match(/margin[s]?\s+of\s+(-?[\d.]+)%/i);
  const marginPct = m ? parseFloat(m[m.length === 2 ? 1 : 1]) : null;

  const analystView = text.replace(/^(Bull|Base|Bear):\s*/i, '').trim();
  return { epsCagr, revCagrLow, revCagrHigh, marginPct, analystView };
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function cagr(base, latest, years) {
  if (base == null || latest == null || years <= 0 || base <= 0) return null;
  return parseFloat(((Math.pow(latest / base, 1 / years) - 1) * 100).toFixed(1));
}

// ── Main service ──────────────────────────────────────────────────────────────

async function getEarningsForecast(ticker) {
  const sym = ticker.toUpperCase();

  const latestRow = await prisma.lensScore.findFirst({
    where:   { ticker: sym, lens_slug: 'earnings-forecast' },
    select:  { call_id: true, lens_data: true, computed_at: true, is_stale: true, z_score: true },
    orderBy: { computed_at: 'desc' },
  });

  if (!latestRow) {
    return { ticker: sym, available: false, error: 'earnings-forecast lens not computed for ticker' };
  }

  const ld         = latestRow.lens_data ?? {};
  const takeaway   = ld.takeaway  ?? '';
  const highlights = ld.highlights ?? [];
  const topSignals = Array.isArray(ld.top_signals) ? ld.top_signals : [];

  // ── Detect whether this is structured (v1.5+) or legacy data ──────────────
  const isStructured = topSignals.some(s => s.metric === 'SCENARIO_BULL_EPS_CAGR');

  // ── Parse price ranges and risk/reward from takeaway ──────────────────────
  // Prompt spec: allRanges[0]=Bull, [1]=Base, [2]=Bear
  const allRanges  = parsePriceRanges(takeaway);
  const riskReward = parseRiskReward(takeaway);

  // ── industry_growth signal ─────────────────────────────────────────────────
  const indGrowthSignal = signalObj(topSignals, 'INDUSTRY_GROWTH_BASE')
                       ?? signalObj(topSignals, 'industry_growth'); // legacy name
  const industryGrowthPct = indGrowthSignal?.actual_value ?? null;

  // ── Build per-scenario data ────────────────────────────────────────────────
  const scenarios = SCENARIO_ORDER.map((scenario, idx) => {
    const sc = scenario.toUpperCase(); // BULL / BASE / BEAR
    const range = allRanges[idx] ?? null;

    let industryGrowthForScenario, revCagrLow, revCagrHigh, marginPct, epsCagr, analystView;

    if (isStructured) {
      industryGrowthForScenario = signalValue(topSignals, `SCENARIO_${sc}_INDUSTRY_GROWTH`);
      revCagrLow                = signalValue(topSignals, `SCENARIO_${sc}_REV_CAGR_LOW`);
      revCagrHigh               = signalValue(topSignals, `SCENARIO_${sc}_REV_CAGR_HIGH`);
      marginPct                 = signalValue(topSignals, `SCENARIO_${sc}_MARGIN_PCT`);
      epsCagr                   = signalValue(topSignals, `SCENARIO_${sc}_EPS_CAGR`);
      analystView = (highlights[idx] ?? '').replace(/^(Bull|Base|Bear):\s*/i, '').trim();
    } else {
      // Legacy fallback: modulate industry CAGR per scenario
      industryGrowthForScenario = industryGrowthPct != null
        ? scenario === 'bull' ? parseFloat((industryGrowthPct * 1.2).toFixed(1))
          : scenario === 'bear' ? parseFloat((industryGrowthPct * 0.7).toFixed(1))
          : industryGrowthPct
        : null;
      const parsed = parseLegacyHighlight(highlights[idx] ?? '');
      revCagrLow  = parsed.revCagrLow;
      revCagrHigh = parsed.revCagrHigh;
      marginPct   = parsed.marginPct;
      epsCagr     = parsed.epsCagr;
      analystView = parsed.analystView;
    }

    // Rev CAGR label: "12–14%" or "8%"
    const revCagrLabel = revCagrLow != null && revCagrHigh != null
      ? revCagrLow !== revCagrHigh ? `${revCagrLow}–${revCagrHigh}%` : `${revCagrLow}%`
      : null;

    return {
      scenario,
      industry_growth_pct:  industryGrowthForScenario,
      rev_cagr_low:         revCagrLow,
      rev_cagr_high:        revCagrHigh,
      rev_cagr_label:       revCagrLabel,
      margin_pct:           marginPct,
      eps_cagr_pct:         epsCagr,
      analyst_view:         analystView,
      target_low:           range?.low  ?? null,
      target_high:          range?.high ?? null,
    };
  });

  // ── Bottom-bar summary (base scenario values + industry CAGR) ─────────────
  const baseSc = scenarios.find(s => s.scenario === 'base');
  const summaryBar = {
    base_eps_cagr_pct:   baseSc?.eps_cagr_pct    ?? null,
    base_rev_cagr_label: baseSc?.rev_cagr_label   ?? null,
    base_rev_cagr_pct:   baseSc?.rev_cagr_low     ?? null,
    industry_cagr_pct:   industryGrowthPct,
    industry_cagr_label: indGrowthSignal?.label    ?? null,
  };

  // ── Fetch Prowess annual timeseries for key financial metrics ─────────────
  const prowess = new ProwessHelper(prisma);
  const abbrs   = ['REV_OP', 'PAT', 'EBITDA_MARGIN', 'EPS_BASIC'];
  const annualBatch = await prowess.getAnnualBatch(sym, abbrs);

  const timeseriesMap = {};
  for (const abbr of abbrs) {
    timeseriesMap[abbr] = (annualBatch[abbr] ?? []).filter(p => p.value != null);
  }

  const revSeries  = timeseriesMap['REV_OP'];
  const patSeries  = timeseriesMap['PAT'];
  const epsSeries  = timeseriesMap['EPS_BASIC'];
  const margSeries = timeseriesMap['EBITDA_MARGIN'];

  // L4 average EBITDA margin for base anchoring
  const last4Marg   = margSeries.slice(-4).map(p => p.value);
  const baseMarginPct = last4Marg.length
    ? parseFloat((last4Marg.reduce((a, b) => a + b, 0) / last4Marg.length).toFixed(2))
    : null;

  // Historical 3Y CAGR context
  const revCagrActual = revSeries.length >= 2
    ? cagr(
        revSeries.at(-Math.min(4, revSeries.length))?.value ?? revSeries[0]?.value,
        revSeries.at(-1)?.value,
        Math.min(3, revSeries.length - 1),
      )
    : null;

  // ── Enrich top_signals with timeseries for matching abbrs ─────────────────
  const enrichedSignals = topSignals.map(signal => {
    const ts = timeseriesMap[signal.metric];
    if (!ts || ts.length === 0) return signal;
    return { ...signal, timeseries: { annual: ts, latest_quarter: null } };
  });

  return {
    ticker:      sym,
    call_id:     latestRow.call_id,
    available:   true,
    is_stale:    latestRow.is_stale,
    computed_at: latestRow.computed_at,
    score:       ld.score   ?? null,
    status:      ld.status  ?? null,
    z_score:     latestRow.z_score ?? null,
    takeaway,
    risks:       ld.risks       ?? [],
    key_metrics: ld.key_metrics ?? {},
    holding_period_years: HOLDING_YEARS,
    risk_reward:          riskReward,
    industry_growth: {
      pct:       industryGrowthPct,
      label:     indGrowthSignal?.label     ?? null,
      direction: indGrowthSignal?.direction ?? null,
      statement: indGrowthSignal?.statement ?? null,
    },
    scenarios,
    summary_bar: summaryBar,
    financial_context: {
      latest_rev_op:    revSeries.at(-1)?.value  ?? null,
      latest_pat:       patSeries.at(-1)?.value  ?? null,
      latest_eps:       epsSeries.at(-1)?.value  ?? null,
      base_margin_pct:  baseMarginPct,
      rev_cagr_actual:  revCagrActual,
      timeseries: {
        REV_OP:        revSeries,
        PAT:           patSeries,
        EBITDA_MARGIN: margSeries,
        EPS_BASIC:     epsSeries,
      },
    },
    top_signals: enrichedSignals,
  };
}

module.exports = { getEarningsForecast };
