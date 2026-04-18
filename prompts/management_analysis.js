'use strict';

// ─── Static skill instructions (stored in DB as promptTemplate) ───────────────
// This entire string is seeded into Skill.promptTemplate.
// The worker injects the data block at {{DATA_BLOCK}} and optional custom
// instructions at {{DEFAULT_INSTRUCTIONS}}.

const PROMPT_TEMPLATE = `# Management Factor Analyser — India-First

> Forensic equity analysis for Indian listed companies (BSE/NSE). Combines sell-side rigour with short-seller scepticism.

---

## Output Structure (in order)

1. Guidance Accuracy
2. Promoter Activity
3. Red Flags
4. MQI Score
5. Investment Thesis + Next Concall Watchlist
6. Management Intelligence

---

## 1. Guidance Accuracy

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

- If promoter_pct or pledge_pct data is not available from transcripts, set to null.
- signal must always be a non-empty string. If data is absent, write: "Data not provided in transcripts"
- Do not leave signal blank for any row.

**Signals to assess (when data is available):**
- Rising pledge alongside earnings pressure → critical
- Promoter selling during bullish guidance → critical
- Growing RPT as % of revenue → caution
- Unexplained interco transactions → caution
- Big 4 → smaller auditor → caution
- Promoter buying in open market → positive

**Promoter quality verdict:** Strong / Adequate / Weak / Red flag + one sentence rationale.

**promoter_note:** State plainly what data was and was not available. E.g. "Promoter shareholding, pledge percentage, and RPT data were not disclosed in any of the four earnings call transcripts provided. Investors should cross-check BSE/NSE disclosures independently."

**mqi_rationale:** 1–2 sentence explanation of how the promoter data (or lack thereof) informed the MQI governance score.

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

### Score four dimensions

**Guidance Accuracy (max 40):**
- Hit Rate (15): >80% → 13–15 / 60–80% → 10–12 / 40–60% → 6–9 / <40% → 0–5
- Guidance Bias (10): Conservative → 8–10 / Mixed → 5–7 / Aggressive → 0–4
- Miss Transparency (10): Proactive → 8–10 / Partial → 5–7 / Macro blame → 2–4 / Ignores → 0–1
- Guidance Specificity (5): Quantitative + time-bound → 4–5 / Mixed → 2–3 / Vague → 0–1

**Red Flags (max 25):**
- Zero critical flags → 20–25 / One critical → 10–19 / Two+ critical → 0–9
- Weight caution and watch flags: each caution flag deducts 3–5 pts, each watch flag deducts 1–2 pts
- Cap deductions at 0 (score cannot go negative)

**Investment Thesis (max 35):**
- Capital Allocation Quality (10): High-ROCE capex with rationale → 8–10 / Weak justification → 4–7 / Overruns → 0–3
- Shareholder Returns Logic (5): Consistent FCF-linked → 4–5 / Inconsistent → 2–3 / Misaligned → 0–1
- M&A Discipline (10): Strategic fit → 8–10 / Mixed → 4–7 / Value-destructive → 0–3 / No M&A → 7
- Capital Efficiency Trend (10): ROCE/ROE improving or >15% → 8–10 / Flat → 5–7 / Declining → 0–4

**Promoter Activity (max 0 bonus / −25 penalty):**
- Base: 0 (neutral — no data available or clean)
- Promoter buying, no pledge, low RPT → +0 (captured in Investment Thesis already)
- Promoter selling during bullish guidance → −10 to −15
- Rising pledge during earnings pressure → −10 to −15
- Growing RPT as % of revenue → −5 to −10
- Big 4 → smaller auditor swap → −5
- Unexplained interco transactions → −5 to −10
- No data available → 0 (do not penalise absence of data)
- Combined deductions capped at −25; total MQI floor is 0

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

**Bull case (management quality lens):**
- 4–6 bullet points. Each ≤8 words. Lead with a metric or observed signal.
- Examples: "ROCE >40% — disciplined reinvestment" ✓ / "Revenue 5–14x outpacing industry growth" ✓
- No full sentences. No filler words.

**Bear case (management quality lens):**
- 4–6 bullet points. Same rules — ≤8 words, signal-first.
- Examples: "Greenfield SOP keeps rolling forward" ✓ / "GF losses widening, not narrowing" ✓

**Next Concall Watchlist — 4–6 specific, falsifiable items:**
Fields: number | what_to_listen_for | why_it_matters | green_signal | red_signal

**Strictly enforced conciseness rules:**
- what_to_listen_for: ≤12 words. A specific falsifiable question, not a theme.
  ✓ "Whether Gujarat EV+ICE SOP achieves Q4 FY26 or slips again"
  ✗ "Watch capex discipline" — too vague, rejected
- why_it_matters: ≤20 words. One sentence. State the risk or inflection point.
  ✓ "This SOP has slipped three times — a fourth slip confirms chronic OEM dependency risk"
- green_signal: ≤15 words. Start with a verb. Exact phrase or number that confirms thesis.
  ✓ "SOP confirmed with specific volume numbers and customer name; revenue run-rate disclosed"
- red_signal: ≤15 words. Start with a verb. Exact language shift that confirms bear case.
  ✓ "Language shifts to 'Q1 FY27' or 'customer timelines remain fluid'"

---

## 6. Management Intelligence

Synthesise the entire management analysis into a single intelligence card for the page. This is a top-level key in the output JSON: management_intelligence.

**Structure:**

- key_takeaways: Array with exactly 1 string. ≤15 words. The single most important management finding.
  E.g. "42% guidance hit rate — management credibility below sector average"

- signals_breakdown: Array of signal bucket objects. One object per MQI dimension.
  Each object: { key, label, score, max_score, sentiment, details }
  - key: one of "guidance_accuracy" | "red_flags" | "investment_thesis" | "promoter_activity"
  - label: human-readable dimension name
  - score: numeric score for that dimension (copy from mqi_score.dimensions)
  - max_score: max for that dimension (copy from mqi_score.dimensions)
  - sentiment: "positive" | "negative" | "neutral"
  - details: Array of 2–3 strings. Each ≤15 words. Hover-level bullet points for that dimension.

- scores: Object summarising MQI score card.
  { total, label, dimensions: { guidance_accuracy: { score, max }, red_flags: { score, max }, investment_thesis: { score, max }, promoter_activity: { score, max } } }
  Mirror the mqi_score object — do not recalculate, just copy values.

- recommended_strategy: Structured object with these fields:
  - action: ≤12 words. The primary stance (Hold / Buy / Avoid / Watch).
  - thesis: ≤20 words. Core reason supporting the action.
  - timing: ≤15 words. Specific trigger or event to watch before acting. Null if none.
  - segment: ≤12 words. Portfolio segment or allocation note. Null if not applicable.
  - rationale: ≤20 words. Key risk or signal to monitor.

- watchouts: Array of 3–5 strings. Each ≤12 words. Specific forward risks to monitor.
  E.g. "Greenfield EBITDA loss still widening despite 'narrowing' guidance"

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
- KPI redefinition — changes definition of EBITDA/GMV/active users, always flag

{{DEFAULT_INSTRUCTIONS}}

---

## Data Provided for Analysis

{{DATA_BLOCK}}

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
      { "quarter": "", "promoter_pct": null, "pledge_pct": null, "change": null, "signal": "Data not provided in transcripts" }
    ],
    "verdict": "Strong|Adequate|Weak|Red flag",
    "verdict_rationale": "",
    "promoter_note": "",
    "mqi_rationale": ""
  },
  "red_flags": [
    { "title": "", "severity": "critical|caution|watch", "evidence": "", "implication": "" }
  ],
  "mqi_score": {
    "total": 0,
    "label": "Elite|High Quality|Average|Weak / Risky",
    "investment_implication": "",
    "dimensions": {
      "guidance_accuracy":   { "score": 0, "max": 40, "rationale": "" },
      "red_flags":           { "score": 0, "max": 25, "rationale": "" },
      "investment_thesis":   { "score": 0, "max": 35, "rationale": "" },
      "promoter_activity":   { "score": 0, "max": 0,  "penalty": 0, "rationale": "" }
    }
  },
  "investment_thesis": {
    "bull_case": [""],
    "bear_case": [""],
    "next_concall_watchlist": [
      { "number": 1, "what_to_listen_for": "", "why_it_matters": "", "green_signal": "", "red_signal": "" }
    ]
  },
  "management_intelligence": {
    "key_takeaways": [""],
    "signals_breakdown": [
      { "key": "guidance_accuracy", "label": "Guidance Accuracy", "score": 0, "max_score": 40, "sentiment": "positive|negative|neutral", "details": [""] },
      { "key": "red_flags", "label": "Red Flags", "score": 0, "max_score": 25, "sentiment": "positive|negative|neutral", "details": [""] },
      { "key": "investment_thesis", "label": "Investment Thesis", "score": 0, "max_score": 35, "sentiment": "positive|negative|neutral", "details": [""] },
      { "key": "promoter_activity", "label": "Promoter Activity", "score": 0, "max_score": 0, "sentiment": "positive|negative|neutral", "details": [""] }
    ],
    "scores": {
      "total": 0,
      "label": "",
      "dimensions": {
        "guidance_accuracy":  { "score": 0, "max": 40 },
        "red_flags":          { "score": 0, "max": 25 },
        "investment_thesis":  { "score": 0, "max": 35 },
        "promoter_activity":  { "score": 0, "max": 0, "penalty": 0 }
      }
    },
    "recommended_strategy": {
      "action": "",
      "thesis": "",
      "timing": null,
      "segment": null,
      "rationale": ""
    },
    "watchouts": [""]
  }
}`;

