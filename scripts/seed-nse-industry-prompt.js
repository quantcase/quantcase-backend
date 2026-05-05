'use strict';

require('dotenv').config();
const prisma = require('../config/prisma');

const PROMPT_TEMPLATE = `---
name: nse-industry-analysis
description: Analyze any NSE-listed industry by evaluating supply-demand dynamics, growth trajectory, and profitability trends using management transcripts, investor presentations, and financial statements from all public companies in that sector.
---

# NSE Industry Analysis Framework

A systematic approach to analyze and score NSE-listed industries across five dimensions: Growth, Demand, Supply, Profit Pool, and Global Competition.

## Core Methodology

Analyze industries by aggregating data from ALL listed companies in the sector and producing a 0-10 score based on five dimensions (0-2 points each).

### Workflow Overview

1. **Identify Industry Scope**: Define which NSE-listed companies belong to the industry
2. **Data Collection**: Gather transcripts, presentations, and financials for all companies
3. **Extract Metrics**: Calculate financial and operational metrics for each company
4. **Analyze Sentiment**: Extract management commentary on demand, supply, competition
5. **Score Dimensions**: Apply scoring rubric across 5 dimensions
6. **Generate Output**: Produce structured report with company tables, sentiment summaries, and final score

---

## Dimension 1: Growth (0-2 points)

**Objective**: Measure revenue growth magnitude, momentum, and distribution across industry players.

### Calculations

**1. Growth Rates** — For each company:
- QoQ growth, YoY growth, 1Y trailing CAGR, 3Y CAGR, 5Y CAGR

**2. Industry Aggregates** — Weighted averages (by revenue or market cap):
- Weighted avg QoQ, YoY, 3Y CAGR, 5Y CAGR

**3. Momentum Detection**
- 3-quarter moving average to smooth noise
- Acceleration = Current QoQ growth - Previous QoQ growth (positive = accelerating, negative = decelerating)
- Second derivative: track if acceleration itself is changing
- Flag inflection points (e.g., "growth was 10-12% for 6 quarters, jumped to 18% in Q2 and 22% in Q3")

**4. Dispersion Analysis**
- Standard deviation of growth rates across companies
- Leaders (top quartile), Followers (mid 50%), Laggards (bottom quartile) — % of market share each
- High dispersion = structural shift (consolidation or disruption)
- Low dispersion = industry moving together (mature/stable)

### Scoring Rubric
- **+2**: Weighted avg growth >15% YoY AND accelerating AND low dispersion or consolidating toward leaders
- **+1**: Growth 8-15% YoY OR growing but stable OR high dispersion without clear consolidation
- **0**: Growth <8% YoY OR decelerating

---

## Dimension 2: Demand (0-2 points)

**Objective**: Assess demand strength through management sentiment AND hard data validation.

### Layer 1: Sentiment from Transcripts (latest 2 quarters)
1. Volume Growth Commentary — count bullish vs cautious management teams
2. Order Book/Pipeline Expansion — count companies reporting growth
3. Guidance Tone — count bullish vs cautious capex/volume guidance

**Management Credibility Weighting**
- High credibility (>85% guidance accuracy): Weight = 1.2x
- Medium credibility (60-85%): Weight = 1.0x
- Low credibility (<60%): Weight = 0.6x

Adjusted confidence = Sum(company_bullish x credibility_weight) / Total companies

### Layer 2: Hard Data
1. **Capex Trend**: Count companies with rising capex QoQ for 2+ consecutive quarters
2. **Price x Volume Decomposition**: Revenue Growth = Volume Growth + Price/Mix Effect
   - Concerning: Revenue +15% but Volume +2%, Price +13% = inflation-driven, not real demand
3. **Receivable Days**: (Avg Trade Receivables / Net Credit Sales) x 365 — falling = strong demand
4. **Working Capital Cycle**: CCC = Receivable Days + Inventory Days - Payable Days
   - All three tightening together = genuine demand strength
   - Receivables falling + Inventory rising + Payables rising faster = WC optimization only

### Scoring Rubric
- **+2**: Majority (>60%) bullish (credibility-weighted) + majority rising capex + majority falling receivables + real demand (volume-driven)
- **+1**: Mixed signals
- **0**: Majority cautious + flat/falling capex + rising receivables

---

## Dimension 3: Supply (0-2 points)

**Objective**: Assess supply tightness vs oversupply risk.

### Layer 1: Sentiment from Transcripts
1. Competition Mentions — count companies citing increased competition or pricing pressure
2. Capacity Mentions — count tight vs idle capacity mentions

**Capacity Utilization Tracking** (extract from transcripts and presentations)
- >85% utilization for majority = Supply tight
- 70-85% = Balanced
- <70% for majority = Excess capacity

### Layer 2: Hard Data
1. **Inventory Days**: (Avg Inventory / COGS) x 365 — rising = oversupply risk
2. **Capex/Sales Ratio**: Rising ratio + rising inventory = oversupply risk in 12-18 months
3. **Inflection Point Detection**: Sudden capex surge after flat period = major supply expansion underway

### Scoring Rubric
- **+2**: Minimal competition + majority >85% utilization + stable/falling inventory + justified capex
- **+1**: Mixed signals
- **0**: Heavy competition + rising inventory + low utilization (<70%) + heavy capex expansion

---

## Dimension 4: Profit Pool (0-2 points)

**Objective**: Assess industry profitability and value creation.

### Metrics
1. **ROCE**: EBIT / (Total Assets - Current Liabilities) x 100 — current + 2Y trend
2. **Operating Margin**: EBIT / Revenue x 100 — current + 4Q trend
3. **ROCE Spread vs WACC** (use 12% baseline):
   - ROCE > WACC+5% = Strong value creation
   - ROCE > WACC = Moderate value creation
   - ROCE < WACC = Value destruction
4. **Margin Decomposition**: Operating leverage vs pricing power vs cost efficiency
5. **Coherence Check**: Demand strong + Supply tight + Margins expanding = coherent industry story

### Scoring Rubric
- **+2**: ROCE improving AND >WACC+5% AND margins expanding across majority
- **+1**: ROCE stable and >WACC OR margins stable/slightly improving OR mixed
- **0**: ROCE deteriorating OR <WACC OR margins contracting across majority

---

## Dimension 5: Global Competition (0-2 points)

### V1 Default Scoring
- **+2**: Natural import barriers (services, infrastructure, regulated sectors like banking)
- **+1**: Moderate import competition (consumer goods, light manufacturing)
- **0**: Heavy import competition (electronics, commodities)

---

## Output Structure (follow this exact sequence)

### 1. Score Card
Total score (X/10) + status of each dimension.

### 2. Industry Metrics Cards
All weighted averages displayed as separate cards:
- Growth: Revenue Growth YoY, 3Y CAGR, QoQ Acceleration
- Demand: Bullish Sentiment count, Rising Capex count, Falling Receivables count
- Supply: Avg Capacity Utilization, companies above 85%, Inventory Trend
- Profitability: Industry ROCE, ROCE vs WACC Spread, Operating Margin, Margin Trend

### 3. Key Takeaway
One powerful sentence with specific evidence and a number in parentheses. Max 20 words.

### 4. Key Findings (6-8 findings)
Cover ALL of these themes — each a distinct angle with no duplicate data points:
- Profitability (green) — Record profits, earnings quality, ROCE/ROE levels
- Asset quality / balance sheet (green) — NPA trends or WC health
- Growth / demand (green) — Revenue growth, guidance upgrades, segment mix
- Margin / spread pressure (amber) — Input cost pressure, pricing headwinds
- Funding / liability-side (amber) — WC stress or deposit competition (BFSI)
- Market structure / consolidation (blue) — Who is gaining share? Leaders vs laggards
- Valuation (blue) — Industry valued vs peers/history, re-rating case
- Management quality (green/amber) — Capex discipline, guidance accuracy, optimization

Include 3-4 cross-dimension coherence checks:
- Coherent patterns (demand + supply + margins aligned)
- Incoherent/risk patterns (contradictions across dimensions — these matter MORE than alignments)

**DO NOT include a separate Executive Summary** — Key Findings is the single analytical section.

### 5. Demand Drivers from Transcripts
Only drivers mentioned by majority (>50%) of companies. Include counts ("X out of Y companies").
Include 1-2 representative quotes if impactful.

### 6. Supply Drivers from Transcripts
Only drivers mentioned by majority (>50%) of companies. Include counts.
Include 1-2 representative quotes if impactful.

### 7. Company-by-Company Metrics Table
All companies: Mkt Cap, Revenue Growth, QoQ Accel, Capex Trend, Receivable Days, Inventory Days, Capacity Util, ROCE, Op Margin, Sentiment.
Mark estimated metrics with ~ prefix. Industry Weighted Averages row at bottom.

### 8. Investment Implications
- Positive signals with specific evidence
- Risks to monitor with specific evidence
- Recommended strategy: BUY / AVOID / SELECTIVE + segment + rationale + thesis + timing
- Next quarter watch points (3-5 specific, falsifiable items)

---

## Lifecycle-Aware Scoring

Classify before scoring:
- **Nascent** (3Y CAGR >30%, ROCE <10%): Weight Growth 2.5x, floor Profit Pool at 0
- **Growth** (3Y CAGR 15-30%, ROCE improving): Standard equal weights
- **Mature** (3Y CAGR 8-15%, ROCE >15% stable): Weight Profit Pool 1.5x, Growth 0.7x
- **Declining** (CAGR <8% or negative): Weight Supply 1.5x, Profit Pool 1.5x

---

## Key Decision Rules

1. **Majority Rule**: >50% of companies by count
2. **Evidence Counts**: Always provide specific counts — "6 out of 8 companies"
3. **Quote Selectively**: 2-3 representative management quotes per dimension to ground analysis
4. **Partial Points**: Award 0.5-1.5 points when signals are mixed or moderate
5. **Coherence over Isolation**: Contradictions between dimensions matter more than alignments
6. **No Redundancy**: Key Findings is the single analytical section. Do not duplicate insights.

---

## BFSI Sector Adjustments

- Use **ROE** instead of ROCE; **ROA** instead of operating margin; **NIM** as core spread metric
- Replace receivables/inventory with: deposit growth, loan book growth, AUM growth
- Track: GNPA, NNPA, slippage ratio, credit cost, provision coverage ratio
- Track: Credit-Deposit ratio, CASA ratio, cost of deposits
- Earnings quality: Core NII + low credit costs = sustainable. Treasury gains + provision reversals = one-time.
- Credit growth outpacing deposit growth = demand-positive but funding-negative — flag both sides
- Company table uses BFSI columns: Net Profit, Profit Growth, Loan Growth, NIM, GNPA, NNPA, ROE, ROA, CAR, Sentiment

---

## Scoring Cheat Sheet

| Dimension    | +2 Points                                        | +1 Point                          | 0 Points                               |
|--------------|--------------------------------------------------|-----------------------------------|----------------------------------------|
| Growth       | >15% YoY, accelerating, consolidating            | 8-15% YoY OR stable               | <8% YoY OR decelerating                |
| Demand       | >60% bullish (weighted), rising capex, falling recv | Mixed signals                  | <40% bullish, flat capex, rising recv  |
| Supply       | >85% capacity, stable/falling inventory           | 70-85% capacity, mixed inventory  | <70% capacity, rising inventory        |
| Profit Pool  | ROCE >WACC+5%, expanding margins                  | ROCE >WACC, stable margins        | ROCE <WACC OR contracting margins      |
| Global Comp  | Natural barriers                                  | Moderate competition              | Heavy imports                          |
`;

async function main() {
  const result = await prisma.skill.update({
    where: { slug: 'nse-industry' },
    data:  { promptTemplate: PROMPT_TEMPLATE },
  });
  console.log('Updated promptTemplate, length:', result.promptTemplate.length, 'chars');
  await prisma.$disconnect();
}

main().catch(console.error);
