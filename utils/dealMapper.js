'use strict';

/**
 * Map raw Claude deal output → DealResponseSchema display format.
 *
 * Raw shape (stored in DB):
 *   scenario_framework.{ meta, bear, base, bull }
 *   risk_reward_summary.{ probability_weighted_return_pct, risk_reward_ratio,
 *                          downside_protection_pct, investment_thesis,
 *                          key_risks, key_catalysts }
 *
 * Target shape (DealResponseSchema in utils/constants.js):
 *   scenario_framework.{ meta, bear.points[], base.points[], bull.points[] }
 *   target_price_matrix.{ meta, holding_period, current_price, bear, base, bull }
 *   risk_reward_summary.{ meta, probability_weighted_return, risk_reward_ratio, downside_protection }
 */
function mapToDealResponseSchema(raw) {
  const sf  = raw?.scenario_framework;
  const rrs = raw?.risk_reward_summary;

  if (!sf || !rrs) return raw; // passthrough if shape is unexpected

  const meta = sf.meta ?? {};
  const cmp  = meta.cmp ?? null;

  // ── helpers ──────────────────────────────────────────────────────────────

  /** "+12%" or "-5%" */
  function pctStr(n) {
    if (n == null) return 'N/A';
    return `${n >= 0 ? '+' : ''}${n}%`;
  }

  /** "CAGR: +17.2% p.a." */
  function cagrStr(n) {
    if (n == null) return 'N/A';
    return `CAGR: ${n >= 0 ? '+' : ''}${n}% p.a.`;
  }

  /** Map one scenario's raw fields → target_price_matrix row */
  function scenarioMatrix(s) {
    return {
      eps_cagr:     `${s.eps_cagr_pct}%`,
      fy_eps:       `₹${s.fy_eps}`,
      exit_pe:      `${s.exit_pe_low}-${s.exit_pe_high}x`,
      pe_rationale: s.exit_pe_rationale,
      target_range: `₹${s.target_price_low}-${s.target_price_high}`,
      from_cmp:     pctStr(s.upside_downside_pct),
      cagr:         cagrStr(s.cagr_pa_pct),
      probability:  s.probability_pct,
    };
  }

  // ── Compute metrics server-side from scenario prices ─────────────────────

  function midPrice(s) { return (s.target_price_low + s.target_price_high) / 2; }

  // Per-scenario return % from CMP (recomputed from prices, not LLM value)
  function scenarioReturnPct(s) {
    if (cmp == null || cmp === 0) return s.upside_downside_pct ?? 0;
    return (midPrice(s) - cmp) / cmp * 100;
  }

  const bearRet = scenarioReturnPct(sf.bear);
  const baseRet = scenarioReturnPct(sf.base);
  const bullRet = scenarioReturnPct(sf.bull);

  // Probability-Weighted Return = Σ (prob × return)
  const pwr = parseFloat((
    (sf.bear.probability_pct / 100) * bearRet +
    (sf.base.probability_pct / 100) * baseRet +
    (sf.bull.probability_pct / 100) * bullRet
  ).toFixed(1));

  // Downside Protection = (P0 − P_bear_mid) / P0
  const downsidePct = cmp != null && cmp !== 0
    ? parseFloat(((cmp - midPrice(sf.bear)) / cmp * 100).toFixed(1))
    : null;

  // Risk-Reward Ratio = weighted upside / weighted downside
  const scenarios = [
    { ret: bearRet, prob: sf.bear.probability_pct },
    { ret: baseRet, prob: sf.base.probability_pct },
    { ret: bullRet, prob: sf.bull.probability_pct },
  ];
  const wUpside   = scenarios.filter(s => s.ret > 0).reduce((sum, s) => sum + (s.prob / 100) * s.ret, 0);
  const wDownside = scenarios.filter(s => s.ret < 0).reduce((sum, s) => sum + (s.prob / 100) * Math.abs(s.ret), 0);
  const rrRatio   = wDownside > 0 ? parseFloat((wUpside / wDownside).toFixed(1)) : null;

  return {
    scenario_framework: {
      meta: {
        section_id: 'scenario_framework',
        title:      'Scenario Framework',
      },
      bear: { points: sf.bear.key_drivers ?? [], signal_points: sf.bear.signal_points ?? [] },
      base: { points: sf.base.key_drivers ?? [], signal_points: sf.base.signal_points ?? [] },
      bull: { points: sf.bull.key_drivers ?? [], signal_points: sf.bull.signal_points ?? [] },
    },

    target_price_matrix: {
      meta: {
        section_id: 'target_price_matrix',
        title:      `Target Price Matrix (${meta.forecast_horizon_years ?? 3}Y Exit)`,
      },
      holding_period: `${meta.forecast_horizon_years ?? 3}-year holding period`,
      current_price:  cmp != null ? `₹${cmp}` : 'N/A',
      bear: scenarioMatrix(sf.bear),
      base: scenarioMatrix(sf.base),
      bull: scenarioMatrix(sf.bull),
    },

    risk_reward_summary: {
      meta: { section_id: 'risk_reward_summary', title: 'Risk-Reward Summary' },

      probability_weighted_return: {
        label:    'Probability-Weighted Return',
        value:    pctStr(pwr),
        subtitle: 'Blended across bear/base/bull probabilities',
      },

      risk_reward_ratio: {
        label:    'Risk / Reward Ratio',
        value:    rrRatio != null ? `1:${rrRatio}` : 'N/A',
        subtitle: rrRatio != null ? `For every ₹1 of downside, ₹${rrRatio} of upside` : 'N/A',
      },

      downside_protection: {
        label:    'Max Downside (Bear)',
        value:    downsidePct != null ? pctStr(parseFloat((-downsidePct).toFixed(1))) : 'N/A',
        subtitle: `Bear case at ${sf.bear.probability_pct}% probability`,
      },

      investment_thesis:  rrs.investment_thesis  ?? null,
      key_risks:          rrs.key_risks          ?? [],
      key_catalysts:      rrs.key_catalysts       ?? [],
    },

    // Pass overview straight through — LLM generates in final shape
    overview: raw?.overview ?? null,

    // Pass detailed_analysis straight through — LLM generates in final shape
    detailed_analysis: raw?.detailed_analysis ?? null,
  };
}

module.exports = { mapToDealResponseSchema };
