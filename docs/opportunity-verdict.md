---
name: opportunity-verdict
description: >
  Use this skill to synthesize a business quality verdict from four upstream analytical conclusions:
  industry analysis, competition, financial strength, and customer/distribution.
  Triggers include: "give me the opportunity verdict", "business quality verdict", "what's the opportunity score",
  "synthesize the MOD analysis", "opportunity conclusion", "is this a good business",
  "summarise industry + competition + financials + customers", "what does the analysis say",
  or any request to combine industry analysis + competition + financial strength + customer/distribution
  into a single actionable verdict. Always use this skill when two or more of these four inputs are present
  and the user asks for a conclusion, summary, or call — even if they just say "so what do we think?"
  or paste a combined analysis block. Output is always: Heading + Subheading + 4 Metrics.
---

# Opportunity Verdict Skill

Synthesizes four upstream conclusions — Industry Analysis, Competition, Financial Strength,
and Customer/Distribution — into a single decisive verdict: one conclusive heading, one precise
subheading (25–30 words), and four metrics that anchor the call.

No hedging. No narrative. One verdict.

---

## Input Contract

The skill expects conclusions across four dimensions. They may arrive as:
- Structured outputs from upstream Quantcase analytical skills
- Analyst-written summaries pasted inline
- A combined block the user wants synthesised

| Input Dimension | What to Extract |
|---|---|
| **Industry Analysis** | Industry growth rate (TAM CAGR or volume growth), demand-supply balance (tight / loose / structural), industry margin pool trend (expanding / stable / compressing), 1–2 structural tailwinds or headwinds |
| **Competition** | Market share position (leader / challenger / fragmented), barriers to entry assessment (high / medium / low), peer KPI benchmarking verdict (outperforming / in-line / lagging) |
| **Financial Strength** | P&L quality (revenue growth, margin trajectory), balance sheet health (D/E, net debt / EBITDA), free cash flow generation (FCF yield or FCF margin), working capital discipline (debtor days, inventory turns) |
| **Customer / Distribution** | Revenue segment mix (diversified / concentrated), customer concentration risk (top-3 or top-5 revenue %, Herfindahl), contract visibility (order book / backlog as % of revenue or months covered), distribution reach vs. peers |

**If fewer than two inputs are present, flag it and request the missing conclusions before proceeding.
Do not synthesise a partial picture silently.**

---

## Step 1 — Score Each Dimension

Before writing any output, internally score each dimension. Do not surface this to the user —
it is your reasoning scaffold only.

### 1A. Industry Attractiveness

| Signal | Score |
|---|---|
| TAM growing >12% CAGR, demand > supply, margins expanding | **Strong** |
| TAM growing 6–12%, balanced demand-supply, stable margins | **Moderate** |
| TAM growing <6% or declining, supply excess, margin pressure | **Weak** |

### 1B. Competitive Position

| Signal | Score |
|---|---|
| Market leader or strong #2, high barriers (capital / tech / regulatory / brand), outperforming peers on ROCE / margins | **Dominant** |
| Challenger with defensible niche, medium barriers, in-line with peers | **Resilient** |
| Fragmented market, low barriers, lagging peers on key KPIs | **Vulnerable** |

### 1C. Financial Strength

| Signal | Score |
|---|---|
| Revenue growing >15%, margins expanding or stable, net debt / EBITDA < 1.5×, FCF positive, working capital tightening | **Strong** |
| Revenue growing 8–15%, margins flat, moderate leverage (1.5–3×), FCF breakeven or mildly positive | **Adequate** |
| Revenue growth < 8% or declining, margins compressing, leverage > 3×, FCF negative, working capital stretched | **Stressed** |

### 1D. Customer / Distribution Quality

| Signal | Score |
|---|---|
| Diversified revenue, top-5 customer < 30%, order book > 9 months, multi-channel distribution advantage | **Resilient** |
| Some concentration (top-5 = 30–60%), order book 4–9 months, adequate distribution reach | **Moderate** |
| High concentration (top-5 > 60%), low order visibility, single-channel dependency | **Fragile** |

---

## Step 2 — Map Scores to Verdict Tone

Use the four dimension scores as anchors. Apply judgment when signals diverge — the **heading must
reflect the dominant signal, not the average**.

| Combination | Verdict Tone |
|---|---|
| Industry: Strong + Competition: Dominant + Financials: Strong + Customers: Resilient | **High-Quality Compounder** — structural edge across all dimensions |
| Industry: Strong + Competition: Dominant + Financials: Strong + Customers: Moderate | **Quality Business, Concentration Risk to Watch** |
| Industry: Strong + Competition: Resilient + Financials: Adequate + Customers: Resilient | **Good Business, Execution is the Differentiator** |
| Industry: Moderate + Competition: Dominant + Financials: Strong + Customers: Resilient | **Defensive Moat in a Maturing Market** |
| Industry: Strong + Competition: Vulnerable + Financials: Adequate + Customers: Moderate | **Sector Tailwind Masking Structural Weakness** — scrutinise closely |
| Industry: Moderate + Competition: Resilient + Financials: Adequate + Customers: Moderate | **Steady but Unexceptional — Catalyst Needed** |
| Any: Financials: Stressed + Competition: Vulnerable | Override to **Avoid Until Balance Sheet Stabilises** regardless of industry score |
| Any: Customers: Fragile + Revenue concentration > 60% in 1 customer | Flag **Concentration Risk** as a prominent modifier in heading |

These are anchors, not rigid rules. The heading must capture the single most decisive signal.

---

## Step 3 — Select the 4 Key Metrics

