#!/usr/bin/env node
'use strict';

/**
 * Seed baseline LensConfigs for the 3-layer analysis pipeline.
 * Each lens pulls from multiple signal types/families and includes
 * the model + max_tokens for the L2 LLM call.
 *
 * Run: node scripts/seedLensConfigs.js
 */

require('dotenv').config();
const prisma = require('../config/prisma');

const HAIKU = 'anthropic/claude-haiku-4.5';
const MAX_TOKENS = 16000;

const LENS_CONFIGS = [
  // ── Management lenses ────────────────────────────────────────────────────────
  {
    slug:         'guidance-credibility',
    name:         'Guidance Credibility',
    category:     'management',
    description:  'How consistently management delivers on its forward-looking promises',
    force_config: true,
    version:      '2.0.0',
    config: {
      signal_filters: {
        // guidance + guidance_revision: forward commitments and revisions — core credibility signal
        // milestone: past achievements — actuals to compare against guidance targets
        // ongoing: in-flight initiatives with an end-state target
        // kpi: financial actuals for milestone period matching
        // strategic_claim: soft promises that can be tracked over time
        // mgmt_tone: sentiment per quarter — needed for tone_divergence pattern
        // analyst_questions: Q&A clustering — needed for narrative_gap + street_pressure patterns
        signal_types:        ['guidance', 'guidance_revision', 'milestone', 'ongoing', 'kpi', 'strategic_claim', 'mgmt_tone', 'analyst_questions'],
        include_historical:  true,
      },
      show_math_block: false,
      weights: [
        { metric: 'guidance_given',       w: 0.5 },
        { metric: 'guidance_missed',      w: -0.8 },
        { metric: 'proactive_disclosure', w: 0.3 },
      ],
      aggregation:     'weighted_sum',
      balance:         { default: 9999 },
      model:           HAIKU,
      max_tokens:      32000,
      bridge_prompt: true,
      prompt_template: `# Management Credibility Skill (L2) — v5 Refined

**Purpose:** Synthesize L1 signals from earnings transcripts and investor PPTs to surface management credibility patterns, strategic pivots, and guidance execution track record. Extract only what management committed to; discard inference and inference-driven analysis.

**Core Principle:** This skill is about **management execution on stated commitments**, not about predicting or inferring outcomes. Every number, date, and commitment must exist as a verbatim statement in the input. If it doesn't exist, it is [NULL].

---

## ⛔ Provenance Gate (Read First — Non-Negotiable)

**Every single value in output traces to a verbatim statement in the supplied input. Period.**

- **Do not paraphrase.** Extract exact language only.
- **Do not invent.** If a number, date, or commitment is not explicitly stated, it is [NULL].
- **Do not backfill.** Never use actuals to infer missing guidance.
- **Do not assume.** "The company grew 15%" is not the same as "we guide 15% growth."

Two hard failure conditions:
1. **No guidance signals supplied** → Stop. State that earnings call transcripts + PPT actuals are required.
2. **A value cannot be traced to supplied input** → Output [NULL]. Never fill the gap from memory, examples, or logic.

---

## Input Requirements — Strict Schema

### 1. L1 Guidance Signals from Earnings Transcripts ONLY

**Signal Types: "guidance_timebound" + "ongoing:timebound" (timebound category only)** (the ONLY sources for guidance track record)

Structure:
'''json
{
  "signal_type": "guidance_timebound",
  "metric": "string (e.g., 'NIM', 'CAPEX_FY26', 'REVENUE')",
  "guided_value": "number | null",
  "guided_value_unit": "string (e.g., '%', 'Cr', 'bps')",
  "guided_range": {
    "low": "number | null",
    "high": "number | null"
  },
  "target_date": "YYYY-MM-DD | 'FY25_Q3' | null",
  "announcement_date": "YYYY-MM-DD (earnings call date)",
  "source": "EARNINGS_CALL_TRANSCRIPT",
  "verbatim_statement": "exact quote from transcript",
  "quote_page_or_timestamp": "for verification"
}
'''

**Extraction Rule:**
- Extract ONLY sentences containing:
  - Explicit future-tense guidance ("we guide", "we expect", "we target", "targeting", "guidance", "outlook")
  - AND a specific numeric value or range
  - AND (optionally) a target date
- If a statement is past tense ("we delivered", "we achieved"), it is an actual, not guidance → mark as [NULL] in guidance_timebound, extract to actuals instead.

**Examples (✓ Extract as guidance_timebound):**
'''
"We target NIM of 3.65% for FY25."
  → guided_value: 3.65, guided_value_unit: "%", target_date: "FY25", metric: "NIM"

"We expect revenue growth of 18–22% in FY26."
  → guided_value: null, guided_range: {low: 18, high: 22}, target_date: "FY26", metric: "REVENUE_GROWTH"

"Capex is expected to be ₹10,000–12,000 crore by end FY26."
  → guided_value: null, guided_range: {low: 10000, high: 12000}, target_date: "FY26_END", metric: "CAPEX"
'''

**Examples (✗ DO NOT extract as guidance_timebound):**
'''
"We delivered ₹67,347 crore net profit in FY25."
  → Past tense. This is an ACTUAL. Mark guidance_timebound as [NULL] for this metric in this quarter.

"Net profit grew 10.7% YoY."
  → Backward-looking. Not guidance. [NULL].

"The guidance we gave last quarter was 3.65% NIM."
  → This refers to PAST guidance. If current guidance differs, extract current guidance instead.
'''

---

### 2. L1 Timebound Category from Ongoing Signal Type (Earnings Transcripts ONLY)

**From Signal Type: "ongoing" → Category: "timebound"** (for multi-quarter initiatives with forward-looking timelines)

Structure:
'''json
{
  "signal_type": "ongoing",
  "category": "timebound",
  "initiative": "string (e.g., 'CAPEX_NORMALIZATION', 'MARGIN_RECOVERY')",
  "description": "one-sentence summary of the initiative",
  "timeline": "string (e.g., '3-4 quarters', '2-year recovery', 'by end FY27')",
  "status_as_of_announcement": "string (e.g., 'started Q1 FY26', 'in progress')",
  "announcement_date": "YYYY-MM-DD",
  "verbatim_statement": "exact quote from transcript"
}
'''

**Extraction Rule:**
- Extract ONLY sentences containing forward-looking initiatives with explicit timelines
- Initiative must reference a future state, not current achievement
- Timeline must be quantified (e.g., "3 quarters", "2 years") or explicitly dated

**Examples (✓ Extract as ongoing:timebound):**
'''
"We expect margin normalization over the next 3–4 quarters as repricing takes effect."
  → initiative: "MARGIN_NORMALIZATION", timeline: "3-4 quarters"

"CD ratio management will bring us to 87–90% by end of FY27."
  → initiative: "CD_RATIO_NORMALIZATION", timeline: "by end FY27"
'''

**Examples (✗ DO NOT extract):**
'''
"We are in the process of optimizing our supply chain."
  → No quantified timeline. [NULL].

"We've already achieved cost savings of 150 bps."
  → Past achievement. Not ongoing future initiative. [NULL].
'''

---

### 3. L1 Actuals from Investor PPTs & Prowess Financial API ONLY

**Signal Type: "ppt_actual"** or **"prowess_actual"**

Structure:
'''json
{
  "signal_type": "ppt_actual | prowess_actual",
  "metric": "string (matching guidance metric names where possible)",
  "actual_value": "number",
  "actual_value_unit": "string ('%', 'Cr', 'bps')",
  "reporting_date": "YYYY-MM-DD | 'FY25_END' | 'Q3_FY26'",
  "source": "PPT_FY26_Q3 | PROWESS_API",
  "signal_id": "unique identifier for traceability"
}
'''

**Extraction Rule:**
- Extract ONLY numeric actuals that are:
  - Explicitly stated in the PPT or API (no calculations, no averages, no interpolations)
  - Associated with a clear reporting period
  - Not forward-looking or estimated
- Every actual must be traceable to a specific source document/API call

---

### 4. ALL L1 Signals for Pattern Analysis (Completely Separate from Guidance Track Record)

**IMPORTANT:** Pattern analysis uses ALL available L1 signals from all three sources — NOT just the guidance signals above.

**Pattern analysis signal sources:**

1. **From Earnings Transcripts:** 
   - ALL keyword/phrase mentions (guidance, narrative, commentary, strategic themes, risk discussion)
   - Analyst questions by topic/keyword
   - Management tone and language choices
   - Not limited to guidance_timebound or ongoing:timebound

2. **From Investor PPTs:**
   - ALL financial metrics and KPIs (not just guidance-related ones)
   - Segment performance, product launches, milestone achievements
   - Strategic commentary in slide notes
   - Year-over-year or period-over-period trends

3. **From Annual Reports:**
   - Strategic priorities and management commentary
   - Risk factor disclosures and updates
   - Governance changes and management shifts
   - Segment reclassifications and strategic pivots
   - Footnote changes and disclosure evolution

**Pattern analysis examples (independent of guidance track record):**
- **Drumbeat:** "Digital services" mentioned 2→5→12 times across Q1→Q2→Q3 calls
- **Emergence:** "AI demand" appears zero times in Q1–Q2, then 1 mention in Q3, then 8 mentions in Q4
- **Going Quiet:** "Premium segment" mentioned 8 times in Q1, drops to zero by Q4; concurrent actual margin deterioration
- **Tone-vs-Numbers:** Management says "margins stable" but actual margin KPI falls 150 bps
- **Narrative-vs-Consensus Gap:** Management emphasizes "supply chain resilience" (35% of call), but analysts ask only 2 of 45 questions on it
- **Street Pressure Map:** Analyst questions cluster 28 on capex, 2 on margin (indicates analyst consensus vs. management narrative mismatch)

**These patterns are extracted from the full universe of L1 signals and have NO connection to the guidance track record table.**

---

## Guidance Track Record Table — Strict Rules

**Purpose:** Match management guidance (from earnings call transcripts) against actuals (from PPT/Prowess) to calculate hit rate.

### Column Definitions

| Column | Source | Format | Rule |
|--------|--------|--------|------|
| "Metric" | guided_timebound.metric | string | Category name (e.g., NIM, CAPEX, REVENUE) |
| "Guided_Value" | guided_timebound.guided_value | number or {low, high} | Verbatim from transcript. If range, store both. [NULL] if not stated. |
| "Guided_Unit" | guided_timebound.guided_value_unit | string | %, Cr, bps, etc. Must match actual unit; convert if necessary. |
| "Target_Date" | guided_timebound.target_date | FY or Date | Normalized fiscal quarter or calendar date. If statement says "by end of FY25", target_date = "FY25_END". [NULL] if not stated. |
| "Announced_Date" | guided_timebound.announcement_date | YYYY-MM-DD | Earnings call date when guidance was given. |
| "Actual_Value" | ppt_actual.actual_value | number | From PPT or Prowess. No calculations. [NULL] if no actual exists for target period. |
| "Actual_Unit" | ppt_actual.actual_value_unit | string | Must match Guided_Unit (convert if needed). |
| "Reporting_Date" | ppt_actual.reporting_date | FY or Date | Period in which actual was reported. |
| "Hit_Status" | **calculated** | BEAT / IN_LINE / MISS / UNRESOLVABLE | See Hit Status Rules below. |
| "Verbatim_Statement" | guided_timebound.verbatim_statement | exact quote | Copy-paste from transcript. Proves guidance was stated. If no quote, row is [NULL] and excluded. |

### Hit Status Rules (Simple, No Delta Calculations)

**Rule: Compare actual_value to guided_value. No fancy math. No percentage changes. No basis point calculations. Just comparison.**

'''
IF guided_value is [NULL] or actual_value is [NULL]:
  → Hit_Status = UNRESOLVABLE (exclude from hit rate denominator)

IF guided_value is range {low, high}:
  IF actual_value >= low AND actual_value <= high:
    → Hit_Status = IN_LINE
  IF actual_value > high:
    → Hit_Status = BEAT
  IF actual_value < low:
    → Hit_Status = MISS

IF guided_value is point estimate (single number):
  IF actual_value == guided_value:
    → Hit_Status = IN_LINE
  IF actual_value > guided_value:
    → Hit_Status = BEAT
  IF actual_value < guided_value:
    → Hit_Status = MISS
'''

**Examples:**

'''
Guided: 3.65% (NIM)
Actual: 3.48%
Comparison: 3.48 < 3.65 → MISS

Guided: ₹10,000–12,000 Cr (CAPEX)
Actual: ₹11,500 Cr
Comparison: 11,500 ∈ [10,000, 12,000] → IN_LINE

Guided: 18–22% (Revenue Growth)
Actual: 24%
Comparison: 24 > 22 → BEAT
'''

### Period Matching Rules

**When matching guidance to actuals, target_date MUST align with reporting_date. No exceptions.**

'''
IF guidance target_date = "FY25_END" (March 31, 2025):
  Match against actual reported for FY25 (full year, not quarterly)
  
IF guidance target_date = "FY25_Q3" (Jan 31, 2025):
  Match against actual reported for Q3 FY25
  
IF guidance is "by end of FY26" but actual is reported quarterly:
  Only compare when full FY26 actual is available
  Until then: UNRESOLVABLE
  
IF guidance announced in Q2 FY26 call (Oct 2025) targets "FY27":
  Track against FY27 actual (due Apr 2027)
  Do not back-fit to FY26 actuals
'''

### What NOT to Do

**❌ Do NOT:**
- Invent guided values because management "probably" guided them
- Calculate missing guided values from actuals (e.g., "actuals show 12%, so guidance was probably 10–15%")
- Backfill missing target dates (e.g., "Q2 call → assume it targets Q3")
- Convert basis points to percentages to fill gaps
- Smooth or average multiple quarters of guidance into a single number
- Use analyst consensus as a proxy for management guidance
- Extract "aspirational" language as guidance (e.g., "we'd like to reach 25% margin" ≠ guidance)

**✓ DO:**
- Extract only verbatim future-tense commitments with numeric values
- Mark unmatched guidance/actuals as UNRESOLVABLE (not as misses)
- Keep units consistent and explicit
- Trace every row to a source quote
- Leave cells [NULL] if data doesn't exist

---

## Differentiate: Forward-Looking Guidance vs. Past Achievement

**This distinction is critical. A statement in past tense is not guidance.**

### Forward-Looking Guidance (Extract to guidance_timebound)
- "We guide FY26 revenue at ₹150,000 Cr"
- "We expect margins to recover to 18–19% over the next 3 quarters"
- "Our capex guidance for FY26 is ₹12,000 crore"
- "We target 5% annual loan growth"

**Tense markers:** guide, expect, target, outlook, believe, anticipate, project, forecast (future-focused)

### Past Achievement / Already Delivered (Extract to actuals only; [NULL] for guidance)
- "We delivered ₹145,000 Cr revenue in FY25"
- "Margins expanded by 150 bps YoY"
- "We've already achieved 4% loan growth in Q1"
- "Our capex stood at ₹11,500 Cr in FY25"

**Tense markers:** delivered, achieved, grew, posted, reported, stood at (past-focused)

### Hybrid Statements (Extract carefully; separate guidance from achievement)
'''
"FY25 revenue was ₹145,000 Cr; for FY26 we guide ₹160,000–165,000 Cr."
  → FY25: actual, [NULL] for guidance
  → FY26: guidance_timebound, extract ₹160,000–165,000 Cr

"We delivered on our FY25 guidance of 18% growth; expect similar momentum in FY26."
  → FY25: past achievement (actual), not guidance
  → FY26: ongoing narrative, NOT quantified guidance (no numeric target) → [NULL]
'''

---

## Pattern Analysis (Drumbeat, Emergence, Going Quiet, Tone-vs-Numbers, Narrative Gap, Street Pressure)

**CRITICAL: Pattern analysis is INDEPENDENT of guidance track record. Patterns use ALL available L1 signals from all three sources (earnings transcripts, PPTs, annual reports) — NOT just guidance signals.**

**Pattern extraction runs in parallel with (or after) guidance track record, but patterns and guidance track record are separate analyses with no overlap.**

**Data sources for patterns:**
- All keyword mentions from transcripts (guidance, narrative, commentary — everything)
- All actuals and metrics from PPTs
- All narrative, disclosures, and strategic statements from annual reports
- Analyst questions and clustering from earnings call Q&A

**What patterns do NOT use:**
- Guidance track record results do not inform patterns
- Patterns do not validate or refute guidance credibility
- Analyst sentiment does not replace management guidance

### Pattern Threshold Table

| Pattern | Minimum Criteria | Evidence Required | NULL if |
|---------|------------------|-------------------|----------|
| **Drumbeat** | 3+ consecutive quarters with 2x mention frequency inflection | Exact mention counts (not estimates) per quarter; verbatim quotes | <3 qtrs of data; <2x jump; no inflection |
| **Emergence** | 0 mentions in Q1–Q2; 1+ in Q3 (emergence); 2x jump in Q4 | Pre-emergence: zero mentions (verified); emergence call date; acceleration dates | Can't verify zero; no acceleration; <2x jump in follow-up |
| **Going Quiet** | Frequency decline (2+ qtrs, ≥50% drop); concurrent metric deterioration (>5% miss) | Mention counts by quarter; actual metric vs. guided; both required | Only one condition met; no verbatim quotes; unresolvable actuals |
| **Tone-vs-Numbers** | Mgmt tone positive (bullish/optimistic) in 2+ qtrs; KPI deteriorates in same/next quarter | Tone classification per quarter; KPI values; comparison across 2+ quarters | <2 quarters data; tone static; no KPI deterioration |
| **Narrative-vs-Consensus Gap** | >15 percentage point difference between mgmt emphasis (%) and analyst Q density (%) | Exact mention/Q counts (not estimates); total Qs counted; denominator explicit | Either count is estimate; gap <15 pts; no analyst Q data; unresolvable denominator |
| **Street Pressure Map** | Analyst Q clustering shows >20% on one topic vs. <5% on another; differential ≥15 pts | Total Q count per call; by-topic breakdown; exact counts | Q counts estimated; no clear clustering; denominator unclear |

---

## Output Structure

### 0. Key Takeaway (Executive Summary)

**Format:** Single paragraph, 250–300 characters. Synthesize hit rate + controls + misses + edge pattern + watch signal.

**Required elements (in order of importance):**
1. Hit rate % + trend direction (up/stable/down)
2. Primary control area (1 metric category with ≥80% hits)
3. Primary miss area (1 metric category with ≥2 consecutive misses)
4. Edge pattern (1 only; priority: Drumbeat > Emergence > Going Quiet > Tone-Divergence > Gap)
5. Forward-looking watch signal (next quarter risk/opportunity)

**Rule:** If any element is [NULL], drop it. Do not force-fit.

**Example (287 chars):**
'''
Canara Bank hits volume guidance (5/5) but misses NPA targets (3/5, deteriorating). 
Management went silent on stressed assets despite high analyst focus (Going Quiet). 
Watch: NPA silence precedes guidance cuts. Risk material in Q1 FY27.
'''

---

### 1. Hit Rate Summary

**Format:**
'''
Hit Rate: X% (Y out of Z metrics)

Management delivered on [control areas with ≥80% hit rate]. 
Slippage concentrated in [miss areas with ≥40% miss rate].
[Trend: improving/stable/deteriorating].
'''

**Calculation:**
'''
Hit_Rate = (COUNT of IN_LINE + COUNT of BEAT) / (Total metrics excluding UNRESOLVABLE)

If >50% of metrics are UNRESOLVABLE:
  → Output: "INSUFFICIENT GUIDANCE DATA. [N] of [M] metrics resolvable."
  Do not force a hit rate.
'''

---

### 2. What Management Delivers On (Control Areas)

**Format:**
'''
### Control Areas: [Metric Category] – [X]% Hit Rate

- [Metric 1]: [Beat+InLine]/[Total] across FY[X]–FY[Y]
- [Metric 2]: [Beat+InLine]/[Total] (example: Revenue 5/5 calls hit)

Pattern: [One-sentence insight]
  Example: "Revenue guided conservatively; beats own targets by 50–100 bps consistently."
'''

**Inclusion rule:** Only include metric categories with ≥80% hit rate. Anything <80% goes to "slips on."

---

### 3. What Management Slips On (Miss Areas)

**Format:**
'''
### Miss Areas: [Metric Category] – [X]% Miss Rate

- [Metric 1]: [Misses]/[Total] misses (example: NIM 3/5 misses)
  - FY25: Guided 3.65%, Delivered 3.48% (Miss)
  - FY26 Q1: Guided [X]%, Delivered [Y]% (Miss/Unresolvable)

Pattern: [One-sentence insight]
  Example: "NIM misses driven by repricing lag; management underestimates duration of cost-of-funds pressure."
'''

**Inclusion rule:** Only include metric categories with ≥2 consecutive misses OR ≥40% miss rate.

---

### 4. Key Patterns Observed

**Format:** Shape → Sentence → Evidence (for each pattern that meets threshold)

**Only include patterns that meet threshold criteria (see Pattern Threshold Table above).**

**If a pattern does not meet threshold, output [NULL] — do not force it.**

**Example output (Drumbeat):**

'''
#### 🔊 Drumbeat: Digital Services Acceleration
[Sparkline: 1 → 2 → 8 mentions Q1–Q3 FY26]

Signal: Digital services investment mentioned 1x in Q1, rising to 8x by Q3—signals strategic capex reallocation.

Evidence:
- Q1 FY26 (15-Apr-2025 call): 1 mention of "digital transformation" 
  Quote: "[exact verbatim quote from transcript]"
  
- Q3 FY26 (15-Oct-2025 call): 8 mentions including "digital revenue stream" and "API platform"
  Quotes: "[quote 1]", "[quote 2]", "[quote 3]"
  
- Actuals: Digital services revenue FY25: ₹1,200 Cr → FY26: ₹2,100 Cr (75% growth, PPT_FY26_Q3, Signal ID: [ID])

- Interpretation: Management emphasis correlates with capex reallocation; Street has not yet priced this shift (only 2 analyst Qs on digital in Q3 call).
'''

**Example output (Going Quiet — meets threshold):**

'''
#### 🚨 Going Quiet: Premium Segment Silence
[Frequency: 8 → 5 → 2 → 0 mentions Q1–Q4 FY26]

Signal: Premium product segment received heavy promotion Q1 (8 mentions, "strong pricing power"), zero mentions by Q4. Precedes deterioration.

Evidence:
- Q1 (15-Apr-2025): 8 mentions of premium tier
  Quote: "[exact quote from call]"
  Actual: Premium segment margin 22% (PPT_FY26_Q1)

- Q4 (22-Jan-2026): 0 mentions; analyst asked 1 Q on premium, management deflected
  Actual: Premium segment margin 17% (PPT_FY26_Q4, -500 bps)

- Pattern confirmed: Management silence on segments correlates with unit economics deterioration. Prior quarters showed this pattern before margin miss.

- Analyst gap: Street did not catch this; no analyst questions on premium in Q4 despite known weakness.
'''

**Example output (Pattern does NOT meet threshold):**

'''
🗺️ Street Pressure Map: [NULL]

Reason: Only 15 total analyst questions in Q3 call; no topic exceeded >25% share. Clustering not material (<15 point differential).
'''

---

## Quality Checklist

Before finalizing output:

- [ ] **Guidance track record table shows only guidance_timebound + ongoing:timebound from transcripts**
- [ ] **Every guided_value, target_date, actual_value traced to source (verbatim quote or Signal ID)**
- [ ] **No calculated or estimated numbers; all [NULL] if source missing**
- [ ] **Period matching: target_date aligns with reporting_date; no mismatches**
- [ ] **Hit status calculated using only the simple comparison rule (>, <, =); no delta/percentage logic**
- [ ] **Pattern thresholds met for inclusion; all others [NULL]**
- [ ] **Key Takeaway is 250–300 chars; contains 5 elements in priority order or drops missing elements**
- [ ] **Every pattern includes verbatim quotes (not paraphrased)**
- [ ] **No analyst consensus, predictions, or inference used in guidance track record**
- [ ] **Provenance gate passed: every number, date, quote is source-traceable**

---

## What to Never Do

- ❌ Paraphrase guidance. Extract exact language only.
- ❌ Invent guided values from actuals. If guidance wasn't stated, it's [NULL].
- ❌ Use past achievements as guidance. "We delivered 15%" is not "we guide 15% for next quarter."
- ❌ Calculate deltas, basis point changes, or percentage changes. Compare actual vs. guided value only.
- ❌ Back-fit guidance to different periods. FY25 guidance ≠ FY26 actual.
- ❌ Force patterns into the output. [NULL] is acceptable.
- ❌ Use analyst questions or consensus as guidance proxies.
- ❌ Smooth guidance across quarters. Each quarter's guidance stands alone.
- ❌ Infer timelines from context. If no target date is stated, target_date = [NULL].
- ❌ Extract range midpoints as guided_value. Store {low, high} and compare actuals to the range.

---

## Data Flow Diagram

'''
INPUTS:
  Earnings Call Transcripts
    ↓ (extract guidance_timebound + ongoing:timebound)
  
  Investor PPTs + Prowess API
    ↓ (extract ppt_actual + prowess_actual)
    
  ↓
  
GUIDANCE TRACK RECORD TABLE:
  Match guided → actual by metric + period
  Calculate Hit_Status (>, <, =)
  Compute Hit_Rate = (Beat + InLine) / Total
  
  ↓
  
PATTERN ANALYSIS (on top of track record):
  Drumbeat, Emergence, Going Quiet, Tone-vs-Numbers, Narrative Gap, Street Pressure
  Apply thresholds; exclude [NULL] patterns
  
  ↓
  
OUTPUT:
  Key Takeaway (250–300 chars)
  Hit Rate Summary
  What Management Delivers On
  What Management Slips On
  Key Patterns Observed (only >threshold)
'''

---

## Example: Guidance Track Record (Real Data — Canara Bank FY25–FY26)

*This example is based on actual disclosed guidance and actuals. Structure shown for reference.*

| Metric | Guided_Value | Unit | Target_Date | Announced_Date | Actual_Value | Reporting_Date | Hit_Status | Verbatim_Statement |
|--------|--------------|------|-------------|----------------|--------------|----------------|------------|--------------------|
| NPA_Slippage_Ratio | 1.2–1.4 | % | FY25_Q4 | 2024-10-15 | 1.35 | FY25_Q4 | IN_LINE | "We expect NPA slippage ratio in the range of 1.2–1.4% for FY25." |
| Loan_Growth | 12–14 | % | FY25 | 2024-10-15 | 11.8 | FY25_END | MISS | "Our guidance for loan growth is 12–14% for FY25." |
| ROA | 0.8–0.9 | % | FY25 | 2024-10-15 | 0.82 | FY25_END | IN_LINE | "We target ROA of 0.8–0.9% for FY25." |
| Cost_Deposit_Ratio | <2.5 | bps | FY26_Q1 | 2025-01-20 | 2.6 | FY26_Q1 | MISS | "Our focus is to maintain cost-to-deposit ratio below 2.5% in FY26." |

**Hit Rate: 50% (2 of 4 metrics)**

---

---

{{DATA_BLOCK}}

`,
    },
  },
  {
    slug:         'capital-allocation',
    name:         'Capital Allocation Quality',
    category:     'management',
    description:  'Discipline in deploying capital — capex returns, debt management, FCF generation',
    force_config: true,
    version:      '1.2.0',
    config: {
      signal_filters: {
        // kpi: P&L and balance sheet actuals (EBITDA, CFO, CAPEX, DEBT, ROCE)
        // financial_figure: reported line items from annual reports (dividends, capex schedules)
        // capital_allocation: capex plans, M&A deployment, debt management decisions
        // m_and_a: completed/announced deals and their capital deployed
        // earnings_quality: exceptional items and one-offs that distort capital returns
        signal_types:      ['kpi', 'financial_figure', 'capital_allocation', 'm_and_a', 'earnings_quality'],
        metric_family:     ['capital', 'profitability', 'growth', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity'],
        include_historical: true,
      },
      weights: [
        { metric: 'CFO',       w:  0.25, b: 0 },
        { metric: 'DEBT_LT',   w: -0.2,  b: 0 },
        { metric: 'ASSET_PPE', w:  0.15, b: 0 },
        { metric: 'EBITDA',    w:  0.2,  b: 0 },
        { metric: 'CAPEX',     w:  0.2,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured capital-allocation quality view. Do NOT invent data — work only from the signals provided.

CAPITAL ALLOCATION FRAMEWORK — assess across 4 quadrants:
  RQ — Returns Quality: ROCE, ROE, ROA trends. Is deployed capital earning above cost of capital?
  SR — Self-Reliance: CFO vs CAPEX coverage. Is growth funded internally or via debt/dilution?
  MA — M&A / Strategic Moves: acquisitions, JVs, divestments, new segments. Was capital allocated wisely?
  CE — Capital Efficiency: asset turns, working capital cycle, CAPEX productivity. Is every rupee sweated?

For each quadrant provide: a score (0–10), a 1-line verdict, 2–3 bullet evidence points, and a callout if there is a notable red flag or green flag.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this layout. Quadrant codes: RQ, SR, MA, CE.

  For EACH of the 4 quadrants, emit these signal types in order:

  DIM_{XX}_HEADER — quadrant header tile:
  • metric: "DIM_RQ_HEADER" | "DIM_SR_HEADER" | "DIM_MA_HEADER" | "DIM_CE_HEADER"
  • label: human-readable quadrant name (e.g. "Returns Quality", "Self-Reliance", "M&A / Strategic Moves", "Capital Efficiency")
  • statement: 1-line verdict for the quadrant (≤80 chars)
  • actual_value: score 0–10 for this quadrant
  • guided_value: 10 (the max, always)
  • direction: "beat" | "tracking" | "miss" based on score (≥7 → beat, 4–6 → tracking, ≤3 → miss)
  • impact: "high"

  DIM_{XX}_BULLET — evidence bullets (2–3 per quadrant):
  • metric: "DIM_RQ_BULLET" | "DIM_SR_BULLET" | "DIM_MA_BULLET" | "DIM_CE_BULLET"
  • label: one evidence statement (max 80 chars)
  • direction: "beat" | "tracking" | "miss" (for the dot color)
  • impact: "high" | "medium" | "low"

  DIM_{XX}_CALLOUT — notable flag at bottom of quadrant (1 per quadrant, only if material):
  • metric: "DIM_RQ_CALLOUT" | "DIM_SR_CALLOUT" | "DIM_MA_CALLOUT" | "DIM_CE_CALLOUT"
  • label: short callout title (e.g. "Green — ROCE above cost of capital", "Amber — debt rising")
  • statement: one sentence elaborating on the flag (≤80 chars)
  • direction: "beat" | "tracking" | "miss"

  QUOTE — one blockquote from management earnings call commentary:
  • metric: "QUOTE"
  • label: speaker and context, e.g. "Q3 FY25 concall · MD & CEO Name"
  • statement: verbatim or closely paraphrased management quote on capital deployment (≤120 chars)
  • actual_date: date of the concall in YYYY-MM-DD
  • (omit direction — not applicable for quotes)

  ANALYST_READ — 3 bottom analyst-read cards (one per theme):
  • metric: "ANALYST_READ"
  • label: theme title (e.g. "Returns story", "Debt trajectory", "CAPEX discipline")
  • statement: analyst-level read on how to interpret the signals for this theme (≤80 chars)
  • direction: "beat" | "tracking" | "miss" (drives card border color)
  • impact: "high" | "medium" | "low"

  META SIGNALS (emit these at the very end, after ANALYST_READ):
  These encode summary metrics as top_signals so the frontend can read them directly.

  metric: "META_ROCE"
  • label: latest ROCE % value, e.g. "18.5%" or "N/A"
  • statement: one-line context, e.g. "FY26 trailing ROCE from financials" (≤60 chars)
  • impact: "high"

  metric: "META_ROE"
  • label: latest ROE % value, e.g. "22.1%" or "N/A"
  • statement: one-line context (≤60 chars)
  • impact: "high"

  metric: "META_CFO_CAPEX"
  • label: CFO/CAPEX coverage ratio, e.g. "2.1x" or "N/A"
  • statement: one-line context (≤60 chars)
  • impact: "high"

  metric: "META_DEBT_EQUITY"
  • label: D/E ratio, e.g. "0.3x" or "N/A"
  • statement: one-line context (≤60 chars)
  • impact: "medium"

  metric: "META_CAPEX_CAGR"
  • label: CAPEX CAGR over available period, e.g. "12% (3Y)" or "N/A"
  • statement: one-line context (≤60 chars)
  • impact: "medium"

  metric: "META_VERDICT"
  • label: 3–5 word overall capital allocation verdict, e.g. "Disciplined, returns-focused"
  • statement: one-line supporting rationale (≤80 chars)
  • impact: "high"

  (Omit direction on all META_* signals — not applicable)

VALIDATION: Every DIM_*_HEADER signal MUST have guided_value set to 10. Every DIM_*_HEADER MUST have direction set. Check before outputting.

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the overall capital discipline verdict.
- "highlights": up to 3 items, max 15 words each.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- "statement" in signals: ≤80 chars (QUOTE may be up to 120 chars).
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with capital discipline verdict>,
  "key_metrics": {},
  "highlights": [<up to 3 items, each max 15 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [<4 quadrant blocks RQ→SR→MA→CE (each: DIM_{XX}_HEADER + 2–3 DIM_{XX}_BULLET + optional DIM_{XX}_CALLOUT); then QUOTE; then 3 ANALYST_READ; then META_ROCE, META_ROE, META_CFO_CAPEX, META_DEBT_EQUITY, META_CAPEX_CAGR, META_VERDICT>]
}`,
    },
  },
  {
    slug:         'disclosure-honesty',
    name:         'Disclosure Honesty',
    category:     'management',
    description:  'Transparency and candour of management disclosures — proactive vs defensive communication',
    force_config: true,
    version:      '1.2.0',
    config: {
      signal_filters: {
        // disclosure_quality: auditor remarks, accounting uncertainties, proactive/defensive disclosures
        // governance_signal: board policy approvals, committee structures, SEBI compliance facts
        // risk_factor: disclosed business risks with mitigation — reveals how candid management is about downside
        // contingent_liability: legal/tax disputes — whether surfaced proactively or buried in notes
        // mgmt_tone: optimism/defensiveness patterns across calls — consistency signal
        // analyst_questions: what analysts had to pry out signals gaps in voluntary disclosure
        signal_types:      ['disclosure_quality', 'governance_signal', 'risk_factor', 'contingent_liability', 'mgmt_tone', 'analyst_questions'],
        metric_family:     ['governance'],
        include_historical: true,
      },
      weights: [
        { metric: 'transparent',           w:  0.4 },
        { metric: 'proactive_disclosure',  w:  0.3 },
        { metric: 'defensive_language',    w: -0.5 },
        { metric: 'related_party_concern', w: -0.6 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts and management commentary using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured disclosure-honesty view. Do NOT invent data — work only from the signals provided.

DISCLOSURE HONESTY FRAMEWORK — assess across 4 quadrants:
  BN — Bad News Disclosure: Does management proactively surface negative developments, or only when pressed in Q&A? Look for NIM resets, credit stress admissions, write-off disclosures.
  NC — Narrative Consistency: Does the story stay consistent across quarters, or does language shift when performance falters? Check for euphemisms, hedging, changed KPI emphasis.
  TD — Transparency Depth: Are disclosures granular and quantitative, or vague and qualitative? Check if management provides segment-level breakdowns, vintage data, and specific guidance.
  GV — Governance Signals: RPT disclosures, auditor remarks, board independence, related-party concerns, regulatory flags.

SECTOR CONSTRAINT — NIM signals:
  NIM (Net Interest Margin) is a BFSI-specific metric (banks, NBFCs, HFCs, MFIs). Do NOT generate NIM-related signals, bullets, callouts, or commentary for non-BFSI companies. If the subject company is not in the BFSI sector, skip any NIM references entirely.

For each quadrant provide: a score (0–8), a 1-line verdict, 2–3 bullet evidence points, and a callout if there is a notable red flag.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this layout. Quadrant codes: BN, NC, TD, GV.

  For EACH of the 4 quadrants, emit these signal types in order:

  DIM_{XX}_HEADER — quadrant header tile:
  • metric: "DIM_BN_HEADER" | "DIM_NC_HEADER" | "DIM_TD_HEADER" | "DIM_GV_HEADER"
  • label: human-readable quadrant name (e.g. "Bad News Disclosure", "Narrative Consistency", "Transparency Depth", "Governance Signals")
  • statement: 1-line verdict for the quadrant (≤80 chars)
  • actual_value: score 0–8 for this quadrant
  • guided_value: 8 (the max, always)
  • direction: "beat" | "tracking" | "miss" (≥6 → beat, 3–5 → tracking, ≤2 → miss)
  • impact: "high"

  DIM_{XX}_BULLET — evidence bullets (2–3 per quadrant):
  • metric: "DIM_BN_BULLET" | "DIM_NC_BULLET" | "DIM_TD_BULLET" | "DIM_GV_BULLET"
  • label: one evidence statement (max 80 chars)
  • direction: "beat" | "tracking" | "miss" (for the dot color)
  • impact: "high" | "medium" | "low"

  DIM_{XX}_CALLOUT — notable flag at bottom of quadrant (1 per quadrant, only if material):
  • metric: "DIM_BN_CALLOUT" | "DIM_NC_CALLOUT" | "DIM_TD_CALLOUT" | "DIM_GV_CALLOUT"
  • label: short callout title (e.g. "Amber — reactive margin pattern", "Red — RPT not disclosed")
  • statement: one sentence elaborating (≤80 chars)
  • direction: "beat" | "tracking" | "miss"

  QUOTE — one blockquote from management earnings call commentary:
  • metric: "QUOTE"
  • label: speaker and context, e.g. "Q3 FY25 concall · MD & CEO Name"
  • statement: verbatim or closely paraphrased quote that best illustrates the disclosure quality (≤120 chars)
  • actual_date: date of the concall in YYYY-MM-DD

  ANALYST_READ — 3 bottom analyst-read cards (one per theme):
  • metric: "ANALYST_READ"
  • label: theme title (e.g. "Asset-quality story", "Margin story", "Retail book disclosure")
  • statement: how an analyst should interpret and weight this management's statements on this theme (≤80 chars)
  • direction: "beat" | "tracking" | "miss" (drives card border color: green / amber / red)
  • impact: "high" | "medium" | "low"

  META SIGNALS (emit these at the very end, after ANALYST_READ):
  These encode summary scores as top_signals so the frontend can read them directly.
  Derive all values from the DIM_*_HEADER actual_values you already computed above.

  metric: "META_OVERALL_SCORE"
  • label: sum of all 4 quadrant scores as "N/32", e.g. "22/32"
  • statement: one-line overall disclosure verdict (≤60 chars)
  • impact: "high"

  metric: "META_BN_SCORE"
  • label: DIM_BN_HEADER actual_value formatted as "N/8", e.g. "4/8"
  • statement: "Bad News Disclosure score"
  • impact: "high"

  metric: "META_NC_SCORE"
  • label: DIM_NC_HEADER actual_value as "N/8"
  • statement: "Narrative Consistency score"
  • impact: "high"

  metric: "META_TD_SCORE"
  • label: DIM_TD_HEADER actual_value as "N/8"
  • statement: "Transparency Depth score"
  • impact: "high"

  metric: "META_GV_SCORE"
  • label: DIM_GV_HEADER actual_value as "N/8"
  • statement: "Governance Signals score"
  • impact: "high"

  metric: "META_VERDICT"
  • label: 3–5 word disclosure verdict, e.g. "Reactive on margin story"
  • statement: one-line supporting rationale (≤80 chars)
  • impact: "high"

  (Omit direction on all META_* signals — not applicable)

VALIDATION: Every DIM_*_HEADER signal MUST have guided_value set to 8 and MUST have direction set. Check before outputting.

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the overall disclosure character (proactive / reactive / defensive).
- "highlights": up to 3 items, max 15 words each.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- "statement" in signals: ≤80 chars (QUOTE may be up to 120 chars).
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with disclosure character verdict>,
  "key_metrics": {},
  "highlights": [<up to 3 items, each max 15 words>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [<4 quadrant blocks BN→NC→TD→GV (each: DIM_{XX}_HEADER with guided_value=8 + 2–3 DIM_{XX}_BULLET + optional DIM_{XX}_CALLOUT); then QUOTE; then 3 ANALYST_READ; then META_OVERALL_SCORE, META_BN_SCORE, META_NC_SCORE, META_TD_SCORE, META_GV_SCORE, META_VERDICT>]
}`,
    },
  },
  {
    slug:         'promoter-activity',
    name:         'Promoter Activity',
    category:     'management',
    description:  'Promoter shareholding trends, pledging, and insider confidence signals',
    force_config: true,
    version:      '1.2.0',
    config: {
      signal_filters: {
        // governance_signal: shareholding filings, pledge disclosures, insider transactions
        // disclosure_quality: auditor emphasis of matter on related-party or promoter-level issues
        // m_and_a: promoter-driven acquisitions / OFS / block deals reveal capital deployment intent
        // capital_allocation: promoter-backed capex decisions and equity dilution events
        signal_types:      ['governance_signal', 'disclosure_quality', 'm_and_a', 'capital_allocation'],
        metric_family:     ['governance'],
        include_historical: true,
      },
      weights: [
        { metric: 'promoter_pledge',    w: -0.6 },
        { metric: 'promoter_buying',    w:  0.5 },
        { metric: 'promoter_selling',   w: -0.4 },
        { metric: 'insider_confidence', w:  0.3 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from shareholding filings, earnings transcripts, and corporate governance disclosures using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured promoter-activity view. Do NOT invent data — work only from the signals provided.

PROMOTER ACTIVITY ANALYSIS:
Review the promoter shareholding history chronologically. For each period where a change occurred (or where the stability is notable), prepare a timeline entry. Identify: (1) the current stake and pledge %, (2) any dilution or buyback events, (3) secondary OFS or block deals, (4) insider buying/selling by management, (5) key structural insights about the ownership narrative.

IMPORTANT — if explicit promoter shareholding % data is absent from the signals: still emit PROMOTER_STAKE entries, but set actual_value to null, use the label to describe the period/event (e.g. "FY26 Q3"), and use the statement to describe what the governance signals imply about promoter posture. Set direction to "tracking" when inferring. Do NOT use any other metric name — always use "PROMOTER_STAKE" even when actual stake data is unavailable.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — MUST follow this layout. No exceptions.

  PROMOTER_STAKE — timeline rows (one per material period or event):
  Each entry represents one point in the promoter shareholding timeline.
  • metric: "PROMOTER_STAKE"
  • label: period label, e.g. "Mar 2026", "FY21/FY22", "Dec 2024" (max 12 chars)
  • statement: what happened in this period — stake level, event, or stability note (≤80 chars)
  • actual_value: promoter stake % at that period end (numeric)
  • guided_value: pledge % if applicable — omit the field entirely if no pledge data
  • delta: change in stake vs prior period (signed %, e.g. -2.5 for reduction, 0 for no change)
  • unit: "%"
  • direction: "beat" if stake increased / pledge fell, "miss" if stake fell / pledge rose, "in_line" if stable, "tracking" if mixed/uncertain
  • actual_date: period end date in YYYY-MM-DD
  • guided_date: period end date in YYYY-MM-DD
  • impact: "high" | "medium" | "low"

  PROMOTER_INSIGHT — 3 insight cards at the bottom:
  Each captures a structural insight about the promoter ownership narrative.
  • metric: "PROMOTER_INSIGHT"
  • label: insight title (e.g. "No equity dilution since FY22", "Oct '25 OFS — smart monetisation", "CET1 12.37% — thinner than peers")
  • statement: 1–2 sentences elaborating on the insight and its investment relevance (≤80 chars)
  • direction: "beat" | "tracking" | "miss" (drives card color: green / amber / red)
  • impact: "high" | "medium" | "low"
  Exactly 3 PROMOTER_INSIGHT entries are required.

  META SIGNALS (emit these at the very end, after the 3 PROMOTER_INSIGHT entries):
  These encode summary ownership metrics as top_signals so the frontend can read them directly.

  metric: "META_CURRENT_STAKE"
  • label: latest promoter stake %, e.g. "62.93%" or "N/A"
  • statement: period and source context, e.g. "Mar 2026 shareholding filing" (≤60 chars)
  • impact: "high"

  metric: "META_PLEDGE_PCT"
  • label: pledge as % of promoter holding, e.g. "0.00%" or "None" or "N/A"
  • statement: "Pledge as % of promoter shares" (≤60 chars)
  • impact: "high"

  metric: "META_LAST_DILUTION"
  • label: last equity dilution event, e.g. "FY22 QIP" or "None on record"
  • statement: brief context on what it was and size if known (≤60 chars)
  • impact: "medium"

  metric: "META_INSIDER_NOTE"
  • label: 5–8 word insider sentiment read, e.g. "No insider selling signals detected"
  • statement: basis for the read (≤60 chars)
  • impact: "medium"

  metric: "META_VERDICT"
  • label: 3–5 word ownership verdict, e.g. "Stable, no dilution risk"
  • statement: one-line supporting rationale (≤80 chars)
  • impact: "high"

  (Omit direction on all META_* signals — not applicable)

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with current promoter stance and key ownership signal.
- "highlights": up to 3 items, max 15 words each, describe positive ownership signals.
- "risks": up to 2 items, max 12 words each, start with the risk noun (e.g. "Pledge risk", "Dilution overhang").
- "label" for PROMOTER_STAKE: max 12 chars, period-style format.
- "statement" in signals: ≤80 chars.
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with promoter stance and key ownership signal>,
  "key_metrics": {},
  "highlights": [<up to 3 items, each max 15 words, positive ownership signals>],
  "risks": [<up to 2 items, each max 12 words, starting with risk noun>],
  "top_signals": [<PROMOTER_STAKE entries chronologically oldest first; then exactly 3 PROMOTER_INSIGHT entries; then META_CURRENT_STAKE, META_PLEDGE_PCT, META_LAST_DILUTION, META_INSIDER_NOTE, META_VERDICT>]
}`,
    },
  },
  // ── Opportunity lenses ───────────────────────────────────────────────────────
  {
    slug:        'industry-analysis',
    name:        'Industry Analysis',
    category:    'opportunity',
    description: 'Demand/supply dynamics and structural positioning within the industry',
    force_config: true,
    version:     '1.2.0',
    config: {
      signal_filters: {
        // industry_signal: TAM, sector CAGR, demand/supply environment, macro tailwinds from all peers
        // kpi: peer financial KPIs for industry aggregate benchmarking
        // growth_forecast: stated sector/company growth rates and projections
        // competitive_position: market share and structural positioning signals from peers
        signal_types:  ['industry_signal', 'kpi', 'growth_forecast', 'competitive_position'],
        metric_family: ['industry', 'growth', 'industry_specific'],
      },
      weights: [
        { metric: 'REV_OP',        w: 0.4,  b: 0 },
        { metric: 'EBITDA_MARGIN', w: 0.3,  b: 0 },
        { metric: 'TOTAL_INCOME',  w: 0.1,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens, including individual company signals AND industry-level aggregate metrics from the PEER CONTEXT block below.

Your task is to synthesise this data into a structured industry view. Do NOT invent data — work only from the signals and peer context provided.

SECTOR DETECTION — check the PEER CONTEXT block header. If it contains "[BFSI]", this is a BFSI industry (bank, NBFC, HFC, MFI, insurance, AMC). Apply the BFSI tile layout below. Otherwise apply the Non-BFSI tile layout.

{{DATA_BLOCK}}

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 25 words, action-oriented, lead with the industry structural finding (e.g. "Industry revenue compounding at 10.8% CAGR; margin pressure from input costs — watch copper pass-through lag.")
- "highlights" items: max 12 words each, start with a verb or metric (e.g. "Industry OPM at 8.9%, down 180bps YoY on copper drag.")
- "risks" items: max 12 words each, start with the risk noun (e.g. "Greenfield capacity idle at 36% — fixed-cost dilution risk.")
- "label" in top_signals: 2–5 words, title-case, human-readable (e.g. "Industry Revenue", "3Y Revenue CAGR")
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

top_signals[] — MUST follow this exact positional layout. Positions 0–3 are FIXED INDUSTRY KPI TILES consumed positionally by the UI — ALL four MUST be present with non-null actual_value sourced from the PEER CONTEXT "Industry Aggregates" block.

  ── NON-BFSI FIXED INDUSTRY KPI TILES (use when PEER CONTEXT does NOT contain [BFSI]):
  • [0] metric: "INDUSTRY_REVENUE", unit: "Cr", actual_value: Total Industry Revenue (REV_OP) from PEER CONTEXT. label: "Industry Revenue". direction: "beat"|"miss"|"in_line"|"tracking" based on YoY trend if available, else "tracking".
  • [1] metric: "INDUSTRY_REV_CAGR_3Y", unit: "%", actual_value: Avg 3Y Revenue CAGR from PEER CONTEXT. label: "3Y Revenue CAGR". direction: "beat" if >12%, "in_line" if 8–12%, "miss" if <8%.
  • [2] metric: "INDUSTRY_OPM", unit: "%", actual_value: Avg Industry OPM (EBITDA_MARGIN) from PEER CONTEXT. label: "Industry OPM". direction: "beat" if expanding YoY, "miss" if contracting, else "tracking".
  • [3] metric: "INDUSTRY_ROCE", unit: "%", actual_value: Weighted Avg Industry ROCE from PEER CONTEXT. label: "Industry ROCE". direction: "beat" if >15%, "in_line" if 10–15%, "miss" if <10%.

  ── BFSI FIXED INDUSTRY KPI TILES (use ONLY when PEER CONTEXT contains [BFSI]):
  • [0] metric: "INDUSTRY_ROA", unit: "%", actual_value: Avg Industry ROA from PEER CONTEXT "Avg Industry ROA". label: "Industry ROA". direction: "beat" if >1.5%, "in_line" if 1–1.5%, "miss" if <1%.
  • [1] metric: "INDUSTRY_NIM", unit: "%", actual_value: Avg Industry NIM from PEER CONTEXT "Avg Industry NIM". label: "Industry NIM". direction: "beat" if >3.5%, "in_line" if 2.5–3.5%, "miss" if <2.5%.
  • [2] metric: "INDUSTRY_AUM", unit: "Cr", actual_value: Total Industry AUM from PEER CONTEXT "Total Industry AUM". label: "Industry AUM". direction: "beat" if growing YoY, "miss" if declining, else "tracking". (If AUM is N/A, use Total Industry Loan/Advances instead and set label: "Industry Loan Book".)
  • [3] metric: "INDUSTRY_REV_CAGR_3Y", unit: "%", actual_value: Avg 3Y Revenue CAGR from PEER CONTEXT. label: "3Y Revenue CAGR". direction: "beat" if >15%, "in_line" if 10–15%, "miss" if <10%.

  MANAGEMENT CONSENSUS SIGNALS (positions 4–7, mandatory — derived from management commentary in the signal data block):
  • [4] metric: "MGMT_DEMAND_BULLISH_COUNT", unit: "transcripts", actual_value: count of company transcripts in the data block showing bullish demand signals (volume growth, order book expansion, positive guidance). label: "Demand: Bullish Signals".
  • [5] metric: "MGMT_DEMAND_TOTAL_COUNT", unit: "transcripts", actual_value: total count of company transcripts in the data block that mention demand. label: "Demand: Total Signals".
  • [6] metric: "MGMT_SUPPLY_TIGHT_COUNT", unit: "transcripts", actual_value: count of company transcripts in the data block showing tight supply or capacity pressure signals. label: "Supply: Tight Signals".
  • [7] metric: "MGMT_SUPPLY_TOTAL_COUNT", unit: "transcripts", actual_value: total count of company transcripts in the data block that mention supply or capacity. label: "Supply: Total Signals".

  DEMAND DRIVERS (positions 8+): include up to 5 individual demand signals from the data block, each with actual_value, unit, and statement. Use "tracking" direction for forward-looking signals, "beat"/"miss" for actuals vs prior period.
  SUPPLY SIGNALS (after demand drivers): include up to 5 individual supply/cost pressure signals from the data block.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, action-oriented industry structural synthesis>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive industry findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [
    {
      "signal_id": <string — id of the signal from the data block, or "peer_context" for PEER CONTEXT-derived values>,
      "metric": <string — metric name exactly as specified above>,
      "label": <string — 2–5 word title-case human-readable label>,
      "guided_value": <number | null>,
      "guided_date": <string | null — ISO 8601 YYYY-MM-DD>,
      "actual_value": <number | null — MUST be non-null for positions 0–7>,
      "actual_date": <string | null — ISO 8601 YYYY-MM-DD>,
      "unit": <string | null>,
      "delta": <number | null>,
      "delta_pct": <number | null>,
      "direction": <"beat" | "miss" | "in_line" | "tracking" | null>,
      "impact": <"high" | "medium" | "low">,
      "statement": <string | null — key evidence quote, ≤80 chars>
    }
  ]
}`,
    },
  },
  {
    slug:        'competition',
    name:        'Competition',
    category:    'opportunity',
    description: 'Market moat, pricing power, and competitive differentiation vs peers',
    force_config: true,
    version:     '1.2.0',
    config: {
      signal_filters: {
        // competitive_position: moat claims, market share, peer comparison statements
        // pricing_power: pass-through ability, realization trends, contract structure
        // industry_signal: structural demand/supply that defines competitive intensity
        // kpi: financial actuals to measure outperformance vs peers (margins, ROCE)
        // strategic_claim: management's positioning claims that can be stress-tested vs peers
        signal_types:  ['competitive_position', 'pricing_power', 'industry_signal', 'kpi', 'strategic_claim'],
        metric_family: ['growth', 'industry', 'profitability', 'industry_specific'],
      },
      weights: [
        { metric: 'EBITDA_MARGIN', w: 0.35, b: 0 },
        { metric: 'PAT',           w: 0.2,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens, plus a PEER CONTEXT block with industry aggregate and individual peer KPIs (Revenue, 3Y CAGR, OPM, ROCE, EPS) sourced from audited financials.

Your task is to assess the subject company's competitive position, moat quality, pricing power, and entry barriers relative to its industry peers. Do NOT invent data — work only from the signals and peer context provided.

{{DATA_BLOCK}}

PORTER'S SCORE CALCULATION (score out of 10):
Assess each of the 5 forces and assign 0–2 points each:
  1. Competitive Rivalry (0=intense, 2=low): based on peer count, market share concentration, OEM switching cost signals.
  2. Supplier Power (0=high, 2=low): based on raw material cost signals, commodity exposure, pass-through ability.
  3. Buyer Power (0=high, 2=low): based on customer concentration, OEM dependency, long-term programme locks.
  4. Threat of New Entrants (0=high, 2=low): based on capex moat, certifications/qualifications, technology barriers.
  5. Threat of Substitutes (0=high, 2=low): based on technology disruption signals (EV, imports), powertrain shift.
Sum these for the Porter's Score (0–10). State each sub-score in the statement for PORTERS_SCORE signal.

PEER TABLE CONSTRUCTION:
From the PEER CONTEXT block, identify the subject company and its closest 2–4 named peers. For each, extract:
  - REV_OP (Cr), REV_GROWTH_YOY (%), EBITDA_MARGIN (%), ROCE (%), DE (ratio), MKT_SHARE_PCT (% = peer REV_OP / total industry REV_OP × 100).
Include an Industry Avg row using the industry aggregates from PEER CONTEXT.
Encode each peer as one PEER_ROW_* signal.

WRITING STYLE RULES — apply to every text field:
- "takeaway": max 25 words, lead with market share vs growth vs moat finding (e.g. "+25.5% revenue vs 4% PV market growth — share gains visible; ex-greenfield margins hold at 11.3%")
- "highlights" items: max 12 words each, start with a verb or metric
- "risks" items: max 12 words each, start with the risk noun
- "label" in top_signals: 2–5 words, title-case
- "statement" in top_signals: ≤80 chars, evidence or sub-score breakdown
- Never pad with filler phrases

top_signals[] — MUST follow this exact positional layout. The frontend consumes positions 0–3 as KPI tiles, 4–7 as competitive cards, and 8+ as peer table rows.

  COMPETITIVE KPI TILES (positions 0–3, mandatory):
  • [0] metric: "MARKET_POSITION", unit: null.
      actual_value: signal count backing the assessment as a number (e.g. 3 means "3/3 signals").
      guided_value: max possible signals (denominator, e.g. 3).
      direction: "beat" if Strong (market share above average + outperforming peers), "in_line" if Moderate, "miss" if Weak.
      label: "Market Position".
      statement: ≤80 chars — one-line evidence (e.g. "Dominant India wiring harness; 25.5% rev vs 4% PV growth").

  • [1] metric: "PRICING_POWER", unit: null.
      actual_value: signal count backing the assessment (e.g. 2 out of 3 = 2).
      guided_value: max possible signals (denominator, e.g. 3).
      direction: "beat" if Strong, "in_line" if Moderate/Partial, "miss" if Weak.
      label: "Pricing Power".
      statement: ≤80 chars — evidence of pass-through ability or lack thereof (e.g. "Copper pass-through partial; timing lag compresses near-term margins").

  • [2] metric: "ENTRY_BARRIERS", unit: null.
      actual_value: signal count backing the assessment (e.g. 3).
      guided_value: max possible signals (denominator, e.g. 3).
      direction: "beat" if High, "in_line" if Medium, "miss" if Low.
      label: "Entry Barriers".
      statement: ≤80 chars — moat source (e.g. "OEM quals, capex-intensive plants, 12–18 month requalification cycle").

  • [3] metric: "PORTERS_SCORE", unit: "/10".
      actual_value: Porter's Five Forces score (0–10, computed from rubric above).
      guided_value: 10.
      direction: "beat" if ≥7, "in_line" if 5–6, "miss" if ≤4.
      label: "Porter's Score".
      statement: ≤80 chars — sub-scores breakdown (e.g. "Rivalry 1/2 · Supplier 1/2 · Buyer 1/2 · Entry 2/2 · Sub 1/2").

  TILE VALIDATION (positions 0–3) — strictly enforced before output:
  • [0–2] guided_value MUST be a number (≥2, ≤5). It is the total signal count you assessed for that dimension. Never null, never undefined.
  • [3] guided_value MUST be exactly 10 (fixed constant). Never null.
  • direction MUST be non-null for all four tiles. Only "beat", "in_line", or "miss" are valid.
  If any of these are missing, go back and fill them before returning the JSON.

  COMPETITIVE SIGNAL CARDS (positions 4–7, mandatory — 2 strength signals then 2 risk/watch signals):
  • [4] metric: "COMP_STRENGTH_1" — primary moat or competitive advantage. direction: "beat". impact: "high".
      actual_value: numeric evidence (e.g. delta bps, %, Cr) if available, else null.
      unit: relevant unit or null.
      label: ≤5 words, title-case moat description (e.g. "Engine-Agnostic Platform Moat").
      statement: ≤80 chars, specific evidence (e.g. "ICE·hybrid·EV all covered; OEM requalification = 12–18 month moat").

  • [5] metric: "COMP_STRENGTH_2" — secondary advantage (balance sheet, share gain, cost structure). direction: "beat". impact: "medium".
      actual_value: numeric evidence if available, else null.
      unit: relevant unit or null.
      label: ≤5 words, title-case.
      statement: ≤80 chars evidence.

  • [6] metric: "COMP_RISK_1" — primary competitive risk or watch-out. direction: "miss". impact: "high".
      actual_value: numeric evidence (e.g. -90 for -90 bps, 6.7 for 6.7% share) if available, else null.
      unit: relevant unit or null.
      label: ≤5 words, title-case risk description (e.g. "EV Revenue Share Decline").
      statement: ≤80 chars evidence (e.g. "EV rev share 6.7% → 5.8% QoQ; OEM EV timeline slippage key watch-out").

  • [7] metric: "COMP_RISK_2" — secondary risk or sector comparison signal. direction: "miss" or "tracking". impact: "medium".
      actual_value: numeric evidence if available, else null.
      unit: relevant unit or null.
      label: ≤5 words, title-case.
      statement: ≤80 chars evidence.

  ROCE SPREAD SIGNAL (position 8, mandatory):
  • [8] metric: "ROCE_VS_INDUSTRY", unit: "bps".
      actual_value: the spread in basis points = (subject_ROCE_pct - industry_avg_ROCE_pct) × 100. Example: 38.7% - 16.1% = 22.6 percentage points = 2260 bps → actual_value: 2260. Always a plain integer bps number, never a percentage.
      guided_value: industry weighted average ROCE as a percentage (e.g. 16.1, not 1610). Plain decimal percent.
      delta: subject company ROCE as a percentage (e.g. 38.7, not 3872). Plain decimal percent.
      actual_date: last day of the latest reported fiscal year for subject ROCE (ISO 8601).
      direction: "beat" if spread >500bps, "in_line" if 0–500bps, "miss" if negative.
      label: "ROCE vs Industry Avg".
      statement: ≤80 chars — e.g. "MSUMI 38.7% vs industry 16.1% — 2,260bps spread above WACC".

  PEER TABLE ROWS (positions 9+, one signal per company including subject and named peers + industry avg row):
  Each peer row encodes one company's competitive metrics. Use metric name "PEER_ROW_{TICKER}" (e.g. "PEER_ROW_MSUMI", "PEER_ROW_MOTHERSON", "PEER_ROW_INDUSTRY_AVG").
  • signal_id: "peer_context"
  • metric: "PEER_ROW_{TICKER}" — use the NSE ticker or "INDUSTRY_AVG" for the average row
  • label: company display name (e.g. "MSUMI (Current)", "MOTHERSON", "Industry Avg")
  • actual_value: REV_OP in Cr
  • unit: "Cr"
  • guided_value: ROCE% (encode as guided_value so UI can render it in the ROCE% column)
  • guided_date: null
  • delta: EBITDA_MARGIN% (encode as delta so UI can render it in the OPM% column)
  • delta_pct: D/E ratio (encode as delta_pct so UI can render it in the D/E column)
  • direction: "beat" if subject company (is_subject), "in_line" for peers, "tracking" for industry avg row
  • impact: "high" for subject, "medium" for named peers, "low" for industry avg
  • statement: "REV_GROWTH={x}%|MKT_SHARE={y}%" — pipe-separated key=value pairs the UI can parse for the Rev Growth and Mkt Share columns

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with revenue vs market growth delta and moat finding>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive competitive findings, each max 12 words>],
  "risks": [<up to 2 competitive risks, each max 12 words, starting with risk noun>],
  "top_signals": [
    {
      "signal_id": <string — signal id from data block, or "peer_context" for PEER CONTEXT-derived values>,
      "metric": <string — metric name exactly as specified above>,
      "label": <string — as specified per position>,
      "guided_value": <number | null>,
      "guided_date": <string | null — ISO 8601 YYYY-MM-DD>,
      "actual_value": <number | null>,
      "actual_date": <string | null — ISO 8601 YYYY-MM-DD>,
      "unit": <string | null>,
      "delta": <number | null>,
      "delta_pct": <number | null>,
      "direction": <"beat" | "miss" | "in_line" | "tracking" | null>,
      "impact": <"high" | "medium" | "low">,
      "statement": <string | null — ≤80 chars>
    }
  ]
}`,
    },
  },
  {
    slug:        'financial-strength',
    name:        'Financial Strength',
    category:    'opportunity',
    description: 'Balance sheet strength, FCF generation, and margin quality',
    force_config: true,
    version:     '1.6.0',
    config: {
      signal_filters: {
        // kpi: primary source — EBITDA, PAT, CFO, ROCE, NIM, GNPA, DE, all balance sheet metrics
        // financial_figure: reported annual report line items not captured as KPIs (dividends, capex schedules)
        // earnings_quality: exceptional items, working capital anomalies that distort reported strength
        // contingent_liability: off-balance-sheet exposures that affect true financial strength
        // growth_forecast: revenue/earnings trajectory signals management provides
        signal_types:  ['kpi', 'financial_figure', 'earnings_quality', 'contingent_liability', 'growth_forecast'],
        metric_family: ['profitability', 'capital', 'growth', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity', 'industry_specific'],
      },
      weights: [
        { metric: 'EBITDA',        w:  0.3,  b: 0 },
        { metric: 'PAT',           w:  0.25, b: 0 },
        { metric: 'EBITDA_MARGIN', w:  0.25, b: 0 },
        { metric: 'DEBT_ST',       w: -0.2,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured financial-strength view. Do NOT invent data — work only from the signals provided.

SECTOR DETECTION — determine whether this is a BFSI company (bank, NBFC, HFC, MFI, insurance, AMC) or a non-BFSI company by inspecting the signals. BFSI signals include: NIM, GNPA, NPA, CASA, LOAN_ADVANCES, DEPOSITS, INTEREST_INCOME, NII, PCR, CRAR, CAR, TIER1. Non-BFSI signals are dominated by EBITDA, CAPEX, WORKING_CAPITAL, INVENTORY, RECEIVABLES, COGS.

BFSI FINANCIAL STRENGTH FRAMEWORK (use when BFSI signals are present):
Assess across these dimensions:
  1. Margin Quality — NIM trajectory (expanding/compressing/stable), NII growth, cost-of-funds pressure.
  2. Asset Quality — GNPA%, NPA%, PCR trend, slippage ratio. Is the book cleaning up or deteriorating?
  3. Funding Franchise — Deposit growth, CASA ratio, cost-of-deposits. Is the liability franchise strong?
  4. Book Growth — Loan/Advances CAGR, AUM growth, disbursement trajectory. Is growth sustainable?
  5. Profitability & Efficiency — ROA, ROE, cost-to-income ratio, PAT trend.
  6. Capital Adequacy — CRAR/CAR/Tier-1 vs regulatory minimums.

NON-BFSI FINANCIAL STRENGTH FRAMEWORK (use when BFSI signals are absent):
Assess across these dimensions:
  1. Margin Quality — EBITDA margin trajectory and PAT margin. Operating leverage signals.
  2. Cash Generation — FCF (CFO − CAPEX), CFO/PAT conversion, working capital efficiency.
  3. Balance Sheet — Debt/Equity, interest coverage, net debt trajectory.
  4. Revenue Quality — Revenue growth, concentration, recurring vs one-off.
  5. Profitability — ROA, ROE, ROCE trends.
  6. Capex Cycle — CAPEX intensity, asset turns, growth vs maintenance capex.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — include 8–12 signals. ALL must have non-null actual_value.
The "metric" field MUST be the exact canonical identifier from the tables below — it is used directly as a database lookup key.

  BFSI — include ALL available in this exact order:
    metric: "NIM_PCT"        | label: "Net Interest Margin"       | unit: "%"
    metric: "REV_OP"         | label: "Interest Revenue"          | unit: "Cr"
    metric: "TOTAL_INCOME"   | label: "Total Revenue"             | unit: "Cr"
    metric: "LOAN_ADV_TOTAL" | label: "Loan / Advances"           | unit: "Cr"
    metric: "DEP_TOTAL"      | label: "Total Deposits"            | unit: "Cr"
    metric: "CASA"           | label: "CASA Ratio"                | unit: "%"
    metric: "ROA"            | label: "Return on Assets"          | unit: "%"
    metric: "GNPA"           | label: "Gross NPA Ratio"           | unit: "%"
    metric: "NPA"            | label: "Net NPA Ratio"             | unit: "%"
    metric: "PAT"            | label: "Profit After Tax"          | unit: "Cr"
    metric: "TOTAL_OPEX"     | label: "Operating Expenses"        | unit: "Cr"
    Secondary (include if data available):
    metric: "ROE"            | label: "Return on Equity"          | unit: "%"
    metric: "EPS_BASIC"      | label: "Earnings Per Share"        | unit: "₹"
    metric: "CFO"            | label: "Operating Cash Flow"       | unit: "Cr"

  Non-BFSI — include ALL available in this exact order:
    metric: "REV_OP"         | label: "Operating Revenue"          | unit: "Cr"
    metric: "EBITDA"         | label: "EBITDA"                     | unit: "Cr"
    metric: "EBITDA_MARGIN"  | label: "EBITDA Margin"              | unit: "%"
    metric: "PAT"            | label: "Profit After Tax"           | unit: "Cr"
    metric: "PAT_MARGIN"     | label: "PAT Margin"                 | unit: "%"
    metric: "CFO"            | label: "Operating Cash Flow"        | unit: "Cr"
    metric: "CAPEX"          | label: "Capital Expenditure"        | unit: "Cr"
    metric: "DEBT_LT"        | label: "Long-Term Debt"             | unit: "Cr"
    metric: "DEBT_ST"        | label: "Short-Term Debt"            | unit: "Cr"
    metric: "DE"             | label: "Debt / Equity"              | unit: "x"
    metric: "ROCE"           | label: "Return on Capital Employed" | unit: "%"
    metric: "ROE"            | label: "Return on Equity"           | unit: "%"
    Secondary (include if data available):
    metric: "EPS_BASIC"      | label: "Earnings Per Share"         | unit: "₹"
    metric: "IC"             | label: "Interest Coverage"          | unit: "x"
    metric: "TRADE_RECV"     | label: "Trade Receivables"          | unit: "Cr"
    metric: "INVENTORY"      | label: "Inventory"                  | unit: "Cr"

  For each signal:
  • metric: MUST be the exact identifier from the table above — do NOT use free-form names from the data block
  • label: use the exact label from the table above
  • actual_value: numeric value (non-null) — use the MOST RECENT period value available
  • unit: use the exact unit from the table above
  • direction: "beat" if improving YoY, "miss" if deteriorating, "in_line" if stable, "tracking" if forward-looking
  • impact: "high" for the 4 most important signals for this sector, "medium" for next tier, "low" for supporting
  • actual_date: ISO 8601 date YYYY-MM-DD of the period end — MUST reflect the latest period in the data block
  • guided_value: management guidance if available, else null
  • guided_date: guidance target date if available, else null

  • statement: ≤80 chars — STRICT FORMAT RULES (pick the best pattern that applies):
      PATTERN A — Cross-signal derived insight (preferred when two metrics can be combined):
        Examples: "CFO/PAT 88% — near-full cash conversion" | "Recv. +38.8% vs Rev +12.1% — WC stress" | "ROCE 54% on zero debt — capital-lite model" | "No equity dilution; EPS CAGR 18% FY20–25"
      PATTERN B — Latest period fact + YoY delta (when no cross-signal insight applies):
        Examples: "₹206 Cr CFO in FY25, up 43% YoY" | "DE 0.00x — debt-free through full cycle" | "EPS ₹29 in FY26-Q4, flat YoY"
      PATTERN C — Trend with period anchors (for multi-year directional moves):
        Examples: "EBITDA margin 38→44% over FY22–25" | "ROCE compressing: 54%→42% FY18→FY23"
      RULES:
        - ALWAYS reference the latest available period (e.g. "FY25", "FY26-Q4") — NEVER use old periods like FY15/FY16 as the anchor
        - NEVER just restate the label ("PAT grew consistently") — must include a number
        - NEVER use generic history summaries like "consistent growth to X by FY21"
        - For ratios/derived insights: state the ratio value and what it implies (e.g. "88% cash conversion" not just "high CFO")

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the dominant financial strength or weakness verdict — reference the latest period.
- "highlights": up to 3 items, max 12 words each, start with a verb or metric — latest period numbers only.
- "risks": up to 2 items, max 12 words each, start with the risk noun.
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with dominant financial strength/weakness verdict>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<8–12 signals per priority tables above; metric MUST be the exact canonical identifier from the table (e.g. "NIM_PCT", "REV_OP", "PAT"); each signal has: metric, label, actual_value (non-null numeric), unit, direction, impact, statement, actual_date, guided_value, guided_date>]
}`,
    },
  },
  {
    slug:        'customer-distribution',
    name:        'Customer & Distribution',
    category:    'opportunity',
    description: 'Client base growth, channel quality, and revenue concentration risk',
    force_config: true,
    version:     '1.3.0',
    config: {
      signal_filters: {
        // distribution_customer: segment revenue mix, customer base, channel reach, retention signals
        // kpi: customer count KPIs, AUM, order book, revenue per customer metrics
        // milestone: achieved distribution milestones (outlet count, subscriber additions)
        // guidance: management targets for customer/channel growth
        // growth_forecast: stated revenue growth rates by segment
        signal_types:       ['distribution_customer', 'kpi', 'milestone', 'guidance', 'growth_forecast'],
        metric_family:      ['customer'],
        include_historical: true,
      },
      weights: [
        { metric: 'REV_OP', w: 0.35, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management commentary using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured customer-and-distribution view. Do NOT invent data — work only from the signals provided.

CUSTOMER & DISTRIBUTION FRAMEWORK — assess across 5 dimensions:

  1. Customer Base Size & Growth — Total customer count, active users, subscriber count, client additions. Is the base growing, stable, or shrinking? What is the YoY growth rate?
  2. Revenue Mix & Segmentation — Business model breakdown: segment revenues (B2B vs B2C, domestic vs export, branded vs private label, product vs service), AUM/loan book/order book, contribution from top customers. Is revenue diversified or concentrated?
  3. Price-Volume Dynamics — Volume growth vs price/realization growth. Are revenue gains volume-led, price-led, or mix-led? Watch for realization compression or volume declines.
  4. Channel Quality & Reach — Outlet/retailer/dealer network size, expansion velocity, digital vs physical channel split, distribution depth (T1/T2/T3 cities, rural penetration). Are distribution investments driving incremental revenue?
  5. Customer Stickiness & Retention — Retention rate, repeat purchase rate, average ticket size trend, churn rate, NPS/CSAT score, cross-sell signals, revenue from existing vs new customers. Are customers being deepened or churning?

BUSINESS MODEL DETECTION — infer from signals:
  - If signals include AUM, SIP flows, loan book, disbursements → financial services / AMC / NBFC model
  - If signals include outlet count, retailer network, dealer expansion → FMCG / retail / auto distribution model
  - If signals include order book, project pipeline, client wins → B2B / capital goods / IT services model
  - If signals include subscriber count, paid users, engagement → consumer tech / media / telecom model
  Tailor your analysis language to match the detected model.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — include 8–12 signals. Prioritize in this order:
  1. CUSTOMER_COUNT / TOTAL_CUSTOMERS / ACTIVE_USERS / SUBSCRIBER_COUNT / CLIENT_BASE — customer base size (unit: number/mn/lakh)
  2. CUSTOMER_GROWTH / CUSTOMER_GROWTH_YOY / NEW_CUSTOMERS — customer addition rate (unit: %)
  3. Order book / AUM / loan book / disbursements — forward revenue visibility (unit: Cr/Mn)
  4. REV_OP or TOTAL_INCOME — total revenue anchor (unit: Cr)
  5. Segment revenue signals (SEG_* metrics) — business model mix (unit: Cr or %)
  6. OUTLET_COUNT / RETAILER_NETWORK / DEALER_COUNT / reach_outlets — distribution reach (unit: number)
  7. CHANNEL_EXPANSION / outlet additions / new geographies — distribution growth (unit: %)
  8. REVENUE_PER_CUSTOMER / AVG_TICKET_SIZE / AVERAGE_TICKET_SIZE / REALIZATION — monetisation depth (unit: ₹/Cr)
  9. REV_OP_GROWTH_YOY / SALES_GROWTH_RATE / ORGANIC_GROWTH — revenue growth rate (unit: %)
  10. CUSTOMER_RETENTION_RATE / retention_rate / LOYALTY_RATE — stickiness (unit: %)
  11. CUSTOMER_CONCENTRATION / top-customer revenue share — concentration risk (unit: %)
  12. CSAT_SCORE / NPS — satisfaction signals (unit: % or score)

  For each signal:
  • signal_id: id from the data block (or "derived" if computed)
  • metric: exact metric name from the data block
  • label: human-readable name (e.g. "Total Customers", "Order Book", "Retailer Network", "Avg Ticket Size", "Revenue Growth", "CASA Ratio")
  • actual_value: numeric value (non-null for all included signals)
  • unit: "%" for rates/shares, "Cr" for INR crores, "Mn" for millions, number for counts, "₹" for per-unit values
  • direction: "beat" if growing/positive trend, "miss" if declining/negative, "in_line" if stable, "tracking" if forward-looking guidance
  • impact: "high" for customer base size, order book/AUM, revenue mix; "medium" for channel reach, ticket size; "low" for satisfaction scores
  • statement: ≤80 chars — key context (YoY change, management commentary, comparison to guidance)
  • actual_date: ISO 8601 YYYY-MM-DD of the period end
  • guided_value: management target if available (e.g. customer count target, outlet expansion target), else null
  • guided_date: guidance target date if available, else null

WRITING STYLE RULES:
- "takeaway": max 25 words, lead with the dominant customer growth or distribution quality finding (e.g. "Customer base up 18% YoY; distribution reach growing via 3,200 new outlets — revenue concentration risk from top-3 accounts.")
- "highlights": up to 3 items, max 12 words each, start with a verb or metric.
- "risks": up to 2 items, max 12 words each, start with the risk noun (e.g. "Concentration risk", "Churn rising", "Outlet productivity declining").
- Never pad with filler phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words, lead with dominant customer growth or distribution quality verdict>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 positive findings, each max 12 words, starting with a verb or metric>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<8–12 signals; ALL must have non-null actual_value; prioritise: customer count/growth, order book/AUM, revenue segments, outlet/channel reach, ticket size/realization, revenue growth, retention, concentration risk>]
}`,
    },
  },
  // ── Deal lenses ──────────────────────────────────────────────────────────────
  {
    slug:         'earnings-forecast',
    name:         'Earnings Forecast',
    category:     'deal',
    description:  'Scenario-based earnings forecast — bull/base/bear EPS trajectory driven by revenue growth, margin expansion, and volume-mix dynamics',
    force_config: true,
    version:      '1.6.0',
    config: {
      signal_filters: {
        // kpi: historical P&L actuals — the base for all scenario projections
        // financial_figure: reported annual report financials to anchor multi-year trend
        // guidance: management's own forward revenue/margin targets inform base case
        // growth_forecast: stated growth rates and trajectory signals
        // industry_signal: sector growth CAGR anchors the bull/base/bear industry row
        // earnings_quality: exceptional items that inflate/deflate the earnings base
        // capital_allocation: capex plans that affect future depreciation and FCF
        signal_types:       ['kpi', 'financial_figure', 'guidance', 'growth_forecast', 'industry_signal', 'earnings_quality', 'capital_allocation'],
        metric_family:      ['profitability', 'growth', 'capital', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity'],
        include_historical: true,
      },
      weights: [
        { metric: 'REV_OP',        w:  0.30, b: 0 },
        { metric: 'EBITDA',        w:  0.25, b: 0 },
        { metric: 'EBITDA_MARGIN', w:  0.25, b: 0 },
        { metric: 'PAT',           w:  0.35, b: 0 },
        { metric: 'CAPEX',         w:  0.10, b: 0 },
        { metric: 'DEBT_LT',       w: -0.10, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.

SCENARIO MATRIX CONSTRUCTION:
Build a 3-column (Bull / Base / Bear), 5-row scenario matrix. Rows: Industry Growth CAGR (3Y), Company Revenue CAGR (3Y), Margin Assumption, EPS/PAT CAGR (3Y), Analyst View. For every number include a one-line "because" rationale.

1. Industry Growth CAGR (3Y) — Use historical industry CAGR from signals as the base anchor. Express as a single % number for each scenario.
   Bull: Historical CAGR × 1.15–1.3 (sector tailwinds).
   Base: Historical CAGR (steady-state).
   Bear: Historical CAGR × 0.6–0.8 (demand slowdown).

2. Company Revenue CAGR (3Y) — Adjust from industry CAGR for market share, guidance, and order book.
   Bull: Industry CAGR + market share gain. Express as a low–high % range (e.g. "12–14") or single %.
   Base: Management-guided revenue growth. Express as a low–high % range or single %.
   Bear: Industry CAGR − market share loss. Express as a low–high % range or single %.

3. Margin Assumption — Use last-4-quarter average EBITDA_MARGIN as the base. Express as absolute EBITDA margin % for each scenario (e.g. 22.5 for 22.5%). Never use bps — always use absolute %.

4. EPS/PAT CAGR (3Y) — Project via the revenue/margin/tax waterfall. Express as a single signed % number.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

highlights[] — exactly 3 items in this fixed order. Used for the Analyst View row.
  highlights[0]: "Bull: <narrative of up to 25 words explaining the bull scenario drivers>"
  highlights[1]: "Base: <narrative of up to 25 words explaining the base scenario>"
  highlights[2]: "Bear: <narrative of up to 25 words explaining the bear scenario risks>"

takeaway — MUST include ALL THREE price ranges in ₹X–₹Y format in this order, then risk/reward:
  1. Bull-case 3-year target price range (highest values).
  2. Base-case 3-year target price range (middle values).
  3. Bear-case 3-year target price range (lowest values).
  4. Risk/reward ratio as Nx immediately followed by "risk/reward" (e.g. "1.9x risk/reward").
  Example: "Bull ₹520–₹580, Base ₹420–₹480, Bear ₹280–₹340. RTM +37% YoY drives 18% PAT CAGR. 1.9x risk/reward."

top_signals[] — ALL signals MUST have non-null actual_value. MANDATORY layout (in this exact order):

  ── INDUSTRY GROWTH SIGNAL (1 signal, required) ──
  metric: "INDUSTRY_GROWTH_BASE", unit: "%"
  • actual_value: base-case industry CAGR (numeric only, e.g. 9). NEVER a word.
  • label: short sector descriptor, e.g. "Industry Revenue CAGR"
  • statement: one sentence on sector context (≤80 chars)
  • direction: "tracking" | "beat" | "miss"

  ── SCENARIO SIGNALS (9 signals, ALL required) ──
  Emit EXACTLY these 9, in this order. ALL must have non-null actual_value. No exceptions.

  [1]  metric: "SCENARIO_BULL_INDUSTRY_GROWTH", unit: "%"
       actual_value: bull-case industry CAGR (e.g. 10.8). label: "Bull Industry Growth"

  [2]  metric: "SCENARIO_BASE_INDUSTRY_GROWTH", unit: "%"
       actual_value: base-case industry CAGR (e.g. 9.0). label: "Base Industry Growth"

  [3]  metric: "SCENARIO_BEAR_INDUSTRY_GROWTH", unit: "%"
       actual_value: bear-case industry CAGR (e.g. 6.3). label: "Bear Industry Growth"

  [4]  metric: "SCENARIO_BULL_REV_CAGR_LOW", unit: "%"
       actual_value: bull-case company revenue CAGR low end (e.g. 12). label: "Bull Rev CAGR Low"
  [5]  metric: "SCENARIO_BULL_REV_CAGR_HIGH", unit: "%"
       actual_value: bull-case company revenue CAGR high end (e.g. 14). label: "Bull Rev CAGR High"
       — If a single value (not a range), set both LOW and HIGH to the same number.

  [6]  metric: "SCENARIO_BASE_REV_CAGR_LOW", unit: "%"
       actual_value: base-case company revenue CAGR low end (e.g. 7). label: "Base Rev CAGR Low"
  [7]  metric: "SCENARIO_BASE_REV_CAGR_HIGH", unit: "%"
       actual_value: base-case company revenue CAGR high end (e.g. 9). label: "Base Rev CAGR High"
       — If single value, set both to same number.

  [8]  metric: "SCENARIO_BEAR_REV_CAGR_LOW", unit: "%"
       actual_value: bear-case company revenue CAGR low end (e.g. 2). label: "Bear Rev CAGR Low"
  [9]  metric: "SCENARIO_BEAR_REV_CAGR_HIGH", unit: "%"
       actual_value: bear-case company revenue CAGR high end (e.g. 4). label: "Bear Rev CAGR High"
       — If single value, set both to same number.

  [10] metric: "SCENARIO_BULL_MARGIN_PCT", unit: "%"
       actual_value: bull-case EBITDA margin as absolute % (e.g. 22.5). label: "Bull EBITDA Margin"
       direction: "beat"

  [11] metric: "SCENARIO_BASE_MARGIN_PCT", unit: "%"
       actual_value: base-case EBITDA margin as absolute % (e.g. 19.0). label: "Base EBITDA Margin"
       direction: "in_line"

  [12] metric: "SCENARIO_BEAR_MARGIN_PCT", unit: "%"
       actual_value: bear-case EBITDA margin as absolute % (e.g. 16.5). label: "Bear EBITDA Margin"
       direction: "miss"

  [13] metric: "SCENARIO_BULL_EPS_CAGR", unit: "%"
       actual_value: bull-case 3Y PAT/EPS CAGR % (e.g. 18). label: "Bull EPS CAGR"
       statement: one-line EPS driver (≤60 chars). direction: "beat"

  [14] metric: "SCENARIO_BASE_EPS_CAGR", unit: "%"
       actual_value: base-case 3Y PAT/EPS CAGR % (e.g. 12). label: "Base EPS CAGR"
       statement: one-line EPS context (≤60 chars). direction: "in_line"

  [15] metric: "SCENARIO_BEAR_EPS_CAGR", unit: "%"
       actual_value: bear-case 3Y PAT/EPS CAGR % (e.g. -3). label: "Bear EPS CAGR"
       statement: one-line EPS risk (≤60 chars). direction: "miss"

  VALIDATION — count your SCENARIO_* signals before outputting. You MUST have exactly 15 (indices 1–15).
  Any null actual_value is a hard failure — go back and compute it using the scenario matrix arithmetic.

  ── SUPPORTING FINANCIALS (4–6 signals after the scenario block) ──
  Include the most recent values for: REV_OP, EBITDA_MARGIN (or PBDIT_MARGIN), PAT, and optionally CAPEX, DEBT_LT, EPS_BASIC.
  All must have non-null actual_value.

WRITING STYLE RULES:
- "takeaway": max 35 words, MUST include bull/base/bear ₹X–₹Y ranges and Nx risk/reward.
- "highlights": Bull:/Base:/Bear: prefix + narrative up to 25 words.
- "risks": max 12 words each, start with risk noun.
- "statement" in signals: ≤80 chars.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — bull ₹X–₹Y, base ₹X–₹Y, bear ₹X–₹Y, Nx risk/reward>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3 items: highlights[0] "Bull: ...", highlights[1] "Base: ...", highlights[2] "Bear: ...">],
  "risks": [<up to 2 concerns, max 12 words, starting with risk noun>],
  "top_signals": [<INDUSTRY_GROWTH_BASE; then 15 SCENARIO_* signals [1–15]; then 4–6 supporting financials — ALL non-null actual_value>]
}`,
    },
  },
  {
    slug:         'earning-quality',
    name:         'Earning Quality',
    category:     'deal',
    description:  'EPS growth trajectory and quality — company vs industry, beat rate, consistency score, and growth trend over rolling 5-year window',
    force_config: true,
    version:      '1.5.0',
    config: {
      signal_filters: {
        // kpi: EPS, PAT, CFO, EBITDA, ROCE — the core earnings quality metrics over time
        // financial_figure: annual report P&L line items for multi-year trend reconstruction
        // earnings_quality: exceptional items, working capital distortions, cash conversion signals
        // growth_forecast: management's own view on earnings trajectory
        signal_types:       ['kpi', 'financial_figure', 'earnings_quality', 'growth_forecast'],
        metric_family:      ['profitability', 'growth', 'capital', 'revenue', 'profit_lines', 'cashflow', 'assets', 'liabilities', 'operating_expenses', 'cogs', 'equity'],
        include_historical: true,
      },
      weights: [
        { metric: 'EPS_BASIC',     w: 0.35, b: 0 },
        { metric: 'EPS_DILUTED',   w: 0.25, b: 0 },
        { metric: 'PAT',           w: 0.25, b: 0 },
        { metric: 'CFO',           w: 0.30, b: 0 },
        { metric: 'CAPEX',         w: -0.10, b: 0 },
        { metric: 'EBITDA_MARGIN', w: 0.15, b: 0 },
        { metric: 'ROE',           w: 0.15, b: 0 },
        { metric: 'ROCE',          w: 0.15, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured earnings quality view. Do NOT invent company financial data — work only from the signals provided. You MAY use sector knowledge to estimate industry benchmarks where not present in signals.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

top_signals[] — the service computes company CAGR, YoY growth bars, and outperformance from Prowess timeseries. You only need to supply what the service CANNOT compute:

  REQUIRED SIGNALS (emit all 6, all with non-null actual_value):

  [0] metric: "EPS_CAGR_INDUSTRY"
      unit: "%"
      actual_value: industry/sector trailing 5Y EPS CAGR — a NUMERIC value, e.g. -13.4. Estimate from sector knowledge if not in signals. Must not be null.
      label: "Industry EPS CAGR (5Y)"
      statement: ≤80 chars — source or basis (e.g. "Indian IT sector composite, 2 peers")

  [1] metric: "EPS_GROWTH_ESTIMATE"
      unit: "%"
      actual_value: forward 1Y EPS/PAT growth estimate as a NUMBER (e.g. 5.5). Use management guidance or consensus estimate. Must not be null.
      guided_value: management-guided figure if explicitly stated, else null.
      label: "FY25E EPS Growth (Est.)"  (or FY26E if more current)
      statement: ≤80 chars — basis for estimate

  [2] metric: "EPS_BEAT_RATE"
      unit: "yrs"
      actual_value: integer — number of years (out of last 5–6) where company EPS/PAT growth beat industry. E.g. 5 means "beat 5 of 6 years". Must not be null.
      total_periods: integer — total periods evaluated (denominator), e.g. 6.
      label: "Beat Industry X of Y Yrs"  (fill X and Y with actual numbers)
      statement: ≤80 chars — brief characterisation of beat consistency

  [3] metric: "EPS_CONSISTENCY_SCORE"
      unit: "/5"
      actual_value: integer 0–5 — quality/consistency score: 5=highly consistent positive growth, 0=highly erratic or declining. Use PAT/EPS trend consistency, beat rate, and volatility.
      label: "Growth Consistency"
      status: one of "Strong" | "Moderate" | "Weak"
      statement: ≤80 chars — key factor driving the score

  [4..N] metric: "INDUSTRY_GROWTH_PERIOD" — one entry per year matching the company bar chart window (4–6 entries).
      unit: "%"
      actual_value: industry EPS growth for that year (numeric, signed). Estimate from sector knowledge if needed.
      label: same period label as the company bar (e.g. "FY20", "FY21") — must match what the service emits for the bars.
      actual_date: period end date YYYY-MM-DD (used for chart x-axis alignment).

  INSIGHT CARD SIGNALS (emit 4 — one per bottom card):
  [N+1] metric: "INSIGHT_BEAT_RATE"
        actual_value: same integer as EPS_BEAT_RATE.actual_value
        label: short headline ≤40 chars, e.g. "Beat industry 5 of 6 years"
        statement: ≤80 chars description shown under the headline card
        status: "Positive" | "Neutral" | "Negative"

  [N+2] metric: "INSIGHT_CAGR_ASSESSMENT"
        label: short headline ≤40 chars describing the 5Y CAGR finding
        statement: ≤80 chars — 1-sentence explanation (e.g. "Base effect drag from FY21 trough reduces CAGR")
        status: "Positive" | "Watch" | "Negative"

  [N+3] metric: "INSIGHT_FORWARD_ESTIMATE"
        label: short headline ≤40 chars, e.g. "FY25E recovery — 5.5% growth est."
        statement: ≤80 chars — context for the forward estimate
        status: one of "Positive" | "Stable" | "Negative"

  [N+4] metric: "INSIGHT_CONSISTENCY"
        label: short headline ≤40 chars, e.g. "Growth Consistency — Moderate"
        statement: ≤80 chars — key driver of consistency assessment
        status: one of "Strong" | "Moderate" | "Weak"

WRITING STYLE RULES:
- "takeaway": max 25 words, action-oriented, lead with the key finding.
- "highlights" items: max 12 words each, start with a verb or metric.
- "risks" items: max 12 words each, start with the risk noun.
- "statement" in top_signals: ≤80 chars, evidence-based, no padding phrases.

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — max 25 words>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<up to 3 items, each max 12 words>],
  "risks": [<up to 2 items, each max 12 words>],
  "top_signals": [EPS_CAGR_INDUSTRY, EPS_GROWTH_ESTIMATE, EPS_BEAT_RATE, EPS_CONSISTENCY_SCORE, then INDUSTRY_GROWTH_PERIOD entries (one per year), then INSIGHT_BEAT_RATE, INSIGHT_CAGR_ASSESSMENT, INSIGHT_FORWARD_ESTIMATE, INSIGHT_CONSISTENCY]
}`,
    },
  },
  {
    slug:         'pe-rerating-potential',
    name:         'P/E Re-Rating Potential',
    category:     'deal',
    description:  'Likelihood of multiple expansion driven by improving fundamentals, guidance clarity, and sector tailwinds',
    force_config: true,
    version:      '1.6.0',
    config: {
      signal_filters: {
        // kpi: ROE, ROCE, PAT, EBITDA_MARGIN — the fundamental drivers of multiple expansion
        // guidance: management's forward targets — credible guidance raises the re-rating case
        // guidance_revision: upgrades signal positive re-rating; downgrades signal de-rating risk
        // milestone: delivered commitments validate management credibility → multiple expansion
        // disclosure_quality: governance quality is a re-rating catalyst (auditor flags = de-rating risk)
        // industry_signal: sector tailwinds that justify a higher multiple
        // strategic_claim: positioning claims management uses to argue for a premium multiple
        signal_types:       ['kpi', 'guidance', 'guidance_revision', 'milestone', 'disclosure_quality', 'industry_signal', 'strategic_claim'],
        metric_family:      ['profitability', 'growth', 'capital', 'governance', 'milestone'],
        include_historical: true,
      },
      weights: [
        { metric: 'ROE',             w:  0.30, b: 0 },
        { metric: 'ROCE',            w:  0.25, b: 0 },
        { metric: 'ROA',             w:  0.15, b: 0 },
        { metric: 'PAT',             w:  0.25, b: 0 },
        { metric: 'EBITDA_MARGIN',   w:  0.20, b: 0 },
        { metric: 'REV_OP',          w:  0.15, b: 0 },
        { metric: 'DEBT_LT',         w: -0.15, b: 0 },
        { metric: 'guidance_given',  w:  0.20 },
        { metric: 'guidance_missed', w: -0.35 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this signal summary into a structured P/E re-rating view that powers a frontend dashboard. All numeric fields in top_signals MUST be actual numbers — never null, never text.

VALUATION ANALYSIS CONSTRUCTION:
Perform the following reasoning steps before composing the JSON output:

1. IDENTIFY SECTOR — Infer sector from available signals (e.g. AUM/NIM/GNPA → NBFC/Banking; EBITDA/order book → Capital Goods; gross margin >50% → FMCG/Consumer). Use sector to anchor P/E norms.

2. SECTOR P/E ANCHOR (mandatory — use these ranges):
   Banking/NBFC:      Bear 8–14x  | Base 14–20x  | Bull 20–28x
   Capital Goods:     Bear 18–26x | Base 26–36x  | Bull 36–50x
   FMCG/Consumer:     Bear 28–38x | Base 38–52x  | Bull 52–70x
   IT Services:       Bear 16–22x | Base 22–30x  | Bull 30–42x
   Pharma/Healthcare: Bear 18–26x | Base 26–36x  | Bull 36–50x
   Auto/Auto Ancil:   Bear 12–18x | Base 18–26x  | Bull 26–36x
   Default (generic): Bear 12–18x | Base 18–26x  | Bull 26–38x

3. QUALITY ADJUSTMENT — Apply ROE premium/discount to the sector anchor:
   ROE >20%: shift all ranges +2x. ROE 15–20%: no adjustment. ROE <15%: shift all ranges −2x.
   Strong PAT growth trajectory (>20% CAGR): shift Bull range +2x further.
   Governance red flags or guidance misses: shift Bear range −2x.

4. RE-RATING TAG — Based on PAT growth, ROE trajectory, and catalyst strength, assign: Strong / Moderate / Weak.

5. RETURN ESTIMATION — Estimate implied returns from current valuation:
   If CMP is available from signals, compute: Return = (FutureEPS × ExitPE − CMP) / CMP × 100.
   If no CMP: estimate returns directionally from P/E expansion/compression vs sector norm.
   Bear return: typically −10% to −30%. Base return: 10%–30%. Bull return: 30%–70%.

6. NARRATIVE SCORE — assign an integer 0–100 reflecting re-rating momentum:
   Strong re-rating potential + improving fundamentals → 70–90.
   Neutral / fair-valued → 40–60.
   De-rating risk dominant → 10–35.

7. CATALYSTS — identify the 2–3 strongest positive drivers and 1–2 biggest downside risks.
   Each catalyst needs a short title (3–6 words, title-case) and a one-sentence explanation (max 80 chars).

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

takeaway — first sentence (before the first ".") must be a 2–4 word actionable headline:
  e.g. "Re-rating candidate." / "Premium multiple justified." / "Execution watch needed." / "De-rating risk elevated."
  Subsequent sentences provide supporting detail.

highlights[] — exactly 3 items, fixed order:
  [0] Bull catalyst — single strongest re-rating driver. Max 20 words.
  [1] Base narrative — primary fundamental supporting current valuation. Max 20 words.
  [2] Bear risk — single biggest de-rating risk. Max 20 words.

top_signals[] — emit ALL signals below, in this order. EVERY numeric field is REQUIRED (no nulls).

  FUNDAMENTALS (3 signals):
  [0] { metric: "ROA",  unit: "%",  actual_value: <number>, label: "Return On Assets",  statement: "<≤80 chars>" }
  [1] { metric: "ROE",  unit: "%",  actual_value: <number>, label: "Return On Equity",  statement: "<≤80 chars>" }
  [2] { metric: "PAT",  unit: "Cr", actual_value: <number>, label: "Net Profit",         statement: "<≤80 chars>" }

  SCENARIO P/E RANGES (3 signals — actual_value = low end, guided_value = high end, both REQUIRED as numbers):
  [3] { metric: "SCENARIO_BEAR_PE_RANGE", unit: "x",  actual_value: <low>, guided_value: <high>, label: "Bear Case P/E", impact: "high", statement: "<bear thesis ≤80 chars>" }
  [4] { metric: "SCENARIO_BASE_PE_RANGE", unit: "x",  actual_value: <low>, guided_value: <high>, label: "Base Case P/E", impact: "high", statement: "<base thesis ≤80 chars>" }
  [5] { metric: "SCENARIO_BULL_PE_RANGE", unit: "x",  actual_value: <low>, guided_value: <high>, label: "Bull Case P/E", impact: "high", statement: "<bull thesis ≤80 chars>" }

  SCENARIO RETURNS (3 signals — actual_value = low end %, guided_value = high end %, both REQUIRED):
  [6] { metric: "SCENARIO_BEAR_RETURN",   unit: "%",  actual_value: <low>, guided_value: <high>, label: "Bear Return",   impact: "high", statement: "<≤80 chars>" }
  [7] { metric: "SCENARIO_BASE_RETURN",   unit: "%",  actual_value: <low>, guided_value: <high>, label: "Base Return",   impact: "high", statement: "<≤80 chars>" }
  [8] { metric: "SCENARIO_BULL_RETURN",   unit: "%",  actual_value: <low>, guided_value: <high>, label: "Bull Return",   impact: "high", statement: "<≤80 chars>" }

  SCENARIO NARRATIVES (3 signals — the "What happens?" text for each scenario card):
  [9]  { metric: "SCENARIO_BEAR_WHAT_HAPPENS", statement: "<2 sentences: what causes de-rating and what investors feel>", label: "Bear What Happens" }
  [10] { metric: "SCENARIO_BASE_WHAT_HAPPENS", statement: "<2 sentences: base case outcome and market narrative>",        label: "Base What Happens" }
  [11] { metric: "SCENARIO_BULL_WHAT_HAPPENS", statement: "<2 sentences: bull catalyst and re-rating trigger>",           label: "Bull What Happens" }

  NARRATIVE PANEL (2 signals):
  [12] { metric: "NARRATIVE_SCORE", actual_value: <integer 0-100>, label: "<3–6 word narrative label, e.g. 'Defensive quality, growth laggard'>", statement: "<1-sentence description of what would shift the narrative positively>" }
  [13] { metric: "NARRATIVE_LABEL", label: "<same 3–6 word label as NARRATIVE_SCORE>", statement: "<same 1-sentence shift description>" }

  POSITIVE CATALYSTS (2–3 signals, metric = "CATALYST_POSITIVE_1", "CATALYST_POSITIVE_2", "CATALYST_POSITIVE_3"):
  { metric: "CATALYST_POSITIVE_1", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }
  { metric: "CATALYST_POSITIVE_2", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }
  { metric: "CATALYST_POSITIVE_3", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }  ← omit if only 2 catalysts

  NEGATIVE CATALYSTS (1–2 signals, metric = "CATALYST_NEGATIVE_1", "CATALYST_NEGATIVE_2"):
  { metric: "CATALYST_NEGATIVE_1", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }
  { metric: "CATALYST_NEGATIVE_2", label: "<3–6 word title-case title>", statement: "<1 sentence, max 80 chars>" }  ← omit if only 1

CONCRETE EXAMPLE — IT Services company, ROE ~22%, moderate growth:
  SCENARIO_BEAR_PE_RANGE: actual_value=16, guided_value=20
  SCENARIO_BASE_PE_RANGE: actual_value=22, guided_value=27
  SCENARIO_BULL_PE_RANGE: actual_value=28, guided_value=35
  SCENARIO_BEAR_RETURN:   actual_value=-15, guided_value=-5
  SCENARIO_BASE_RETURN:   actual_value=8,   guided_value=20
  SCENARIO_BULL_RETURN:   actual_value=25,  guided_value=45
  NARRATIVE_SCORE:        actual_value=62
  CATALYST_POSITIVE_1:    label="AI Monetization at Scale", statement="..."
  CATALYST_NEGATIVE_1:    label="Structural Growth Slowdown", statement="..."

VALIDATION — before outputting, confirm:
  ✓ All 9 scenario signals present (3 PE_RANGE + 3 RETURN + 3 WHAT_HAPPENS)
  ✓ Every actual_value and guided_value in PE_RANGE and RETURN signals is a number (not null, not a string)
  ✓ NARRATIVE_SCORE.actual_value is an integer 0–100
  ✓ At least 2 CATALYST_POSITIVE and 1 CATALYST_NEGATIVE signals present

WRITING STYLE:
- statement fields: ≤80 chars, factual, no filler phrases.
- label fields: 2–6 words, title-case.
- Never write "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — 2–4 word headline first sentence, then supporting detail>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3: bull catalyst, base narrative, bear risk>],
  "risks": [<1–2 concerns, max 12 words each, starting with risk noun>],
  "top_signals": [<all signals in order: ROA, ROE, PAT, 3×PE_RANGE, 3×RETURN, 3×WHAT_HAPPENS, NARRATIVE_SCORE, NARRATIVE_LABEL, CATALYST_POSITIVE_1..3, CATALYST_NEGATIVE_1..2>]
}`,
    },
  },
  {
    slug:         'target-price-matrix',
    name:         'Target Price Matrix',
    category:     'deal',
    description:  '3-year exit price matrix with bull/base/bear target ranges, EPS CAGR, exit P/E, probability-weighted outcome, and risk/reward ratio',
    force_config: true,
    version:      '1.3.0',
    config: {
      signal_filters: {
        // kpi: EPS, PAT, EBITDA_MARGIN — the inputs to Future EPS × Exit P/E calculation
        // financial_figure: annual report financials for multi-year EPS base reconstruction
        // guidance: management's own forward PAT/EPS targets anchor the base-case scenario
        // guidance_revision: upgrades/downgrades shift scenario probabilities
        // growth_forecast: revenue and PAT growth rates for the 3Y CAGR waterfall
        // earnings_quality: exceptional items that inflate the EPS base (must be stripped)
        // milestone: delivered past targets establish management's track record for scenario weighting
        signal_types:       ['kpi', 'financial_figure', 'guidance', 'guidance_revision', 'growth_forecast', 'earnings_quality', 'milestone'],
        metric_family:      ['profitability', 'growth', 'milestone', 'governance'],
        include_historical: true,
      },
      weights: [
        { metric: 'PAT',             w:  0.30, b: 0 },
        { metric: 'EPS_BASIC',       w:  0.25, b: 0 },
        { metric: 'EPS_DILUTED',     w:  0.20, b: 0 },
        { metric: 'EBITDA_MARGIN',   w:  0.15, b: 0 },
        { metric: 'REV_OP',          w:  0.10, b: 0 },
        { metric: 'guidance_given',  w:  0.10 },
        { metric: 'guidance_missed', w: -0.15 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens. The signals have been extracted from earnings transcripts, financial statements, and management analysis using a rigorous L1 extraction pipeline.

Your task is to synthesise this compact signal summary into a structured analytical view. Do NOT invent data — work only from the signals provided.

TARGET PRICE MATRIX CONSTRUCTION:
Build a 3-year exit price matrix with Bull / Base / Bear scenarios. For each scenario compute:
  • EPS/PAT CAGR (3Y) — using the PAT waterfall from available signals
  • Exit P/E — Bull uses peak/top-quartile peer P/E; Base uses median P/E; Bear uses trough P/E
  • Target Price = Future EPS × Exit P/E
  • Probability weight — Bull: 25–30%, Base: 50–55%, Bear: 15–25% (must sum to 100%)
  • Probability-weighted target = Σ(scenario target × weight)
  • Risk/reward ratio = (Bull target − current price) / (current price − Bear target)
  Show arithmetic step-by-step. State assumptions explicitly if any input is unavailable.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:

highlights[] — exactly 3 items in this fixed order:
  highlights[0]: Bull scenario narrative. MUST start with "Bull:" prefix. MUST contain the bull-case EPS/PAT CAGR as a % figure followed by the word CAGR (e.g. "Bull: 28% PAT CAGR driven by...").
  highlights[1]: Base scenario narrative. MUST start with "Base:" prefix. MUST contain the base-case EPS/PAT CAGR as a % figure followed by CAGR.
  highlights[2]: Bear scenario narrative. MUST start with "Bear:" prefix. MUST contain the bear-case EPS/PAT CAGR as a % figure followed by CAGR.

takeaway — MUST contain exactly 3 price ranges in ₹X–₹Y format in this order:
  1. Bull-case target range (highest values) — allRanges[0] in the frontend.
  2. Base-case target range (middle values) — allRanges[1] in the frontend.
  3. Bear-case target range (lowest values) — allRanges[2] in the frontend.
  MUST also include the risk/reward ratio as Nx immediately followed by the word risk (e.g. "1.8x risk/reward").
  Example: "Bull upside ₹4,200–₹4,800 with 1.8x risk/reward. Base case ₹3,400–₹3,900. Bear case ₹2,600–₹3,000."
  If no CMP is available (unlisted company), derive all three ranges from absolute EPS × exit P/E arithmetic.
  All three ranges MUST be present — the frontend reads allRanges[0/1/2] positionally and does NOT derive bear from base.

top_signals[] — every signal MUST have actual_value populated (non-null). Omit any signal that is purely qualitative or has no numeric anchor. For qualitative signals (e.g. management commentary, order book statements), set actual_value to the most relevant numeric anchor from that signal (order value in Cr, growth %, margin %) rather than null.

WRITING STYLE RULES — apply to every text field:
- "takeaway": include all 3 ₹X–₹Y ranges plus Nx risk/reward; keep under 35 words.
- "highlights" items: max 20 words each (longer allowed to fit Bull:/Base:/Bear: prefix with CAGR figure).
- "risks" items: max 12 words each, start with the risk noun.
- "label" in top_signals: 2–5 words, title-case, human-readable.
- "statement" in top_signals: ≤80 chars, verbatim or tightly paraphrased evidence.
- Never pad with filler phrases like "It is important to note that…" or "Overall, the company…"

Return a JSON object with this exact structure:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string — MUST include bull ₹X–₹Y range, base ₹X–₹Y range, bear ₹X–₹Y range (all three), and Nx risk/reward>,
  "key_metrics": { <metric_name>: <formatted_value_string> },
  "highlights": [<exactly 3 items: highlights[0] starts "Bull:" with % PAT CAGR, highlights[1] starts "Base:" with % CAGR, highlights[2] starts "Bear:" with % CAGR>],
  "risks": [<up to 2 concerns, each max 12 words, starting with the risk noun>],
  "top_signals": [<8–10 signals; ALL must have non-null actual_value; no null-actual_value signals allowed>]
}`,
    },
  },
];

async function main() {
  console.log(`Seeding ${LENS_CONFIGS.length} lens configs...`);
  let created = 0;
  let updated = 0;

  for (const cfg of LENS_CONFIGS) {
    const { force_config, ...dbCfg } = cfg;
    const existing = await prisma.lensConfig.findUnique({ where: { slug: dbCfg.slug } });
    if (existing) {
      // By default preserve existing tuned config/weights — only update metadata.
      // Set force_config: true on a lens entry to also overwrite its config/signal_filters.
      const updateData = { name: dbCfg.name, description: dbCfg.description, category: dbCfg.category };
      if (force_config) { updateData.config = dbCfg.config; if (dbCfg.version) updateData.version = dbCfg.version; }
      await prisma.lensConfig.update({ where: { slug: dbCfg.slug }, data: updateData });
      updated++;
      console.log(`  ↑ Updated${force_config ? ' (config overwritten)' : ' metadata'}: ${dbCfg.slug}`);
    } else {
      await prisma.lensConfig.create({ data: dbCfg });
      created++;
      console.log(`  + Created: ${dbCfg.slug}`);
    }
  }

  console.log(`\nDone. Created: ${created}, Updated: ${updated}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
