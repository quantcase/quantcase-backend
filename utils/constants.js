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



const OFactorResponseSchema = {
  "competition": {
    "meta": { "title": "Competition", "subtitle": "Competitive dynamics & positioning analysis", "section_id": "4.2" },
    "text": {
      "takeaway": "<string>",
      "pricing_power_dynamics": {
        "current_state":     "<string>",
        "watch_outs":        "<string>",
        "future_trajectory": "<string>",
        "shifting_dynamics": "<string>"
      },
      "competitive_positioning": {
        "strengths":        ["<string>"],
        "opportunities":    ["<string>"],
        "areas_to_monitor": ["<string>"]
      }
    },
    "metrics": {
      "porters_score":         { "label": "Porter's Score",        "value": "<X/10>",               "sublabel": "<string>" },
      "pricing_power":         { "label": "Pricing Power",         "value": "<Low|Moderate|High>",  "sublabel": "<string>" },
      "entry_barriers":        { "label": "Entry Barriers",        "value": "<Low|Moderate|High>",  "sublabel": "<string>" },
      "market_position":       { "label": "Market Position",       "value": "<string>",             "sublabel": "<string>" },
      "competitive_intensity": { "label": "Competitive Intensity", "value": "<Low|Moderate|High>",  "sublabel": "<string>" }
    },
    "final_scoring": {
      "meta": { "section_id": "4.2.5", "title": "Competitive Position Scorecard" },
      "score": "<number 0–10>",
      "max_score": 10,
      "status": "<STRONG POSITION|MODERATE POSITION|WEAK POSITION>",
      "status_color": "<green|yellow|red>",
      "title": "<string>",
      "body": "<string>"
    }
  },
  "customer_traction": {
    "meta": { "title": "Client/Customer Traction", "subtitle": "Customer growth, retention & revenue trajectory with signals from management commentary", "section_id": "4.4" },
    "text": {
      "takeaway": "<string>",
      "retention": {
        "metrics": {
          "net_revenue_retention":   { "label": "Net Revenue Retention",   "value": "<string|null>", "sublabel": "<string>" },
          "gross_revenue_retention": { "label": "Gross Revenue Retention", "value": "<string|null>", "sublabel": "<string>" },
          "expansion_revenue":       { "label": "Expansion Revenue",       "value": "<string|null>", "sublabel": "<string>" },
          "annual_churn":            { "label": "Annual Churn",            "value": "<string|null>", "sublabel": "<string>" }
        },
        "expansion_drivers":  ["<string>"],
        "product_stickiness": ["<string>"]
      },
      "key_takeaway": "<string>",
      "segmentation": {
        "tiers": [{
          "tier": "<string>", "customer_count": "<string>", "avg_acv": "<string>",
          "nrr": "<string>", "nrr_label": "<string>",
          "churn": "<string>", "churn_label": "<string>",
          "revenue_share": "<string>", "contract_terms": "<string>"
        }],
        "growth_strategy": ["<string>"],
        "revenue_quality":  ["<string>"]
      },
      "customer_growth": {
        "metrics": {
          "current_base":    { "label": "Current Customer Base", "value": "<string|null>", "sublabel": "<string>" },
          "five_year_growth":{ "label": "5Y Customer Growth",   "value": "<string|null>", "sublabel": "<string>" },
          "new_adds":        { "label": "New Adds",             "value": "<string|null>", "sublabel": "<string>" },
          "churned":         { "label": "Churned",              "value": "<string|null>", "sublabel": "<string>" }
        },
        "acquisition_dynamics": ["<string>"]
      },
      "alt_data_signals": [{ "source": "<string>", "insight": "<string>" }]
    },
    "metrics": {
      "churn_rate":           { "label": "Churn Rate / AUM Attrition",            "value": "<string|null>", "sublabel": "<string>" },
      "net_retention":        { "label": "Net Revenue Retention / ARR Retention", "value": "<string|null>", "sublabel": "<string>" },
      "active_customers":     { "label": "Active Customers",                      "value": "<string|null>", "sublabel": "<string>" },
      "avg_contract_value":   { "label": "Avg Contract / AUM Value",              "value": "<string|null>", "sublabel": "<string>" },
      "top_10_concentration": { "label": "Top-10 Concentration",                  "value": "<string|null>", "sublabel": "<string>" }
    },
    "final_scoring": {
      "meta": { "section_id": "4.4.5", "title": "Customer Traction Scorecard" },
      "score": "<number 0–10>",
      "max_score": 10,
      "status": "<HIGH TRACTION|MODERATE TRACTION|LOW TRACTION>",
      "status_color": "<green|yellow|red>",
      "title": "<string>",
      "body": "<string>"
    }
  },
  "industry_overview": {
    "meta": { "title": "Industry Overview & Market", "subtitle": "Synthesized from public company transcripts & filings", "section_id": "4.1" },
    "text": {
      "takeaway": "<string>",
      "opm_trend": {
        "metrics": {
          "current_opm":     { "label": "Current OPM",        "value": "<string|null>", "sublabel": "<string>" },
          "five_year_change": { "label": "5Y OPM Change",     "value": "<string|null>", "sublabel": "<string>" },
          "ten_year_change":  { "label": "10Y OPM Change",    "value": "<string|null>", "sublabel": "<string>" },
          "trend_direction":  { "label": "Trend Direction",   "value": "<Improving|Stable|Declining>", "sublabel": "<string>" }
        },
        "margin_drivers":   ["<string>"],
        "forward_outlook":  "<string>",
        "key_observations": ["<string>"]
      },
      "industry_transcripts": [{
        "company": "<string>", "sector": "<string>",
        "context": "<string>", "quote": "<verbatim quote from transcript>"
      }],
      "demand_supply_dynamics": {
        "demand":     ["<string>"],
        "supply":     ["<string>"],
        "net_impact": "<string>"
      }
    },
    "metrics": {
      "industry_revenue_ttm": { "label": "Total Industry Revenue (TTM)", "value": "<string|null>", "change": "<string|null>", "sublabel": "<string>" },
      "industry_cagr":        { "label": "Industry CAGR",                "qoq": "<string|null>", "one_year": "<string|null>", "three_year": "<string|null>", "sublabel": "<string>" },
      "industry_aum":         { "label": "Industry AUM",                 "value": "<string|null>", "change": "<string|null>", "sublabel": "<string>" },
      "current_opm":          { "label": "Industry Operating Margin",    "value": "<string|null>", "change": "<string|null>", "sublabel": "<string>" },
      "industry_roce":        { "label": "Industry ROCE",                "value": "<string|null>", "change": "<string|null>", "sublabel": "<string>" },
      "demand_signal":        { "label": "Demand Signal",                "value": "<Weak|Moderate|Strong>", "sublabel": "<string>" },
      "supply_constraint":    { "label": "Supply Constraint",            "value": "<Low|Moderate|High>",    "sublabel": "<string>" }
    },
    "final_scoring": {
      "meta": { "section_id": "4.1.5", "title": "Industry Attractiveness Scorecard" },
      "score": "<number 0–10>",
      "max_score": 10,
      "status": "<FAVORABLE|NEUTRAL|UNFAVORABLE>",
      "status_color": "<green|yellow|red>",
      "title": "<string>",
      "body": "<string>"
    }
  },
  "financial_strength": {
    "meta": { "title": "Financial Strength", "subtitle": "Snapshot from financial statements, investor decks & management commentary", "section_id": "4.3" },
    "text": {
      "takeaway": "<string>",
      "cash_flow": {
        "metrics": {
          "fcf":            { "label": "Free Cash Flow",       "value": "<string|null>", "sublabel": "<string>" },
          "fcf_conversion": { "label": "FCF Conversion",       "value": "<string|null>", "sublabel": "<string>" },
          "ocf_ebitda":     { "label": "OCF / EBITDA",         "value": "<string|null>", "sublabel": "<string>" },
          "working_capital":{ "label": "Working Capital Days", "value": "<string|null>", "sublabel": "<string>" }
        },
        "quality_analysis": ["<string>"]
      },
      "key_takeaway": "<string>",
      "balance_sheet": {
        "metrics": {
          "net_debt_ebitda":  { "label": "Net Debt / EBITDA",   "value": "<string|null>", "sublabel": "<string>" },
          "debt_equity":      { "label": "Debt / Equity",       "value": "<string|null>", "sublabel": "<string>" },
          "interest_coverage":{ "label": "Interest Coverage",   "value": "<string|null>", "sublabel": "<string>" },
          "current_ratio":    { "label": "Current Ratio",       "value": "<string|null>", "sublabel": "<string>" },
          "credit_rating":    { "label": "Credit Rating",       "value": "<string|null>", "sublabel": "<string>" }
        },
        "strengths":      ["<string>"],
        "considerations": ["<string>"]
      },
      "profitability": {
        "metrics": {
          "ebitda_margin":      { "label": "EBITDA / OPM Margin",    "value": "<string|null>", "sublabel": "<string>" },
          "pat_margin":         { "label": "PAT Margin",              "value": "<string|null>", "sublabel": "<string>" },
          "five_year_improvement": { "label": "5Y Margin Improvement","value": "<string|null>", "sublabel": "<string>" }
        },
        "operating_leverage_drivers":   ["<string>"],
        "strategic_initiative_drivers": ["<string>"]
      },
      "revenue_growth": {
        "drivers": ["<string>"],
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
        { "name": "Employee Costs", "key": "employee_costs", "color": "#3b82f6", "current_pct": "<number>", "prior_pct": "<number>", "change_bps": "<number>", "note": "<string>" },
        { "name": "SG&A",          "key": "sga",            "color": "#f59e0b", "current_pct": "<number>", "prior_pct": "<number>", "change_bps": "<number>", "note": "<string>" },
        { "name": "D&A",           "key": "da",             "color": "#6366f1", "current_pct": "<number>", "prior_pct": "<number>", "change_bps": "<number>", "note": "<string>" }
      ],
      "total_fixed_costs": { "current_pct": "<number>", "prior_pct": "<number>", "change_bps": "<number>", "note": "<string>" },
      "metrics": {
        "revenue_growth_yoy": { "value": "<string>", "label": "Revenue Growth YoY" },
        "ebit_growth_yoy":    { "value": "<string>", "label": "EBIT Growth YoY" },
        "leverage_spread":    { "value": "<string>", "label": "Leverage Spread" }
      },
      "verdict": {
        "status": "<negative|neutral|positive>",
        "label": "<string>",
        "tag": "<string>",
        "description": "<string>"
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
        "insight_headline": "<string>",
        "insight_body": "<string — supports **bold** markdown>"
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
        "compression_explanation": "<string>"
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
      "insight": "<string>"
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
        "insight": "<string — supports **bold** markdown>"
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
        "insight": "<string — supports **bold** markdown>"
      },
      "equity_allocation": {
        "status": "<Compounding|Stable|Diluting>",
        "status_color": "<green|yellow|red>",
        "rows": [{ "label": "<string e.g. FY20>", "kept_pct": "<number>", "paid_pct": "<number>", "is_current": "<boolean — only on latest>" }],
        "total_equity": "<string>",
        "total_equity_sublabel": "<string>",
        "roe": "<string>",
        "roe_sublabel": "<string>",
        "payout_trend": "<Rising|Stable|Falling>",
        "payout_trend_direction": "<up|down|flat>",
        "payout_sublabel": "<string e.g. 62% → 72% over 5Y>",
        "insight": "<string>"
      },
      "capex_intensity": {
        "status": "<Asset Light|Moderate Capex|Capex Heavy>",
        "status_color": "<green|yellow|red>",
        "metrics": [
          { "label": "Capex as % of Revenue", "value": "<string>", "bar_pct": "<number 0-100>", "max_label": "<string|omitted>", "note": "<string>", "status": "<green|yellow|red>" },
          { "label": "Capex as % of OCF",     "value": "<string>", "bar_pct": "<number 0-100>", "note": "<string>", "status": "<green|yellow|red>" },
          { "label": "Capex / Depreciation",  "value": "<string>", "bar_pct": "<number 0-100>", "max_label": "<string|omitted>", "note": "<string>", "status": "<green|yellow|red>" }
        ],
        "note": "<string>"
      }
    },
    "final_scoring": {
      "meta": { "section_id": "4.3.5", "title": "Financial Quality Scorecard" },
      "score": "<number 0–10>",
      "max_score": 10,
      "status": "<HIGH QUALITY|MODERATE QUALITY|LOW QUALITY>",
      "status_color": "<green|yellow|red>",
      "title": "<string>",
      "body": "<string>"
    }
  },
  "final_takeaways": {
    "overall_score": "<number 0–40>",
    "max_score": 40,
    "overall_status": "<STRONG|MODERATE|WEAK>",
    "status_color": "<green|yellow|red>",
    "investment_thesis": "<string — 1–2 sentence overall investment thesis>",
    "key_highlights": ["<string>"],
    "key_risks": ["<string>"],
    "section_scores": {
      "industry":           { "score": "<number 0–10>", "status": "<string>", "takeaway": "<string>" },
      "competition":        { "score": "<number 0–10>", "status": "<string>", "takeaway": "<string>" },
      "financial_strength": { "score": "<number 0–10>", "status": "<string>", "takeaway": "<string>" },
      "customer_traction":  { "score": "<number 0–10>", "status": "<string>", "takeaway": "<string>" }
    }
  }
}



