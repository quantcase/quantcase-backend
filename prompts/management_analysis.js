'use strict';

// ─── Static skill instructions (stored in DB as promptTemplate) ───────────────

const PROMPT_TEMPLATE = `# Management Factor Analyser — India-First

> Forensic equity analysis for Indian listed companies (BSE/NSE). Combines sell-side rigour with short-seller scepticism.

---

## Output Structure (in order)

1. Guidance vs Actuals Table
2. Promoter Activity
3. Red Flags
4. MQI Score
5. Investment Thesis + Next Concall Watchlist

---

## 1. Guidance vs Actuals Table

Extract every quantitative or semi-quantitative commitment from the milestones and KPI data. Map to actuals where available.

Fields per row: period | metric | guidance | actual | delta | severity | tag | management_explanation

**Delta formula:** (Actual − Guidance) / |Guidance| × 100
- Positive = beat, Negative = miss
- For qualitative guidance (e.g. "breakeven"), use directional outcome instead of %
- If actuals not provided, write "–"

**Severity values:**
- beat — at or above guidance
- met — exactly met
- minor — < 5% miss
- mediocre — 5–15% miss
- major — > 15% miss
- rolled_forward — target extended, no acknowledgement
- not_trackable — too vague to verify
- ongoing — period not yet complete
- aggressive — forward guidance rated aggressive
- vague — qualitative only, no number given

**Summary stats required:**
- hit_rate: { met_or_beat, total_trackable }
- misses: { major, mediocre, minor }
- guidance_bias: Conservative / Neutral / Aggressive / Deliberately vague
- pattern: 2 sentences — what does the miss pattern reveal?

---

## 2. Promoter Activity

Even if no promoter data is provided, note what's missing and flag it.

**Shareholding trend (last 4–6 quarters if available):**
Fields: quarter | promoter_pct | pledge_pct | change | signal

**Signals to assess:**
- Rising pledge alongside earnings pressure → critical
- Promoter selling during bullish guidance → critical
- Growing RPT as % of revenue → caution
- Unexplained interco transactions → caution
- Big 4 → smaller auditor → caution
- Promoter buying in open market → positive

**Promoter quality verdict:** Strong / Adequate / Weak / Red flag + one sentence rationale.

---

## 3. Red Flags

Every flag: title → evidence (quote or data point) → implication

**severity values:**
- critical — fraud signals, earnings manipulation, governance failure
- caution — credibility erosion, capital misallocation
- watch — soft signals, tone shifts, vague answers

---

## 4. MQI Score

### Identify Company Stage First
Profitable/Mature | Growth/Pre-profitability | NBFC/Bank | Capital Goods/Infra

### Score three dimensions

**Guidance Credibility (max 40):**
- Hit Rate (15): >80% → 13–15 / 60–80% → 10–12 / 40–60% → 6–9 / <40% → 0–5
- Guidance Bias (10): Conservative → 8–10 / Mixed → 5–7 / Aggressive → 0–4
- Miss Transparency (10): Proactive → 8–10 / Partial → 5–7 / Macro blame → 2–4 / Ignores → 0–1
- Guidance Specificity (5): Quantitative + time-bound → 4–5 / Mixed → 2–3 / Vague → 0–1

**Capital Allocation (max 35):**
- Reinvestment Quality (10): High-ROCE capex with rationale → 8–10 / Weak justification → 4–7 / Overruns → 0–3
- Shareholder Returns Logic (5): Consistent FCF-linked → 4–5 / Inconsistent → 2–3 / Misaligned → 0–1
- M&A Discipline (10): Strategic fit → 8–10 / Mixed → 4–7 / Value-destructive → 0–3 / No M&A → 7
- Capital Efficiency Trend (10): ROCE/ROE improving or >15% → 8–10 / Flat → 5–7 / Declining → 0–4

**Disclosure & Honesty (max 25):**
- Bad News Disclosure (8): Proactive → 7–8 / When pressed → 4–6 / Minimises → 1–3 / Misleading → 0
- Narrative Consistency (7): Same story + logical evolution → 6–7 / Minor pivots → 4–5 / Rewrites → 1–3 / Contradictions → 0
- Transparency Depth (5): Segment + geo + vol/price splits → 4–5 / Moderate → 2–3 / Aggregated → 0–1
- Governance Signals (5): Clean audit + low RPT + low pledge → 4–5 / Minor concerns → 2–3 / High risk → 0–1

**MQI Labels:**
- 80–100 → Elite
- 65–79 → High Quality
- 50–64 → Average
- < 50 → Weak / Risky

---

## Sector Adjustments

**New-Age / Pre-Profitability:** Unit economics primary. Replace ROCE with burn multiple (< 1x → 8–10 / 1–2x → 5–7 / > 2x → 0–4).

**NBFC / Banks:** NIM and slippage guidance weighted 2x. CRAR trajectory > dividends. Stage 2/3 asset disclosure critical.

**Capital Goods / Infra:** Order book execution rate is primary KPI. Every project delay = rolled_forward. Penalise off-balance-sheet structures.

---

## 5. Investment Thesis + Next Concall Watchlist

**Bull case (management quality lens):** bullet points on what management does well
**Bear case (management quality lens):** bullet points on what erodes conviction

**Next Concall Watchlist — 4–6 specific, falsifiable items:**
Fields: number | what_to_listen_for | why_it_matters | green_signal | red_signal

Good item: "Watch whether Q1 compliance cost is called one-time again" — not "watch margins".

---

## Analysis Principles

1. Evidence-first — every claim cites a specific quote, period, or data point
2. Pattern over point — single-period = flag; multi-period = verdict
3. Penalise vagueness — "strong double-digit growth" without a number is marketing
4. India promoter lens — does management act like owners or agents?
5. Macro excuse rule — valid once; repeated = operational weakness
6. Analyst Q&A is gold — evasion scores down; specificity scores up

---

## India-Specific Evasion Patterns

- Macro blame ("Monsoon impact") — valid once; repeated = operations weak
- Normalisation abuse ("one-time charge") — count frequency; > 2x/year = critical
- Range guidance ("15–25% growth") — > 10pp wide is unfalsifiable, penalise
- Long-term deflection ("5-year story intact") — deflects from current-year miss
- Volume vs value switch — guides revenue, reports volume when revenue misses
- KPI redefinition — changes definition of EBITDA/GMV/active users, always flag`;