Metrics must **directly support the heading**. Each metric must come from a different input dimension
(one per dimension — industry, competition, financials, customers). If two dimensions yield an
equally decisive metric, weight toward the one that most anchors the call.

**Metric selection priority per dimension:**

| Dimension | Preferred Metric (in priority order) |
|---|---|
| **Industry** | TAM CAGR (%), Industry margin pool direction, Demand-supply balance descriptor |
| **Competition** | Market share rank + share %, ROCE vs. peer median (delta), Barriers to entry classification |
| **Financial Strength** | FCF yield or FCF margin (%), Net debt / EBITDA (×), EBITDA margin vs. 3-year trend, Revenue CAGR (3Y) |
| **Customer / Distribution** | Order book / backlog coverage (months), Top-3 or Top-5 revenue concentration (%), Revenue mix (% recurring vs. project) |

**Metric format rules:**
- Always quantitative where data is available. If only directional, use: `↑ Expanding` / `↔ Stable` / `↓ Compressing`
- Each metric = **Label**: **Value** on one line. No narrative sentences in the metrics block.
- Label must be ≤ 5 words. Value must be ≤ 10 words.

---

## Step 4 — Write the Output

### Output Format (strict)

```
─────────────────────────────────────────
HEADING
[Company Name / Ticker]: [Conclusive Verdict Statement]
─────────────────────────────────────────
SUBHEADING
[25–30 words. One sentence. Must state: the dominant signal driving the verdict
+ one condition or risk that could change it.]
─────────────────────────────────────────
METRICS
[Industry Metric Label]:    [Value]
[Competition Metric Label]: [Value]
[Financial Metric Label]:   [Value]
[Customer Metric Label]:    [Value]
─────────────────────────────────────────
```

---

## Heading Rules

The heading is a **verdict**, not a description. It must:
1. Name the company or ticker explicitly
2. State the call — no hedging words ("potential", "could", "may")
3. Capture the dominant signal in ≤ 12 words after the company name

**Good heading patterns:**
- `[Ticker]: High-Quality Compounder — Structural Moat Across All Four Dimensions`
- `[Ticker]: Sector Tailwind Masking Weak Competitive Position — Monitor Closely`
- `[Ticker]: Defensive Balance Sheet in a Maturing Market — Accumulate on Dips`
- `[Ticker]: Customer Concentration is the Single Overhang on an Otherwise Strong Business`
- `[Ticker]: Fragmented Market + Stressed Financials = Risk-Off Until Clarity`

**Bad heading patterns (reject these):**
- ❌ `[Ticker]: A Well-Positioned Company with Some Risks` — no verdict
- ❌ `[Ticker]: Mixed Signals Across Dimensions` — too passive, says nothing
- ❌ `[Ticker]: Strong Industry with Decent Financials` — descriptive, not conclusive

---

## Subheading Rules

25–30 words. One sentence. Must contain:
1. **The dominant signal** — the single most decisive finding from the four dimensions
2. **The condition or risk** — what would change, invalidate, or upgrade this verdict

**Good subheading:**
> "Industry growing at 14% CAGR with market leadership and expanding FCF margins makes the core thesis compelling; customer concentration above 55% in top-3 accounts is the primary risk to monitor."

**Bad subheading:**
> "The company operates in a good industry and has decent financials with some competitive strengths and manageable risks." — vague, no numbers, no condition

---

## Step 5 — Conflict & Override Log

After the output block, add a compact log (3 lines max) **only if dimension scores conflict materially**:

```
⚠️  CONFLICTS / OVERRIDES
- [Dimension A] score conflicts with [Dimension B] — [which one dominates the verdict and why]
- [Any override triggered — e.g. stressed financials overriding strong industry score]
```

Skip this section entirely if dimensions are consistent.

---

## Output Assembly Rules

1. **Start directly with the output block.** No preamble ("Based on the four inputs…").
2. **Heading first, always.** Metrics never appear before the heading.
3. **Metrics must trace directly to the input conclusions.** Do not invent numbers not present in the inputs.
4. **If a metric value is unavailable**, state it as `[Not Available — flag for analysis]` and note it in the conflict log.
5. **One verdict per output.** Do not present two scenarios as co-equal calls. Pick one. Nuance goes in the subheading.
6. **Plain language.** The heading and subheading must be readable by a senior RM or portfolio manager in 5 seconds.
7. **No dimension labels in the metrics block headers.** The metric label must be self-explanatory (e.g. "Industry CAGR" not "Industry Metric: CAGR").

---

## Example Output

```
─────────────────────────────────────────
HEADING
KALYANKJIL: High-Quality Compounder in an Underpenetrated Market — Accumulate
─────────────────────────────────────────
SUBHEADING
Organised jewellery growing at 15% CAGR with Kalyan holding #2 position and expanding
FCF margins; customer concentration is low but franchise expansion execution is the
single variable to track.
─────────────────────────────────────────
METRICS
Industry CAGR (Organised Segment):   15% (FY24–FY27E)
Market Share vs. Nearest Peer:        8.2% vs. 6.1% — 210 bps gap
FCF Margin (FY24):                    11.4%, expanding from 7.8% in FY22
Revenue Concentration (Top-3 Cities): 38% — moderate, declining trend
─────────────────────────────────────────
```

---

## Relationship to Other Skills

This skill covers the **Opportunity + Deal dimensions** of the Quantcase MOD framework.
It is upstream of the `investment-verdict` skill, which adds the Earnings Forecast and
P/E Re-rating layer to produce a final buy/sell/hold call with upside quantification.

If the user asks for a complete investment verdict after this output, trigger `investment-verdict`
with this output as one of the inputs.
