---
name: investment-verdict
description: >
  Use this skill to synthesize an investment verdict from three upstream analytical conclusions:
  earnings quality, earnings forecast (EPS CAGR scenarios), and P/E re-rating potential.
  Triggers include: "give me the verdict", "investment conclusion", "what's the call on this stock",
  "synthesize the analysis", "final verdict", "buy/sell/hold conclusion", "summarise the investment case",
  or any request to combine earnings quality + forecast + re-rating into a single actionable output.
  Always use this skill when all three inputs are present — even if the user just says "so what's the call?"
  or pastes a combined analysis and asks for a summary. Output is always: Heading + Subheading + Metrics block.
---

# Investment Verdict Skill

Synthesizes earnings quality, earnings forecast, and P/E re-rating conclusions into a single
investment verdict: one decisive heading, one precise subheading, and a metrics block.

No hedging. No paragraphs. One call.

---

## Input Contract

The skill expects three upstream conclusions. They may arrive as:
- Structured outputs from the earnings-quality, earnings-forecast, or MQI skills
- Analyst-written summaries pasted inline
- A combined block the user wants synthesised

| Input | What to Extract |
|---|---|
| **Earnings Quality Conclusion** | Overall quality verdict (High / Mixed / Low), key signals (accrual ratio, cash conversion, provisioning, disclosure pattern), any red flags |
| **Earnings Forecast Conclusion** | EPS CAGR — Bear / Base / Bull (3-year), key swing factor, data gaps flagged |
| **P/E Re-rating Potential** | Direction (Expanding / Neutral / Contracting), magnitude (target P/E vs. current P/E), rationale |

**If any of the three inputs is absent or ambiguous, flag it before proceeding. Do not synthesise a partial picture silently.**

---

## Step 1 — Read the Signal Matrix

Before writing output, internally score each input axis. Do not show this to the user — it is your reasoning scaffold.

| Axis | Signal | Weight in Verdict |
|---|---|---|
| Earnings Quality | High = tailwind / Mixed = neutral / Low = headwind | 30% |
| EPS CAGR (Base) | >18% = strong / 10–18% = moderate / <10% = weak | 40% |
| P/E Re-rating | Expanding = multiplier / Neutral = pass-through / Contracting = drag | 30% |

**Verdict Classification:**

| Combination | Verdict Tone |
|---|---|
| Quality: High + CAGR: Strong + Re-rating: Expanding | **Conviction Buy** — multi-year compounding window |
| Quality: High + CAGR: Strong + Re-rating: Neutral | **Accumulate** — earnings-led return, limited multiple expansion |
| Quality: Mixed + CAGR: Strong + Re-rating: Expanding | **Tactical Buy** — momentum visible, quality risk to monitor |
| Quality: High + CAGR: Moderate + Re-rating: Expanding | **Accumulate** — re-rating drives return, earnings need to deliver |
| Quality: Mixed + CAGR: Moderate + Re-rating: Neutral | **Hold / Monitor** — no clear catalyst, thesis intact but unexciting |
| Quality: Low + CAGR: Moderate/Weak + Re-rating: Contracting | **Avoid / Exit** — deteriorating quality + multiple compression = double drag |
| Any: Low quality + red flags | Override to **Caution** — flag prominently regardless of CAGR |

Use these as anchors, not rules. Apply judgment when signals are mixed. The heading must reflect the dominant signal, not the average.

---

## Step 2 — Compute Upside %

Upside is the total return potential from current price to target price over the forecast horizon (typically 2–3 years).

```
Upside % = [ (EPS Base × Target P/E) / Current Price − 1 ] × 100
```

If exact current price and target P/E are available, compute precisely.

If not available from inputs:
- Use the P/E re-rating conclusion directionally (e.g., "re-rating from 12× to 16× implies 33% multiple expansion")
- Combine with Base EPS CAGR to state a return range
- Label it as an **indicative range**, not a point estimate