// ─── Output schema (stored in DB for reference — NOT sent to LLM as response_format)
// Not enforced via response_format to avoid "grammar too large" errors on Anthropic API.

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['guidance_vs_actuals', 'promoter_activity', 'red_flags', 'mqi_score', 'investment_thesis'],
  properties: {
    guidance_vs_actuals: {
      type: 'object',
      required: ['rows', 'hit_rate', 'misses', 'guidance_bias', 'pattern'],
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            required: ['period', 'metric', 'guidance', 'actual', 'delta', 'severity', 'tag', 'management_explanation'],
            properties: {
              period:                 { type: 'string' },
              metric:                 { type: 'string' },
              guidance:               { type: 'string' },
              actual:                 { type: 'string' },
              delta:                  { type: 'string' },
              severity:               { type: 'string' },
              tag:                    { type: 'string' },
              management_explanation: { type: 'string' },
            },
          },
        },
        hit_rate: {
          type: 'object',
          required: ['met_or_beat', 'total_trackable'],
          properties: {
            met_or_beat:     { type: 'integer' },
            total_trackable: { type: 'integer' },
          },
        },
        misses: {
          type: 'object',
          required: ['major', 'mediocre', 'minor'],
          properties: {
            major:    { type: 'integer' },
            mediocre: { type: 'integer' },
            minor:    { type: 'integer' },
          },
        },
        guidance_bias: { type: 'string' },
        pattern:       { type: 'string' },
      },
    },
    promoter_activity: {
      type: 'object',
      required: ['shareholding', 'verdict', 'verdict_rationale', 'promoter_note'],
      properties: {
        shareholding: {
          type: 'array',
          items: {
            type: 'object',
            required: ['quarter', 'promoter_pct', 'pledge_pct', 'change', 'signal'],
            properties: {
              quarter:      { type: 'string' },
              promoter_pct: { type: ['number', 'null'] },
              pledge_pct:   { type: ['number', 'null'] },
              change:       { type: ['string', 'null'] },
              signal:       { type: 'string' },
            },
          },
        },
        verdict:           { type: 'string' },
        verdict_rationale: { type: 'string' },
        promoter_note:     { type: 'string' },
      },
    },
    red_flags: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'evidence', 'implication'],
        properties: {
          title:       { type: 'string' },
          severity:    { type: 'string' },
          evidence:    { type: 'string' },
          implication: { type: 'string' },
        },
      },
    },
    mqi_score: {
      type: 'object',
      required: ['total', 'label', 'investment_implication', 'dimensions'],
      properties: {
        total:                  { type: 'integer' },
        label:                  { type: 'string' },
        investment_implication: { type: 'string' },
        dimensions: {
          type: 'object',
          required: ['guidance_credibility', 'capital_allocation', 'disclosure_honesty'],
          properties: {
            guidance_credibility: {
              type: 'object',
              required: ['score', 'max', 'rationale'],
              properties: {
                score:     { type: 'integer' },
                max:       { type: 'integer' },
                rationale: { type: 'string' },
              },
            },
            capital_allocation: {
              type: 'object',
              required: ['score', 'max', 'rationale'],
              properties: {
                score:     { type: 'integer' },
                max:       { type: 'integer' },
                rationale: { type: 'string' },
              },
            },
            disclosure_honesty: {
              type: 'object',
              required: ['score', 'max', 'rationale'],
              properties: {
                score:     { type: 'integer' },
                max:       { type: 'integer' },
                rationale: { type: 'string' },
              },
            },
          },
        },
      },
    },
    investment_thesis: {
      type: 'object',
      required: ['bull_case', 'bear_case', 'next_concall_watchlist'],
      properties: {
        bull_case: { type: 'array', items: { type: 'string' } },
        bear_case: { type: 'array', items: { type: 'string' } },
        next_concall_watchlist: {
          type: 'array',
          items: {
            type: 'object',
            required: ['number', 'what_to_listen_for', 'why_it_matters', 'green_signal', 'red_signal'],
            properties: {
              number:             { type: 'integer' },
              what_to_listen_for: { type: 'string' },
              why_it_matters:     { type: 'string' },
              green_signal:       { type: 'string' },
              red_signal:         { type: 'string' },
            },
          },
        },
      },
    },
  },
};

