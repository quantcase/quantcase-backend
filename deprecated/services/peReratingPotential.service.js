'use strict';

const prisma = require('../config/prisma');
const { ProwessHelper } = require('../utils/prowessHelper');

const HOLDING_YEARS = 3;

// ── P/E data helpers ──────────────────────────────────────────────────────────

// Fetch current P/E, price, EPS and 3-year historical percentile zones from nse_equity_new.
// Zones drive the "Cheap / Fair / Expensive" scale in the UI.
async function fetchPeData(sym) {
  const [latest, stats] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT pe::float AS pe, eps::float AS eps, close::float AS price, datetime AS as_of
      FROM   nse_equity_new
      WHERE  symbol = $1
        AND  pe IS NOT NULL
      ORDER  BY datetime DESC
      LIMIT  1
    `, sym),
    prisma.$queryRawUnsafe(`
      SELECT
        MIN(pe::float)                                             AS pe_min,
        MAX(pe::float)                                             AS pe_max,
        AVG(pe::float)                                             AS pe_avg,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY pe::float)   AS pe_p25,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY pe::float)   AS pe_p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY pe::float)   AS pe_p75
      FROM nse_equity_new
      WHERE  symbol   = $1
        AND  pe       IS NOT NULL
        AND  datetime >= NOW() - INTERVAL '3 years'
    `, sym),
  ]);

  const row = latest[0] ?? null;
  const st  = stats[0]  ?? null;

  if (!row) return null;

  return {
    current_pe:   row.pe    != null ? parseFloat(row.pe.toFixed(1))    : null,
    current_eps:  row.eps   != null ? parseFloat(row.eps.toFixed(2))   : null,
    current_price: row.price != null ? parseFloat(row.price.toFixed(1)) : null,
    pe_as_of:     row.as_of,
    pe_3y: st ? {
      min:  st.pe_min  != null ? parseFloat(parseFloat(st.pe_min).toFixed(1))  : null,
      max:  st.pe_max  != null ? parseFloat(parseFloat(st.pe_max).toFixed(1))  : null,
      avg:  st.pe_avg  != null ? parseFloat(parseFloat(st.pe_avg).toFixed(1))  : null,
      p25:  st.pe_p25  != null ? parseFloat(parseFloat(st.pe_p25).toFixed(1))  : null,
      p50:  st.pe_p50  != null ? parseFloat(parseFloat(st.pe_p50).toFixed(1))  : null,
      p75:  st.pe_p75  != null ? parseFloat(parseFloat(st.pe_p75).toFixed(1))  : null,
    } : null,
  };
}

// ── Signal lookup helpers ─────────────────────────────────────────────────────

function signalValue(signals, metric) {
  return signals.find(s => s.metric === metric)?.actual_value ?? null;
}

function signalGuided(signals, metric) {
  return signals.find(s => s.metric === metric)?.guided_value ?? null;
}

function signalObj(signals, metric) {
  return signals.find(s => s.metric === metric) ?? null;
}

// Collect all signals whose metric starts with a prefix (e.g. "CATALYST_POSITIVE_")
function signalsByPrefix(signals, prefix) {
  return signals.filter(s => s.metric?.startsWith(prefix));
}

// ── Fair value zone builder ───────────────────────────────────────────────────
// Maps the 3-year P/E distribution onto three labelled zones for the UI slider.
// cheap  = below p25   (historically cheap)
// fair   = p25 – p75   (normal range)
// expensive = above p75
function buildFairValueZone(pe3y) {
  if (!pe3y) return null;
  return {
    cheap_below:     pe3y.p25,
    fair_low:        pe3y.p25,
    fair_high:       pe3y.p75,
    expensive_above: pe3y.p75,
    midpoint:        pe3y.p50,
  };
}

// ── Compute narrative slider position (0–100) ─────────────────────────────────
// 50 = neutral; higher = stronger narrative / re-rating potential.
// Sources: LLM NARRATIVE_SCORE signal (authoritative), or z_score fallback.
function narrativeScore(topSignals, zScore) {
  const llm = signalValue(topSignals, 'NARRATIVE_SCORE');
  if (llm != null) return Math.round(Math.max(0, Math.min(100, llm)));
  if (zScore != null) return Math.round(Math.max(0, Math.min(100, 50 + zScore * 10)));
  return 50;
}

// ── Build scenario cards ──────────────────────────────────────────────────────

function buildScenario(signals, type) {
  const sc  = type.toUpperCase(); // BEAR | BASE | BULL
  const peLow   = signalValue(signals, `SCENARIO_${sc}_PE_RANGE`);
  const peHigh  = signalGuided(signals, `SCENARIO_${sc}_PE_RANGE`);
  const retLow  = signalValue(signals, `SCENARIO_${sc}_RETURN`);
  const retHigh = signalGuided(signals, `SCENARIO_${sc}_RETURN`);
  const whatHappensSignal = signalObj(signals, `SCENARIO_${sc}_WHAT_HAPPENS`);

  // Fallback: parse range from statement if actual_value not stored
  const peRange = peLow != null && peHigh != null
    ? `${peLow}–${peHigh}x`
    : signalObj(signals, `SCENARIO_${sc}_PE_RANGE`)?.statement ?? null;

  const retLabel = retLow != null && retHigh != null
    ? retLow === retHigh ? `${retLow > 0 ? '+' : ''}${retLow}%` : `${retLow > 0 ? '+' : ''}${retLow}% to ${retHigh > 0 ? '+' : ''}${retHigh}%`
    : null;

  return {
    scenario:        type,
    pe_low:          peLow,
    pe_high:         peHigh,
    pe_range_label:  peRange,
    return_low:      retLow,
    return_high:     retHigh,
    return_label:    retLabel,
    what_happens:    whatHappensSignal?.statement ?? null,
  };
}

// ── Main service ──────────────────────────────────────────────────────────────

async function getPeReratingPotential(ticker) {
  const sym = ticker.toUpperCase();

  const latestRow = await prisma.lensScore.findFirst({
    where:   { ticker: sym, lens_slug: 'pe-rerating-potential' },
    select:  { call_id: true, lens_data: true, computed_at: true, is_stale: true, z_score: true },
    orderBy: { computed_at: 'desc' },
  });

  if (!latestRow) {
    return { ticker: sym, available: false, error: 'pe-rerating-potential lens not computed for ticker' };
  }

  const ld         = latestRow.lens_data ?? {};
  const topSignals = Array.isArray(ld.top_signals) ? ld.top_signals : [];

  // ── Live P/E data from nse_equity_new ────────────────────────────────────
  const peData = await fetchPeData(sym);

  // ── Fair value zone ───────────────────────────────────────────────────────
  const fairValueZone = peData ? buildFairValueZone(peData.pe_3y) : null;

  // ── Scenarios ────────────────────────────────────────────────────────────
  const scenarios = ['bear', 'base', 'bull'].map(t => buildScenario(topSignals, t));
  const baseScenario = scenarios.find(s => s.scenario === 'base');

  // ── Catalysts ────────────────────────────────────────────────────────────
  const positives = signalsByPrefix(topSignals, 'CATALYST_POSITIVE_').map(s => ({
    label:     s.label     ?? null,
    statement: s.statement ?? null,
  }));
  const negatives = signalsByPrefix(topSignals, 'CATALYST_NEGATIVE_').map(s => ({
    label:     s.label     ?? null,
    statement: s.statement ?? null,
  }));

  // Fallback: parse from highlights if no CATALYST_* signals stored
  if (!positives.length && ld.highlights?.length) {
    positives.push({ label: ld.highlights[0] ?? null, statement: null });
    if (ld.highlights[1]) positives.push({ label: ld.highlights[1], statement: null });
  }
  if (!negatives.length && ld.risks?.length) {
    negatives.push({ label: ld.risks[0] ?? null, statement: null });
    if (ld.risks[1]) negatives.push({ label: ld.risks[1], statement: null });
  }

  // ── Narrative slider ─────────────────────────────────────────────────────
  const narScore   = narrativeScore(topSignals, latestRow.z_score);
  const narLabelSig = signalObj(topSignals, 'NARRATIVE_LABEL');
  const narDescSig  = signalObj(topSignals, 'NARRATIVE_DESCRIPTION');

  // ── Prowess fundamentals (ROE, ROA, PAT timeseries) ─────────────────────
  const prowess     = new ProwessHelper(prisma);
  const abbrs       = ['ROE', 'ROA', 'PAT'];
  const annualBatch = await prowess.getAnnualBatch(sym, abbrs);

  const timeseriesMap = {};
  for (const abbr of abbrs) {
    timeseriesMap[abbr] = (annualBatch[abbr] ?? []).filter(p => p.value != null);
  }

  // Enrich fundamental signals (ROA, ROE, PAT) with timeseries
  const enrichedSignals = topSignals.map(signal => {
    const ts = timeseriesMap[signal.metric];
    if (!ts || !ts.length) return signal;
    return { ...signal, timeseries: { annual: ts, latest_quarter: null } };
  });

  // Latest values from Prowess for display
  const latestRoe = timeseriesMap['ROE'].at(-1)?.value ?? null;
  const latestRoa = timeseriesMap['ROA'].at(-1)?.value ?? null;
  const latestPat = timeseriesMap['PAT'].at(-1)?.value ?? null;
  const latestPatFy = timeseriesMap['PAT'].at(-1)?.fiscal_year ?? null;

  // ── Base case summary bar ────────────────────────────────────────────────
  const summaryBar = {
    base_pe_range_label: baseScenario?.pe_range_label ?? null,
    base_pe_low:         baseScenario?.pe_low         ?? null,
    base_pe_high:        baseScenario?.pe_high        ?? null,
    base_return_label:   baseScenario?.return_label   ?? null,
    holding_years:       HOLDING_YEARS,
    current_pe:          peData?.current_pe           ?? null,
  };

  return {
    ticker:       sym,
    call_id:      latestRow.call_id,
    available:    true,
    is_stale:     latestRow.is_stale,
    computed_at:  latestRow.computed_at,
    score:        ld.score   ?? null,
    status:       ld.status  ?? null,
    z_score:      latestRow.z_score ?? null,
    takeaway:     ld.takeaway     ?? null,
    highlights:   ld.highlights   ?? [],
    risks:        ld.risks        ?? [],
    key_metrics:  ld.key_metrics  ?? {},

    // Live market data
    current_pe:    peData?.current_pe    ?? null,
    current_eps:   peData?.current_eps   ?? null,
    current_price: peData?.current_price ?? null,
    pe_as_of:      peData?.pe_as_of      ?? null,
    pe_3y:         peData?.pe_3y         ?? null,

    // Fair value zone for slider
    fair_value_zone: fairValueZone,

    // Scenario engine
    scenarios,
    summary_bar: summaryBar,

    // Narrative panel
    narrative: {
      score:       narScore,
      label:       narLabelSig?.label     ?? narLabelSig?.statement ?? ld.status ?? null,
      description: narDescSig?.statement  ?? null,
    },

    // Catalyst panels
    positive_catalysts: positives,
    negative_catalysts: negatives,

    // Financials
    financial_context: {
      latest_roe:    latestRoe,
      latest_roa:    latestRoa,
      latest_pat:    latestPat,
      latest_pat_fy: latestPatFy,
      timeseries: {
        ROE: timeseriesMap['ROE'],
        ROA: timeseriesMap['ROA'],
        PAT: timeseriesMap['PAT'],
      },
    },

    top_signals: enrichedSignals,
  };
}

module.exports = { getPeReratingPotential };
