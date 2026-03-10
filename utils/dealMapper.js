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

  // ── build probability_weighted_return display value ──────────────────────
  // Support both stored pct (number) and pre-formatted string (from older records)
  const pwrRaw = rrs.probability_weighted_return_pct;
  const pwrNum = typeof pwrRaw === 'number' ? pwrRaw : parseFloat(String(pwrRaw ?? '').replace('%', ''));
  const pwrDisplay = !isNaN(pwrNum) ? pctStr(pwrNum) : (pwrRaw ?? 'N/A');
  const pwrCagrNum = !isNaN(pwrNum)
    ? parseFloat(((Math.pow(1 + pwrNum / 100, 1 / 3) - 1) * 100).toFixed(1))
    : null;

  // ── risk_reward_ratio: handle number or "1:2.8" string ───────────────────
  const rrRaw = rrs.risk_reward_ratio;
  const rrDisplay = rrRaw != null
    ? (typeof rrRaw === 'number' ? `${rrRaw}x` : String(rrRaw))
    : 'N/A';

  return {
    scenario_framework: {
      meta: {
        section_id: 'scenario_framework',
        title:      'Scenario Framework',
      },
      bear: { points: sf.bear.key_drivers ?? [] },
      base: { points: sf.base.key_drivers ?? [] },
      bull: { points: sf.bull.key_drivers ?? [] },
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
        value:    pwrDisplay,
        subtitle: pwrCagrNum != null
          ? `Blended across bear/base/bull probabilities`
          : 'N/A',
      },

      risk_reward_ratio: {
        label:    'Risk / Reward Ratio',
        value:    rrDisplay,
        subtitle: `For every ₹1 of downside, ₹${typeof rrRaw === 'number' ? rrRaw : '?'} of upside`,
      },

      downside_protection: {
        label:    'Max Downside (Bear)',
        value:    pctStr(rrs.downside_protection_pct),
        subtitle: `Bear case at ${sf.bear.probability_pct}% probability weighted`,
      },
    },

    // Pass detailed_analysis straight through — LLM generates in final shape
    detailed_analysis: raw?.detailed_analysis ?? null,
  };
}

module.exports = { mapToDealResponseSchema };