// ─── Output format instructions ───────────────────────────────────────────────

const OUTPUT_FORMAT_INSTRUCTIONS = `

---

## Required Output

Respond with a single valid JSON object only — no markdown fences, no explanation. Structure:

{
  "guidance_vs_actuals": {
    "rows": [
      { "period": "", "metric": "", "guidance": "", "actual": "", "delta": "", "severity": "beat|met|minor|mediocre|major|rolled_forward|not_trackable|ongoing|aggressive|vague", "tag": "", "management_explanation": "" }
    ],
    "hit_rate": { "met_or_beat": 0, "total_trackable": 0 },
    "misses": { "major": 0, "mediocre": 0, "minor": 0 },
    "guidance_bias": "",
    "pattern": ""
  },
  "promoter_activity": {
    "shareholding": [
      { "quarter": "", "promoter_pct": null, "pledge_pct": null, "change": null, "signal": "" }
    ],
    "verdict": "Strong|Adequate|Weak|Red flag",
    "verdict_rationale": "",
    "promoter_note": ""
  },
  "red_flags": [
    { "title": "", "severity": "critical|caution|watch", "evidence": "", "implication": "" }
  ],
  "mqi_score": {
    "total": 0,
    "label": "Elite|High Quality|Average|Weak / Risky",
    "investment_implication": "",
    "dimensions": {
      "guidance_credibility": { "score": 0, "max": 40, "rationale": "" },
      "capital_allocation":   { "score": 0, "max": 35, "rationale": "" },
      "disclosure_honesty":   { "score": 0, "max": 25, "rationale": "" }
    }
  },
  "investment_thesis": {
    "bull_case": [""],
    "bear_case": [""],
    "next_concall_watchlist": [
      { "number": 1, "what_to_listen_for": "", "why_it_matters": "", "green_signal": "", "red_signal": "" }
    ]
  }
}`;

// ─── Data block builder ───────────────────────────────────────────────────────
// Uses only structured DB fields — never raw transcript_text or ppt_text.

/**
 * @param {string}   ticker
 * @param {object[]} summaries       - summary_new rows for this ticker (all periods, oldest→newest)
 * @param {object[]} kpiValues       - kpi_values rows (source: transcript only)
 * @param {object[]} prowessValues   - prowess_values_new rows for this company
 */