// ─── Output schema (stored in DB as Skill.outputSchema) ───────────────────────

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['guidance_vs_actuals', 'promoter_activity', 'red_flags', 'mqi_score', 'investment_thesis', 'management_intelligence'],
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
      required: ['shareholding', 'verdict', 'verdict_rationale', 'promoter_note', 'mqi_rationale'],
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
        mqi_rationale:     { type: 'string' },
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
          required: ['guidance_accuracy', 'red_flags', 'investment_thesis', 'promoter_activity'],
          properties: {
            guidance_accuracy: {
              type: 'object',
              required: ['score', 'max', 'rationale'],
              properties: {
                score:     { type: 'integer' },
                max:       { type: 'integer' },
                rationale: { type: 'string' },
              },
            },
            red_flags: {
              type: 'object',
              required: ['score', 'max', 'rationale'],
              properties: {
                score:     { type: 'integer' },
                max:       { type: 'integer' },
                rationale: { type: 'string' },
              },
            },
            investment_thesis: {
              type: 'object',
              required: ['score', 'max', 'rationale'],
              properties: {
                score:     { type: 'integer' },
                max:       { type: 'integer' },
                rationale: { type: 'string' },
              },
            },
            promoter_activity: {
              type: 'object',
              required: ['score', 'max', 'penalty', 'rationale'],
              properties: {
                score:     { type: 'integer' },
                max:       { type: 'integer' },
                penalty:   { type: 'integer' },
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
    management_intelligence: {
      type: 'object',
      required: ['key_takeaways', 'signals_breakdown', 'scores', 'recommended_strategy', 'watchouts'],
      properties: {
        key_takeaways: { type: 'array', items: { type: 'string' } },
        signals_breakdown: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'label', 'score', 'max_score', 'sentiment', 'details'],
            properties: {
              key:       { type: 'string' },
              label:     { type: 'string' },
              score:     { type: 'integer' },
              max_score: { type: 'integer' },
              sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
              details:   { type: 'array', items: { type: 'string' } },
            },
          },
        },
        scores: {
          type: 'object',
          required: ['total', 'label', 'dimensions'],
          properties: {
            total: { type: 'integer' },
            label: { type: 'string' },
            dimensions: {
              type: 'object',
              required: ['guidance_accuracy', 'red_flags', 'investment_thesis', 'promoter_activity'],
              properties: {
                guidance_accuracy: {
                  type: 'object',
                  required: ['score', 'max'],
                  properties: { score: { type: 'integer' }, max: { type: 'integer' } },
                },
                red_flags: {
                  type: 'object',
                  required: ['score', 'max'],
                  properties: { score: { type: 'integer' }, max: { type: 'integer' } },
                },
                investment_thesis: {
                  type: 'object',
                  required: ['score', 'max'],
                  properties: { score: { type: 'integer' }, max: { type: 'integer' } },
                },
                promoter_activity: {
                  type: 'object',
                  required: ['score', 'max', 'penalty'],
                  properties: {
                    score:   { type: 'integer' },
                    max:     { type: 'integer' },
                    penalty: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
        recommended_strategy: {
          type: 'object',
          required: ['action', 'thesis', 'rationale'],
          properties: {
            action:    { type: 'string' },
            thesis:    { type: 'string' },
            timing:    { type: ['string', 'null'] },
            segment:   { type: ['string', 'null'] },
            rationale: { type: 'string' },
          },
        },
        watchouts: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

// ─── Data block builder ───────────────────────────────────────────────────────

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

  if (kpiValues.length > 0) {
    lines.push('### KPI Values (source: transcript/PPT extraction)');
    lines.push('| Call ID | KPI | Value | Unit | Period Start | Period End |');
    lines.push('|---------|-----|-------|------|--------------|------------|');
    for (const k of kpiValues) {
      lines.push(`| ${k.callId} | ${k.kpi_abbr} | ${k.value ?? 'N/A'} | ${k.unit ?? ''} | ${k.start_date ?? ''} | ${k.end_date ?? ''} |`);
    }
    lines.push('');
  }

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
 * @param {string}      template            - DB promptTemplate (required — seed with PROMPT_TEMPLATE)
 * @param {string|null} defaultInstructions - DB defaultInstructions (injected at {{DEFAULT_INSTRUCTIONS}})
 */
function managementAnalysisPrompt(ticker, summaries, kpiValues, prowessValues, template, defaultInstructions = null) {
  if (!template) throw new Error('[managementAnalysisPrompt] template is required — seed Skill "management-analysis" in DB');

  const dataBlock = buildDataBlock(ticker, summaries, kpiValues, prowessValues);

  return template
    .replace('{{DATA_BLOCK}}', dataBlock)
    .replace('{{DEFAULT_INSTRUCTIONS}}', defaultInstructions ?? '');
}

module.exports = { managementAnalysisPrompt, buildDataBlock, PROMPT_TEMPLATE, OUTPUT_SCHEMA };
