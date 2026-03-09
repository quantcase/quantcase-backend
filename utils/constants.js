const FINCRUX_METRICS = [
  "ROE",
  "ROCE",
  "Stock P/E",
  "Book Value",
  "Face Value",
  "High / Low",
  "Market Cap",
  "Current Price",
  "Dividend Yield",
  "Sales",
  "Expenses",
  "Operating Profit",
  "OPM %",
  "Other Income",
  "Interest",
  "Depreciation",
  "Profit before tax",
  "Tax %",
  "Net Profit",
  "EPS in Rs",
  "Raw PDF",
  "Dividend Payout %",
  "Equity Capital",
  "Reserves",
  "Borrowings",
  "Other Liabilities",
  "Total Liabilities",
  "Fixed Assets",
  "CWIP",
  "Investments",
  "Other Assets",
  "Total Assets",
  "Cash from Operating Activity",
  "Cash from Investing Activity",
  "Cash from Financing Activity",
  "Net Cash Flow",
  "Debtor Days",
  "Inventory Days",
  "Days Payable",
  "Cash Conversion Cycle",
  "Working Capital Days",
  "Promoters",
  "Public",
  "No. of Shareholders"
];



OFactorResponseSchema = {
  "competition": {
    "meta": { "title": "Competition", "subtitle": "Competitive dynamics & positioning analysis", "section_id": "4.2" },
    "text": {
      "takeaway": "<string: 1-sentence competitive summary>",
      "pricing_power_dynamics": {
        "current_state":     "<string: 10 words max>",
        "watch_outs":        "<string: 10 words max>",
        "future_trajectory": "<string: 10 words max>",
        "shifting_dynamics": "<string: 10 words max>"
      },
      "competitive_positioning": {
        "strengths":        ["<string: 10 words max>"],
        "opportunities":    ["<string: 10 words max>"],
        "areas_to_monitor": ["<string: 10 words max>"]
      }
    },
    "metrics": {
      "porters_score":         { "label": "Porter's Score",        "value": "<X/10>",               "sublabel": "<string>" },
      "pricing_power":         { "label": "Pricing Power",         "value": "<Low|Moderate|High>",  "sublabel": "<string>" },
      "entry_barriers":        { "label": "Entry Barriers",        "value": "<Low|Moderate|High>",  "sublabel": "<string>" },
      "market_position":       { "label": "Market Position",       "value": "<string>",             "sublabel": "<string>" },
      "competitive_intensity": { "label": "Competitive Intensity", "value": "<Low|Moderate|High>",  "sublabel": "<string>" }
    }
  },
  "customer_traction": {
    "meta": { "title": "Client/Customer Traction", "subtitle": "Customer growth, retention & revenue trajectory with signals from management commentary", "section_id": "4.4" },
    "text": {
      "takeaway": "<string: 1-sentence customer traction summary>",
      "retention": {
        "metrics": {
          "net_revenue_retention":   { "label": "Net Revenue Retention",   "value": "<string|null>", "sublabel": "<string>" },
          "gross_revenue_retention": { "label": "Gross Revenue Retention", "value": "<string|null>", "sublabel": "<string>" },
          "expansion_revenue":       { "label": "Expansion Revenue",       "value": "<string|null>", "sublabel": "<string>" },
          "annual_churn":            { "label": "Annual Churn",            "value": "<string|null>", "sublabel": "<string>" }
        },
        "expansion_drivers":  ["<string: 10 words max>"],
        "product_stickiness": ["<string: 10 words max>"]
      },
      "key_takeaway": "<string: 10 words max>",
      "segmentation": {
        "tiers": [{
          "tier": "<string>", "customer_count": "<string>", "avg_acv": "<string>",
          "nrr": "<string>", "nrr_label": "<string>",
          "churn": "<string>", "churn_label": "<string>",
          "revenue_share": "<string>", "contract_terms": "<string>"
        }],
        "growth_strategy": ["<string: 10 words max>"],
        "revenue_quality":  ["<string: 10 words max>"]
      },
      "customer_growth": {
        "metrics": {
          "current_base":    { "label": "Current Customer Base", "value": "<string|null>", "sublabel": "<string>" },
          "five_year_growth":{ "label": "5Y Customer Growth",   "value": "<string|null>", "sublabel": "<string>" },
          "new_adds":        { "label": "New Adds",             "value": "<string|null>", "sublabel": "<string>" },
          "churned":         { "label": "Churned",              "value": "<string|null>", "sublabel": "<string>" }
        },
        "acquisition_dynamics": ["<string: 10 words max>"]
      },
      "alt_data_signals": [{ "source": "<string>", "insight": "<string: 10 words max>" }]
    },
    "metrics": {
      "churn_rate":           { "label": "Churn Rate / AUM Attrition",            "value": "<string|null>", "sublabel": "<string>" },
      "net_retention":        { "label": "Net Revenue Retention / ARR Retention", "value": "<string|null>", "sublabel": "<string>" },
      "active_customers":     { "label": "Active Customers",                      "value": "<string|null>", "sublabel": "<string>" },
      "avg_contract_value":   { "label": "Avg Contract / AUM Value",              "value": "<string|null>", "sublabel": "<string>" },
      "top_10_concentration": { "label": "Top-10 Concentration",                  "value": "<string|null>", "sublabel": "<string>" }
    }
  },
  "industry_overview": {
    "meta": { "title": "Industry Overview & Market", "subtitle": "Synthesized from public company transcripts & filings", "section_id": "4.1" },
    "text": {
      "takeaway": "<string: 1-sentence industry summary>",
      "opm_trend": {
        "metrics": {
          "current_opm":     { "label": "Current OPM",        "value": "<string|null>", "sublabel": "<string>" },
          "five_year_change": { "label": "5Y OPM Change",     "value": "<string|null>", "sublabel": "<string>" },
          "ten_year_change":  { "label": "10Y OPM Change",    "value": "<string|null>", "sublabel": "<string>" },
          "trend_direction":  { "label": "Trend Direction",   "value": "<Improving|Stable|Declining>", "sublabel": "<string>" }
        },
        "margin_drivers":   ["<string: 10 words max>"],
        "forward_outlook":  "<string: 10 words max>",
        "key_observations": ["<string: 10 words max>"]
      },
      "industry_transcripts": [{
        "company": "<string>", "sector": "<string>",
        "context": "<string>", "quote": "<verbatim quote from transcript>"
      }],
      "demand_supply_dynamics": {
        "demand":     "<string: 10 words max>",
        "supply":     "<string: 10 words max>",
        "net_impact": "<string: 10 words max>"
      }
    },
    "metrics": {
      "industry_revenue_ttm": { "label": "Industry Revenue TTM",   "value": "<string|null>",         "sublabel": "<string>" },
      "current_opm":          { "label": "Current OPM",            "value": "<string>",              "sublabel": "<string>" },
      "market_size":          { "label": "Market Size / AUM",      "value": "<string|null>",         "sublabel": "<string>" },
      "demand_signal":        { "label": "Demand Signal",          "value": "<Weak|Moderate|Strong>","sublabel": "<string>" },
      "industry_cagr":        { "label": "Industry Revenue CAGR",  "value": "<string|null>",         "sublabel": "<string>" },
      "supply_constraint":    { "label": "Supply Constraint",      "value": "<Low|Moderate|High>",   "sublabel": "<string>" }
    }
  },
  "financial_strength": {
    "meta": { "title": "Financial Strength", "subtitle": "Snapshot from financial statements, investor decks & management commentary", "section_id": "4.3" },
    "text": {
      "takeaway": "<string: 1-sentence financial strength summary>",
      "cash_flow": {
        "metrics": {
          "fcf":            { "label": "Free Cash Flow",       "value": "<string|null>", "sublabel": "<string>" },
          "fcf_conversion": { "label": "FCF Conversion",       "value": "<string|null>", "sublabel": "<string>" },
          "ocf_ebitda":     { "label": "OCF / EBITDA",         "value": "<string|null>", "sublabel": "<string>" },
          "working_capital":{ "label": "Working Capital Days", "value": "<string|null>", "sublabel": "<string>" }
        },
        "quality_analysis": ["<string: 10 words max>"]
      },
      "key_takeaway": "<string: 10 words max>",
      "balance_sheet": {
        "metrics": {
          "net_debt_ebitda":  { "label": "Net Debt / EBITDA",   "value": "<string|null>", "sublabel": "<string>" },
          "debt_equity":      { "label": "Debt / Equity",       "value": "<string|null>", "sublabel": "<string>" },
          "interest_coverage":{ "label": "Interest Coverage",   "value": "<string|null>", "sublabel": "<string>" },
          "current_ratio":    { "label": "Current Ratio",       "value": "<string|null>", "sublabel": "<string>" },
          "credit_rating":    { "label": "Credit Rating",       "value": "<string|null>", "sublabel": "<string>" }
        },
        "strengths":      ["<string: 10 words max>"],
        "considerations": ["<string: 10 words max>"]
      },
      "profitability": {
        "metrics": {
          "ebitda_margin":      { "label": "EBITDA / OPM Margin",    "value": "<string|null>", "sublabel": "<string>" },
          "pat_margin":         { "label": "PAT Margin",              "value": "<string|null>", "sublabel": "<string>" },
          "five_year_improvement": { "label": "5Y Margin Improvement","value": "<string|null>", "sublabel": "<string>" }
        },
        "operating_leverage_drivers":   ["<string: 10 words max>"],
        "strategic_initiative_drivers": ["<string: 10 words max>"]
      },
      "revenue_growth": {
        "drivers": ["<string: 10 words max>"],
        "metrics": {
          "revenue":        { "label": "Revenue (Sales)",    "value": "<string|null>", "sublabel": "<string>" },
          "five_year_cagr": { "label": "5Y Revenue CAGR",   "value": "<string|null>", "sublabel": "<string>" },
          "peak_growth":    { "label": "Peak YoY Growth",   "value": "<string|null>", "sublabel": "<string>" },
          "growth_quality": { "label": "Growth Quality",    "value": "<string|null>", "sublabel": "<string>" }
        }
      }
    },
    "metrics": {
      "revenue":           { "label": "Revenue",              "value": "<string>",      "sublabel": "<string>" },
      "gross_margin":      { "label": "Gross Margin %",       "value": "<string|null>", "sublabel": "<string>" },
      "ebitda_margin":     { "label": "EBIT/OPM Margin",      "value": "<string|null>", "sublabel": "<string>" },
      "pat":               { "label": "PAT (TTM)",            "value": "<string|null>", "sublabel": "<string>" },
      "free_cash_flow":    { "label": "FCF (TTM)",            "value": "<string|null>", "sublabel": "<string>" },
      "interest_coverage": { "label": "Interest Coverage",    "value": "<string|null>", "sublabel": "<string>" },
      "roce":              { "label": "ROCE",                 "value": "<string|null>", "sublabel": "<string>" },
      "roe":               { "label": "ROE",                  "value": "<string|null>", "sublabel": "<string>" }
    },
    "operating_leverage": {
      "meta": { "section_id": "4.3.1", "title": "Operating Leverage Analysis" },
      "fixed_cost_equation": "Fixed Costs = Employee Costs + SGA + D&A",
      "dol_chart_data": [{ "quarter": "<string>", "revenue_growth": "<number>", "ebit_growth": "<number>", "dol": "<number>" }],
      "fixed_cost_lines": [
        { "name": "Employee Costs", "key": "employee_costs", "color": "#3b82f6", "current_pct": "<number>", "prior_pct": "<number>", "change_bps": "<number>", "note": "<string: 10 words max>" },
        { "name": "SG&A",          "key": "sga",            "color": "#f59e0b", "current_pct": "<number>", "prior_pct": "<number>", "change_bps": "<number>", "note": "<string: 10 words max>" },
        { "name": "D&A",           "key": "da",             "color": "#6366f1", "current_pct": "<number>", "prior_pct": "<number>", "change_bps": "<number>", "note": "<string: 10 words max>" }
      ],
      "total_fixed_costs": { "current_pct": "<number>", "prior_pct": "<number>", "change_bps": "<number>", "note": "<string: 10 words max>" },
      "metrics": {
        "revenue_growth_yoy": { "value": "<string>", "label": "Revenue Growth YoY" },
        "ebit_growth_yoy":    { "value": "<string>", "label": "EBIT Growth YoY" },
        "leverage_spread":    { "value": "<string>", "label": "Leverage Spread" }
      },
      "verdict": {
        "status": "<negative|neutral|positive>",
        "label": "<string>",
        "tag": "<string>",
        "description": "<string: 20 words max>"
      },
      "all_verdicts": [
        { "status": "negative", "label": "Negative Operating Leverage" },
        { "status": "neutral",  "label": "Neutral" },
        { "status": "positive", "label": "Positive Operating Leverage" }
      ]
    },
    "free_cash_flow": {
      "meta": { "section_id": "4.3.2", "title": "Free Cash Flow Analysis" },
      "conversion_consistency": {
        "status": "<Stable|Volatile|Declining>",
        "status_color": "<green|yellow|red>",
        "healthy_threshold_pct": 80,
        "quarterly_data": [{ "quarter": "<string>", "pct": "<number>", "is_floor": "<boolean — only true for the lowest quarter, omit on others>" }],
        "range_low": "<number>",
        "range_high": "<number>",
        "floor_pct": "<number>",
        "floor_quarter": "<string>",
        "all_above_threshold": "<boolean>"
      },
      "growth_trajectory": {
        "status": "<FCF Compounder|FCF Outpacing|FCF Lagging|FCF Declining>",
        "status_color": "<green|yellow|red>",
        "fcf_cagr_pct": "<number>",
        "fcf_start": "<string>",
        "fcf_end": "<string>",
        "pat_cagr_pct": "<number>",
        "pat_start": "<string>",
        "pat_end": "<string>",
        "periods": "<string e.g. 8Q>",
        "insight_headline": "<string: 15 words max>",
        "insight_body": "<string: supports **bold** markdown, 30 words max>"
      },
      "ocf_to_fcf": {
        "status": "<Minimal Drag|Moderate Drag|Heavy Drag>",
        "status_color": "<green|yellow|red>",
        "ocf_ttm": "<string>",
        "capex": "<string — negative formatted e.g. '-₹3,100 Cr'>",
        "fcf_ttm": "<string>",
        "ocf_bar_pct": 100,
        "capex_bar_pct": "<number — capex as % of OCF>",
        "fcf_bar_pct": "<number — FCF as % of OCF>",
        "capex_revenue_pct": "<number>",
        "capex_ocf_pct": "<number>",
        "drag_description": "<Very limited|Limited|Moderate|Heavy>"
      },
      "fcf_yield": {
        "status": "<Attractive|Fair|Watch|Expensive|Negative — Not Applicable>",
        "status_color": "<green|yellow|red>",
        "yield_history": [{ "label": "<string e.g. FY22 Yield>", "yield_pct": "<number>", "zone": "<string>", "is_current": "<boolean — only on the latest entry>" }],
        "compression_explanation": "<string: 30 words max>"
      }
    },
    "working_capital": {
      "meta": { "section_id": "4.3.3", "title": "Working Capital" },
      "quarters": ["<string — list of quarter labels matching row value arrays>"],
      "rows": [
        { "label": "DSO (days)", "key": "dso", "values": ["<number — one per quarter in quarters array>"] },
        { "label": "DIO (days)", "key": "dio", "values": ["<number — one per quarter in quarters array>"] },
        { "label": "DPO (days)", "key": "dpo", "values": ["<number — one per quarter in quarters array>"] },
        { "label": "CCC (days)", "key": "ccc", "values": ["<number — one per quarter in quarters array>"] }
      ],
      "trend_chart": {
        "title": "WC as % of Revenue",
        "data": [{ "quarter": "<string>", "wc_pct": "<number>" }],
        "verdict_badge": "<string>",
        "verdict_color": "<green|yellow|red>"
      },
      "signals": [{ "label": "<string>", "color": "<green|yellow|red>" }],
      "insight": "<string: 25 words max>"
    },
    "capital_structure": {
      "meta": { "section_id": "4.3.4", "title": "Capital Structure & Capex" },
      "balance_sheet": {
        "status": "<Net Cash Company|Net Debt Company|Leveraged>",
        "status_color": "<green|yellow|red>",
        "cash_investments": "<string>",
        "cash_bar_pct": "<number — cash as % of (cash+debt)>",
        "gross_debt": "<string>",
        "debt_bar_pct": "<number — debt as % of (cash+debt)>",
        "net_cash": "<string — positive means net cash, negative means net debt>",
        "timeline": [{ "label": "<string e.g. FY20>", "value": "<string e.g. 33.8K>", "is_current": "<boolean — only on latest>" }],
        "insight": "<string: supports **bold** markdown, 30 words max>"
      },
      "debt_trajectory": {
        "status": "<Deleveraging|Stable|Increasing>",
        "status_color": "<green|yellow|red>",
        "bars": [{ "label": "<string e.g. FY20>", "value": "<number — absolute debt value>", "color": "<red|amber|green>", "is_current": "<boolean — only on latest>" }],
        "peak_debt": "<string>",
        "peak_label": "<string>",
        "current_debt": "<string>",
        "current_label": "<string>",
        "reduction_pct": "<string e.g. –57%>",
        "reduction_label": "<string e.g. over 4 years>",
        "insight": "<string: supports **bold** markdown, 25 words max>"
      },
      "equity_allocation": {
        "status": "<Compounding|Stable|Diluting>",
        "status_color": "<green|yellow|red>",
        "rows": [{ "label": "<string e.g. FY20>", "kept_pct": "<number>", "paid_pct": "<number>", "is_current": "<boolean — only on latest>" }],
        "total_equity": "<string>",
        "total_equity_sublabel": "<string>",
        "roe": "<string>",
        "roe_sublabel": "<string: 10 words max>",
        "payout_trend": "<Rising|Stable|Falling>",
        "payout_trend_direction": "<up|down|flat>",
        "payout_sublabel": "<string e.g. 62% → 72% over 5Y>",
        "insight": "<string: 20 words max>"
      },
      "capex_intensity": {
        "status": "<Asset Light|Moderate Capex|Capex Heavy>",
        "status_color": "<green|yellow|red>",
        "metrics": [
          { "label": "Capex as % of Revenue", "value": "<string>", "bar_pct": "<number 0-100>", "max_label": "<string|omitted>", "note": "<string: 10 words max>", "status": "<green|yellow|red>" },
          { "label": "Capex as % of OCF",     "value": "<string>", "bar_pct": "<number 0-100>", "note": "<string: 10 words max>", "status": "<green|yellow|red>" },
          { "label": "Capex / Depreciation",  "value": "<string>", "bar_pct": "<number 0-100>", "max_label": "<string|omitted>", "note": "<string: 10 words max>", "status": "<green|yellow|red>" }
        ],
        "note": "<string: 20 words max>"
      }
    },
    "final_scoring": {
      "meta": { "section_id": "4.3.5", "title": "Financial Quality Scorecard" },
      "score": "<number 0–8>",
      "max_score": 8,
      "status": "<HIGH QUALITY|MODERATE QUALITY|LOW QUALITY>",
      "status_color": "<green|yellow|red>",
      "title": "<string: 5 words max>",
      "body": "<string: 3–4 sentence scorecard summary citing specific metrics>"
    }
  }
}



 DealResponseSchema =
     {
     "scenario_framework": {
       "meta": {
         "section_id": "scenario_framework",
         "title": "Scenario Framework"
       },
       "bear": {
         "points": [
           "Macro headwinds delay projects",
           "Competition intensifies, margin pressure",
           "Revenue growth slows to 8-10%",
           "Multiple compresses to peer avg"
         ]
       },
       "base": {
         "points": [
           "Steady execution on current pipeline",
           "Revenue growth sustains at 14-16%",
           "Margins stable to slightly improving",
           "Multiple sustains at current levels"
         ]
       },
       "bull": {
         "points": [
           "Infrastructure supercycle accelerates",
           "Market share gains continue (15%+)",
           "Revenue growth 20%+, margin expansion",
           "Multiple rerates on quality recognition"
         ]
       }
     },
     "target_price_matrix": {
       "meta": {
         "section_id": "target_price_matrix",
         "title": "Target Price Matrix (FY26 Exit)"
       },
       "holding_period": "3-year holding period",
       "current_price": "₹168",
       "bear": {
         "eps_cagr": "8.2%",
         "fy_eps": "₹6.3",
         "exit_pe": "22-25x",
         "pe_rationale": "Multiple compression to peer avg",
         "target_range": "₹140-160",
         "from_cmp": "-17%",
         "cagr": "CAGR: -6.0% p.a.",
         "probability": 20
       },
       "base": {
         "eps_cagr": "16.8%",
         "fy_eps": "₹8.8",
         "exit_pe": "30-35x",
         "pe_rationale": "Maintain premium on execution",
         "target_range": "₹265-310",
         "from_cmp": "+68%",
         "cagr": "CAGR: +17.2% p.a.",
         "probability": 55
       },
       "bull": {
         "eps_cagr": "24.6%",
         "fy_eps": "₹12.0",
         "exit_pe": "35-40x",
         "pe_rationale": "Quality premium expansion",
         "target_range": "₹420-480",
         "from_cmp": "+150%",
         "cagr": "CAGR: +35.4% p.a.",
         "probability": 25
       }
     },
     "risk_reward_summary": {
       "meta": {
         "section_id": "risk_reward_summary"
       },
       "probability_weighted_return": {
         "label": "Probability-Weighted Return",
         "value": "+58%",
         "description": "Expected value: ₹265",
         "subtitle": "16.6% CAGR over 3 years"
       },
       "risk_reward_ratio": {
         "label": "Risk-Reward Ratio",
         "value": "3.8x",
         "description": "Upside potential (₹450) vs downside risk (₹150)",
         "subtitle": "From current price of ₹168"
       },
       "downside_protection": {
         "label": "Downside Protection",
         "value": "-17%",
         "description": "Limited downside even in bear case given quality metrics",
         "subtitle": "Strong execution track record"
       }
     }
   }


module.exports = { FINCRUX_METRICS,OFactorResponseSchema,DealResponseSchema };
