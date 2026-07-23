[Docs](../README.md) · [Specs](../README.md#existing-reference-material) · Deal Lenses UI Fixes

# Backend Fix Requirements — Deal Lenses

All changes are additive — no existing keys are removed or renamed. The generic schema (slug, key_metrics, highlights, risks, top_signals, takeaway, score, status) stays identical for all lens categories.

1. earnings-forecast — add 12 keys to key_metrics
These are forward-looking scenario projections. The backend already computes a bear/base/bull thesis (evidenced by highlights and takeaway) — these keys just need to be materialised into key_metrics.


bear_industry_cagr        "3.5%"
bear_revenue_growth       "9.5%"
bear_margin_trajectory    "-100bps"
bear_eps_cagr             "8.2%"

base_industry_cagr        "5.0%"
base_revenue_growth       "15.2%"
base_margin_trajectory    "+50bps"
base_eps_cagr             "16.8%"

bull_industry_cagr        "7.5%"
bull_revenue_growth       "21.8%"
bull_margin_trajectory    "+150bps"
bull_eps_cagr             "24.6%"
Values are always formatted strings with units inline (%, bps). Positive bps must include + prefix. EPS CAGR for bear case may be negative.

2. target-price-matrix — add 27 keys to key_metrics

current_price             "₹2,560"       ← CMP at time of computation

bear_target_lo            "₹1,855"
bear_target_hi            "₹2,113"
bear_from_cmp             "-18.3%"       ← always includes sign and % suffix
bear_cagr                 "-6.4%"        ← price CAGR p.a., includes sign
bear_eps_cagr             "-3.0%"
bear_exit_pe              "18–21x"       ← range with en-dash
bear_fy_eps               "₹103"

base_target_lo            "₹3,122"
base_target_hi            "₹3,548"
base_from_cmp             "+26.0%"
base_cagr                 "+8.0%"
base_eps_cagr             "8.0%"
base_exit_pe              "22–25x"
base_fy_eps               "₹142"

bull_target_lo            "₹4,457"
bull_target_hi            "₹5,057"
bull_from_cmp             "+84.8%"
bull_cagr                 "+15.0%"
bull_eps_cagr             "15.0%"
bull_exit_pe              "26–30x"
bull_fy_eps               "₹171"

weighted_cagr_range       "+7% to +9%"
weighted_target_range     "₹2,950–₹3,250"
weighted_from_cmp_range   "+15% to +27%"
risk_reward_ratio         "1.6"          ← numeric string, no x suffix
risk_reward_label         "Attractive"   ← one of: Attractive / Moderate / Cautious
highlights[0] → bull narrative, highlights[1] → base narrative, risks[0] → bear narrative. These are already being populated correctly.

3. pe-rerating-potential — add 3 keys to key_metrics

current_pe              "22x"
pe_zone                 "Fair"           ← one of: Cheap / Fair / Expensive
pe_zone_marker_pct      "58"             ← integer string 0–100, position on cheap→expensive slider
Additionally: highlights, risks, and top_signals are empty for some companies (confirmed: PNB, TATAMOTORS). The UI's catalysts panel and narrative section render directly from those fields. Ensure the computation runs and populates them for all companies.

4. earning-quality — no new keys needed
The frontend now renders directly from whichever top_signals are present, and from highlights/risks. The only issue here is consistency of computation: ICICIBANK has empty top_signals, highlights, and risks. Ensure the computation runs for all companies.

The SEG_* prefixed signal metrics (e.g. SEG_RETAIL_LOAN_GROWTH, SEG_BFSI_REV_GROWTH_YoY, SEG_HOME_LOAN_AUM_GROWTH) are already the right shape — no renaming needed.

5. Computation coverage gap — TATAMOTORS, MSWIL, ICICIBANK
These companies return empty shells (highlights: [], risks: [], takeaway: null, key_metrics: {}) across all four deal lenses. Adding the new keys won't help until the computation actually runs. These are not a schema problem — the compute job is simply not completing or not being triggered for these companies.

No-change confirmation
Field	Change needed
Top-level schema	None
slug, name, description, category, score, status, z_score, signal_count, computed_at	None
takeaway	None — already correct
highlights / risks	None for most; ensure populated for PNB pe-rerating-potential, TATAMOTORS, MSWIL
top_signals structure	None — signal shape is correct; only earning-quality needs compute coverage fixed
key_metrics for management / opportunity lenses	None — untouched