Always show Upside % for Base case. Show Bull / Bear upside if the range is meaningful (>15 pp spread).

---

## Step 3 — Write the Output

### Output Format (strict)

```
─────────────────────────────────────────
HEADING
[Company Name]: [Conclusive Verdict Statement]
─────────────────────────────────────────
SUBHEADING
[25–30 words. One sentence. Explains the heading.
Must state: what is driving the call + the key risk or condition.]
─────────────────────────────────────────
METRICS
EPS CAGR (3-Year)
  Bull  ____%
  Base  ____%
  Bear  ____%

Upside to Target
  Bull  ____%
  Base  ____%
  Bear  ____%  [or: Base  ____% | Range: ____% – ____%]
─────────────────────────────────────────
```

---

## Heading Rules

The heading is a **verdict**, not a description. It must:

1. Name the company (or ticker) explicitly
2. State the call — do not hedge with "potential" or "could"
3. Capture the dominant signal in ≤10 words after the company name

**Good heading patterns:**
- `[Ticker]: Earnings Quality + Re-rating = Multi-Year Compounding Window`
- `[Ticker]: Strong CAGR Priced In — Wait for Better Entry`
- `[Ticker]: Quality Deteriorating, Avoid Until Provisioning Normalises`
- `[Ticker]: Re-rating Thesis Intact, Execution Risk is the Only Overhang`
- `[Ticker]: Accumulate — Earnings Inflection Visible, Multiple Still Cheap`

**Bad heading patterns (reject these):**
- ❌ `[Ticker]: A Balanced Investment Opportunity` — no verdict
- ❌ `[Ticker]: Mixed Signals Suggest Caution` — too passive
- ❌ `[Ticker]: Strong Fundamentals with Some Risks` — meaningless

---

## Subheading Rules

25–30 words. One sentence. Must contain:
1. **The driver** — what is making this the right call (earnings growth rate, quality improving, re-rating catalyst)
2. **The condition or risk** — what would invalidate or upgrade the call

**Good subheading:**
> "Base EPS CAGR of 19% paired with P/E re-rating from 8× to 12× drives 55% upside; execution on credit cost normalisation remains the single condition to monitor."

**Bad subheading:**
> "The company has strong earnings and could see P/E re-rating if things go well." — vague, no numbers, no condition

---

## Step 4 — Conflict & Override Log

After the output block, add a compact log (3 lines max) only if there are conflicts between inputs:

```
⚠️  CONFLICTS / OVERRIDES
- [Signal A] from quality conclusion conflicts with [Signal B] from forecast — [which one dominates and why]
- [Any quality red flag that triggered a verdict override]
```

Skip this section entirely if inputs are consistent.

---

## Output Assembly Rules

1. **Start directly with the output block.** No preamble ("Based on the three inputs…"). 
2. **Heading first, always.** Metrics never appear before the heading.
3. **Numbers must match the forecast inputs exactly.** Do not round or adjust silently.
4. **If P/E and current price are unavailable**, state Upside as a directional range and label it `[indicative]`.
5. **One call per output.** Do not present two scenarios as co-equal verdicts. Pick one. Put the range in metrics.
6. **Plain language.** The heading and subheading must be readable by a senior RM in 5 seconds.

---

## Example Output

```
─────────────────────────────────────────
HEADING
CANBK: Re-rating Catalyst Emerging — Accumulate Before Credit Cost Normalisation is Priced In
─────────────────────────────────────────
SUBHEADING
Base EPS CAGR of 17% combined with P/E re-rating from 0.8× to 1.1× P/B drives ~45% upside;
thesis hinges on GNPA declining below 4% by FY26 as guided.
─────────────────────────────────────────
METRICS
EPS CAGR (3-Year, FY24–FY27)
  Bull   24%
  Base   17%
  Bear    9%

Upside to Target (Base: P/B 1.1×)
  Bull   68%
  Base   45%
  Bear    8%
─────────────────────────────────────────
```