const DealResponseSchema = {
  "scenario_framework": {
    "meta": { "section_id": "scenario_framework", "title": "Scenario Framework" },
    "bear": { "points": ["<string>", "<string>", "<string>"] },
    "base": { "points": ["<string>", "<string>", "<string>"] },
    "bull": { "points": ["<string>", "<string>", "<string>"] }
  },
  "target_price_matrix": {
    "meta": { "section_id": "target_price_matrix", "title": "Target Price Matrix" },
    "holding_period": "<string>",
    "current_price": "<string>",
    "bear": {
      "eps_cagr": "<string>", "fy_eps": "<string>", "exit_pe": "<string>",
      "pe_rationale": "<string>", "target_range": "<string>",
      "from_cmp": "<string>", "cagr": "<string>", "probability": "<number>"
    },
    "base": {
      "eps_cagr": "<string>", "fy_eps": "<string>", "exit_pe": "<string>",
      "pe_rationale": "<string>", "target_range": "<string>",
      "from_cmp": "<string>", "cagr": "<string>", "probability": "<number>"
    },
    "bull": {
      "eps_cagr": "<string>", "fy_eps": "<string>", "exit_pe": "<string>",
      "pe_rationale": "<string>", "target_range": "<string>",
      "from_cmp": "<string>", "cagr": "<string>", "probability": "<number>"
    }
  },
  "risk_reward_summary": {
    "meta": { "section_id": "risk_reward_summary", "title": "Risk-Reward Summary" },
    "probability_weighted_return": { "label": "<string>", "value": "<string>", "subtitle": "<string>" },
    "risk_reward_ratio":           { "label": "<string>", "value": "<string>", "subtitle": "<string>" },
    "downside_protection":         { "label": "<string>", "value": "<string>", "subtitle": "<string>" }
  },
  "detailed_analysis": {
    "eps_engine": {
      "meta": { "section_id": "eps_engine", "title": "Earnings Trajectory & Quality", "subtitle": "<string>" },
      "sub_section_title": "<string>",
      "sub_section_subtitle": "<string>",
      "scenarios": {
        "bear": {
          "industry_cagr":     { "value": "<string>", "note": "<string>" },
          "revenue_growth":    { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "margin_trajectory": { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "execution_alpha":   { "rating": "<string>", "value": "0.5x", "note": "Underperform" },
          "expected_eps_cagr": { "value": "<string>", "subtitle": "<string>" }
        },
        "base": {
          "industry_cagr":     { "value": "<string>", "note": "<string>" },
          "revenue_growth":    { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "margin_trajectory": { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "execution_alpha":   { "rating": "<string>", "value": "1.0x", "note": "Meet guidance" },
          "expected_eps_cagr": { "value": "<string>", "subtitle": "<string>" }
        },
        "bull": {
          "industry_cagr":     { "value": "<string>", "note": "<string>" },
          "revenue_growth":    { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "margin_trajectory": { "value": "<string>", "note": "<string>", "mgmt_guidance": "<string>", "mgmt_result": "<string>" },
          "execution_alpha":   { "rating": "<string>", "value": "1.3x", "note": "Exceed guidance" },
          "expected_eps_cagr": { "value": "<string>", "subtitle": "<string>" }
        }
      },
      "insight": "<string>"
    },
    "historical_performance": {
      "meta": { "section_id": "historical_performance", "title": "Historical Performance", "subtitle": "<string>" },
      "company_growth":  { "value": "<string>", "label": "5 yr CAGR" },
      "industry_growth": { "value": "<string>", "label": "5 yr CAGR" },
      "company_name":  "<string>",
      "industry_name": "<string>",
      "chart_data": [
        { "year": "FY20",  "company": "<number>", "industry": "<number>" },
        { "year": "FY25E", "company": "<number>", "industry": "<number>" }
      ],
      "stats": [
        { "value": "<string>", "label": "Avg outperformance vs industry", "color": "emerald" },
        { "value": "<string>", "label": "Beat industry X/6 years",        "color": "blue" },
        { "value": "<string>", "label": "Latest year growth",             "color": "purple" }
      ]
    },
    "quality_of_earnings": {
      "meta": { "section_id": "quality_of_earnings", "title": "Quality of Earnings: Atomic Metrics", "subtitle": "<string>" },
      "metrics": [
        { "label": "EBITDA MARGIN",    "value": "<string>", "change": "<string>", "change_color": "emerald" },
        { "label": "RETURN ON EQUITY", "value": "<string>", "change": "<string>", "change_color": "blue" },
        { "label": "MARKET SHARE",     "value": "<string>", "change": "<string>", "change_color": "purple" },
        { "label": "CASH CONVERSION",  "value": "<string>", "change": "<string>", "change_color": "amber" }
      ],
      "chart_data": [
        { "year": "FY20",  "roe": "<number>", "roic": "<number>", "market_share": "<number>" },
        { "year": "FY25E", "roe": "<number>", "roic": "<number>", "market_share": "<number>" }
      ],
      "bottom_line": "<string>"
    },
    "valuation_vs_peers": {
      "meta": { "section_id": "valuation_vs_peers", "title": "Valuation vs Peers", "subtitle": "<string>" },
      "current_position": [
        { "label": "P/E MULTIPLE", "value": "<string>", "detail": "<string>", "color": "amber" },
        { "label": "EV/EBITDA",    "value": "<string>", "detail": "<string>", "color": "amber" },
        { "label": "ROE QUALITY",  "value": "<string>", "detail": "<string>", "color": "emerald" },
        { "label": "GROWTH RATE",  "value": "<string>", "detail": "<string>", "color": "emerald" }
      ],
      "re_rating_view": {
        "badge": "<EXPAND|SUSTAIN|CONTRACT>",
        "title": "<string>",
        "description": [{ "text": "<string>", "bold": "<boolean?>", "color": "<string?>" }]
      },
      "expansion_drivers":  [{ "text": "<string>", "detail": "<string>" }],
      "contraction_risks":  [{ "text": "<string>", "detail": "<string>" }],
      "scenario_multiples": [
        { "label": "Bull Case Exit P/E", "value": "<string>", "change": "<string>", "color": "emerald" },
        { "label": "Base Case Exit P/E", "value": "<string>", "change": "<string>", "color": "blue" },
        { "label": "Bear Case Exit P/E", "value": "<string>", "change": "<string>", "color": "red" }
      ]
    }
  }
}


module.exports = { FINCRUX_METRICS,OFactorResponseSchema,DealResponseSchema };