function buildDataBlock(ticker, summaries, kpiValues, prowessValues) {
  const lines = [];

  lines.push(`### Company: ${ticker}`);
  lines.push('');

  // ── Structured summary data per call period ───────────────────────────────
  if (summaries.length > 0) {
    lines.push('### Earnings Call Intelligence (extracted from transcripts)');
    lines.push('');

    for (const s of summaries) {
      lines.push(`#### Period: ${s.callId}`);

      if (s.tone) {
        lines.push(`**Tone:** ${s.tone}  |  **Confidence:** ${s.confidence ?? 'N/A'}`);
      }

      if (s.entities) {
        lines.push('**Key Entities (management, auditor, board):**');
        lines.push(JSON.stringify(s.entities, null, 2));
      }

      if (s.milestones) {
        lines.push('**Milestones / Guidance Commitments:**');
        lines.push(JSON.stringify(s.milestones, null, 2));
      }

      if (s.governanceSignals) {
        lines.push('**Governance Signals:**');
        lines.push(JSON.stringify(s.governanceSignals, null, 2));
      }

      if (s.riskDisclosures) {
        lines.push('**Risk Disclosures:**');
        lines.push(JSON.stringify(s.riskDisclosures, null, 2));
      }

      if (s.industryAnalysis) {
        lines.push('**Industry Analysis:**');
        lines.push(JSON.stringify(s.industryAnalysis, null, 2));
      }

      lines.push('');
    }
  }

  // ── Transcript-sourced KPI values ─────────────────────────────────────────
  if (kpiValues.length > 0) {
    lines.push('### KPI Values (source: transcript/PPT extraction)');
    lines.push('| Call ID | KPI | Value | Unit | Period Start | Period End |');
    lines.push('|---------|-----|-------|------|--------------|------------|');
    for (const k of kpiValues) {
      lines.push(`| ${k.callId} | ${k.kpi_abbr} | ${k.value ?? 'N/A'} | ${k.unit ?? ''} | ${k.start_date ?? ''} | ${k.end_date ?? ''} |`);
    }
    lines.push('');
  }

  // ── Prowess financial KPIs (preferred) ───────────────────────────────────
  if (prowessValues.length > 0) {
    lines.push('### Financial KPIs from Prowess (audited data)');
    lines.push('> ALWAYS prefer these values over transcript/PPT values for Revenue, Capex, and Operating Margin whenever both are available.');
    lines.push('');
    lines.push('| FY | Quarter | KPI | Value | Unit |');
    lines.push('|----|---------|-----|-------|------|');
    for (const p of prowessValues) {
      lines.push(`| ${p.fiscal_year ?? ''} | ${p.quarter ?? ''} | ${p.kpi_abbr} | ${p.value ?? 'N/A'} | ${p.unit ?? ''} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Main prompt builder ──────────────────────────────────────────────────────

/**
 * @param {string}      ticker
 * @param {object[]}    summaries           - summary_new rows (all periods, oldest→newest)
 * @param {object[]}    kpiValues           - kpi_values rows (source: transcript only)
 * @param {object[]}    prowessValues       - prowess_values_new rows for this company
 * @param {string|null} template            - DB promptTemplate (falls back to PROMPT_TEMPLATE)
 * @param {string|null} defaultInstructions - DB defaultInstructions (injected at {{DEFAULT_INSTRUCTIONS}})
 */
function managementAnalysisPrompt(ticker, summaries, kpiValues, prowessValues, template, defaultInstructions = null) {
  const instructionBlock = template ?? PROMPT_TEMPLATE;
  const dataBlock        = buildDataBlock(ticker, summaries, kpiValues, prowessValues);

  const parts = [
    instructionBlock,
    '',
    '---',
    '',
    '## Data Provided for Analysis',
    '',
    dataBlock,
    OUTPUT_FORMAT_INSTRUCTIONS,
  ];

  if (defaultInstructions) {
    parts.splice(1, 0, '', '## Additional Instructions', '', defaultInstructions);
  }

  return parts.join('\n');
}

module.exports = { managementAnalysisPrompt, buildDataBlock, PROMPT_TEMPLATE, OUTPUT_SCHEMA };
