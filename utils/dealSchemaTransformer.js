'use strict';

/**
 * Flat-to-nested transformers for deal analysis LLM output.
 *
 * The LLM emits flat JSON (prefixed keys, all required → 0 optional params) to
 * stay within Anthropic's grammar compilation limit (max 24 optional params).
 * These functions reconstruct the original nested structure that dealMapper.js
 * and the DB expect — so the stored format is unchanged.
 */

// ─── Scenarios ────────────────────────────────────────────────────────────────

function _toScenario(flat, prefix) {
  return {
    eps_cagr_pct:        flat[`${prefix}_eps_cagr_pct`]       ?? null,
    fy_eps:              flat[`${prefix}_fy_eps`]              ?? null,
    exit_pe_low:         flat[`${prefix}_exit_pe_low`]         ?? null,
    exit_pe_high:        flat[`${prefix}_exit_pe_high`]        ?? null,
    exit_pe_rationale:   flat[`${prefix}_exit_pe_rationale`]   ?? null,
    target_price_low:    flat[`${prefix}_target_price_low`]    ?? null,
    target_price_high:   flat[`${prefix}_target_price_high`]   ?? null,
    upside_downside_pct: flat[`${prefix}_upside_downside_pct`] ?? null,
    cagr_pa_pct:         flat[`${prefix}_cagr_pa_pct`]         ?? null,
    probability_pct:     flat[`${prefix}_probability_pct`]     ?? null,
    key_drivers:         flat[`${prefix}_key_drivers`]         ?? [],
    signal_points:       flat[`${prefix}_signal_points`]       ?? [],
  };
}

function scenariosFlatToNested(flat) {
  return {
    scenario_framework: {
      meta: {
        cmp:                    flat.meta_cmp           ?? null,
        forecast_horizon_years: flat.meta_horizon_years ?? 3,
      },
      bear: _toScenario(flat, 'bear'),
      base: _toScenario(flat, 'base'),
      bull: _toScenario(flat, 'bull'),
    },
    risk_reward_summary: {
      probability_weighted_return_pct: flat.rrs_probability_weighted_return_pct ?? null,
      risk_reward_ratio:               flat.rrs_risk_reward_ratio               ?? null,
      downside_protection_pct:         flat.rrs_downside_protection_pct         ?? null,
      investment_thesis:               flat.rrs_investment_thesis               ?? null,
      key_risks:                       flat.rrs_key_risks                       ?? [],
      key_catalysts:                   flat.rrs_key_catalysts                   ?? [],
    },
  };
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function overviewFlatToNested(flat) {
  return {
    overview: {
      eps_engine_card: {
        score:   flat.overview_eps_engine_score   ?? null,
        drivers: flat.overview_eps_engine_drivers ?? [],
      },
      valuation_rerating_card: {
        score:   flat.overview_val_rerating_score   ?? null,
        drivers: flat.overview_val_rerating_drivers ?? [],
      },
      deal_factor_score: {
        overall:            flat.overview_dfs_overall            ?? null,
        eps_engine:         flat.overview_dfs_eps_engine         ?? null,
        valuation_rerating: flat.overview_dfs_valuation_rerating ?? null,
        level:              flat.overview_dfs_level              ?? null,
      },
      key_takeaway: flat.overview_key_takeaway ?? [],
      deal_verdict: {
        title:       flat.overview_verdict_title       ?? null,
        description: flat.overview_verdict_description ?? null,
      },
      scenario_summary: {
        bear: { label: flat.overview_bear_label ?? null, headline: flat.overview_bear_headline ?? null, subtext: flat.overview_bear_subtext ?? null },
        base: { label: flat.overview_base_label ?? null, headline: flat.overview_base_headline ?? null, subtext: flat.overview_base_subtext ?? null },
        bull: { label: flat.overview_bull_label ?? null, headline: flat.overview_bull_headline ?? null, subtext: flat.overview_bull_subtext ?? null },
      },
    },
  };
}

// ─── Detailed ─────────────────────────────────────────────────────────────────

function _toEpsScenario(flat, prefix) {
  return {
    industry_cagr:     flat[`${prefix}_industry_cagr`]     ?? null,
    revenue_growth:    flat[`${prefix}_revenue_growth`]    ?? {},
    margin_trajectory: flat[`${prefix}_margin_trajectory`] ?? {},
    execution_alpha:   flat[`${prefix}_execution_alpha`]   ?? {},
    expected_eps_cagr: flat[`${prefix}_expected_eps_cagr`] ?? null,
  };
}

function detailedFlatToNested(flat) {
  return {
    detailed_analysis: {
      eps_engine: {
        bear:    _toEpsScenario(flat, 'eps_bear'),
        base:    _toEpsScenario(flat, 'eps_base'),
        bull:    _toEpsScenario(flat, 'eps_bull'),
        insight: flat.eps_insight ?? null,
      },
      historical_performance: {
        company_growth:  flat.hist_company_growth  ?? null,
        industry_growth: flat.hist_industry_growth ?? null,
        chart_data:      flat.hist_chart_data      ?? [],
        stats:           flat.hist_stats           ?? [],
      },
      quality_of_earnings: {
        metrics:     flat.qoe_metrics     ?? [],
        chart_data:  flat.qoe_chart_data  ?? [],
        bottom_line: flat.qoe_bottom_line ?? null,
      },
      valuation_vs_peers: {
        current_position: flat.vvp_current_position ?? [],
        re_rating_view: {
          badge:       flat.vvp_re_rating_badge       ?? null,
          title:       flat.vvp_re_rating_title       ?? null,
          description: flat.vvp_re_rating_description ?? [],
        },
        expansion_drivers:  flat.vvp_expansion_drivers  ?? [],
        contraction_risks:  flat.vvp_contraction_risks  ?? [],
        scenario_multiples: flat.vvp_scenario_multiples ?? [],
      },
    },
  };
}

module.exports = { scenariosFlatToNested, overviewFlatToNested, detailedFlatToNested };
