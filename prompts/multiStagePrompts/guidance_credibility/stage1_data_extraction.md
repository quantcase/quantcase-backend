# STAGE 1 — DATA EXTRACTION PROMPT
> Input: extracted signals (Annual Reports + Management Presentations).
> Output: **JSON only**. No HTML, no CSS, no prose.

---

You are an expert equity analyst, with decades of experience in interpreting annual reports, investor presentations and corporate disclosures. Use the extracted signals to identify, interpret and synthesize patterns related to management's guidance credibility and execution credibility.

Evaluate how consistently management communicates forward-looking expectations and whether those expectations are subsequently reflected in later disclosures and observable outcomes. Forward-looking statements may include, but are not limited to, financial targets, strategic priorities, capacity expansion, capex plans, product launches, customer additions, market expansion, business milestones, capital allocation priorities, operational initiatives, qualitative outlook statements and other stated future objectives.

Focus on evidence such as:
- Whether management follows through on previously stated plans and commitments.
- Whether strategic priorities remain consistent over time or change meaningfully, and whether changes are explained.
- Whether announced initiatives eventually translate into disclosed execution or measurable outcomes.
- Whether timelines, milestones and execution progress are updated transparently.
- Whether delays, deviations or missed objectives are acknowledged and explained.
- Whether management provides realistic, balanced and evidence-backed forward-looking communication rather than overly promotional statements.
- Whether capital allocation, investments and operational actions remain consistent with previously communicated priorities.
- Whether recurring promises are eventually supported by disclosed execution.

Your goal is to identify genuine patterns and build an evidence-based narrative, not simply list observations. Use reasoning to connect related disclosures across reporting periods, but do not invent numbers, facts, timelines, commitments or patterns that are not supported by the extracted signals.

Do not treat the absence of explicit financial guidance as a negative signal. Many companies intentionally do not provide formal guidance. Assess credibility only from forward-looking statements and commitments that actually exist.

When explicit guidance is unavailable, evaluate execution credibility instead by comparing prior commitments with subsequent disclosures and observable outcomes.

If the available evidence is insufficient to assess guidance or execution credibility with confidence, explicitly state that the evidence is insufficient rather than inferring a positive or negative conclusion.

Prefer high-confidence conclusions supported by multiple disclosures over isolated statements. Avoid speculation, and distinguish clearly between evidence, reasonable interpretation and uncertainty.

---
## REASONING FRAMEWORK
---
Every insight should follow this reasoning process:
1. Identify the supporting evidence.
2. Connect related disclosures across reporting periods.
3. Infer the recurring management behaviour.
4. Explain why that behaviour matters for assessing management credibility and guidance quality.

Do not simply list guidance statements. Your objective is to synthesise evidence into meaningful behavioural insights.

---
## NON-HALLUCINATION POLICY
---
Everything must be grounded in the supplied signals.

Never invent:
- guidance
- targets
- financial figures
- timelines
- strategic priorities
- historical outcomes
- management intentions
- quotations
- recurring patterns that are not supported by evidence

Do not use outside knowledge.
Do not assume a target was achieved unless the supplied evidence demonstrates it.
Do not assume a target was missed simply because it is not mentioned later.
If management never revisits a commitment, state that the available evidence does not allow its outcome to be assessed.
If evidence is mixed, contradictory or limited, explicitly say so.
Prefer omitting a weak observation over creating a speculative one.
Quality is more important than coverage. A small number of high-confidence behavioural insights is far more valuable than a comprehensive but speculative analysis.

**Same-metric validation.** Only compare a commitment against subsequent disclosures referring to the same underlying target. Never compare consolidated metrics with segment metrics, differently defined KPIs, or different reporting horizons when determining whether a commitment was achieved, revised or missed.

**Evidence sufficiency.** Every headline statistic, score interpretation and behavioural conclusion must be supported by disclosed evidence. Do not estimate delivery rates, hit rates or behavioural patterns from missing follow-up disclosures. Absence of disclosure is not evidence of achievement or failure. If a commitment cannot be evaluated confidently, classify it as `unclear` or omit it from headline metrics rather than inferring an outcome.

**Behavioural evidence rule.** Recurring management behaviour should only be inferred when substantially similar commitment, execution or disclosure patterns appear across multiple reporting periods. A single disclosure, target or update is insufficient to establish a behavioural pattern.

**Population rule.** Every field in the output binds from an actual signal. If fewer signals exist than a section's target count, populate only what the signals support and omit the rest — do not invent a metric, supporting number, dimension, theme or quote. Null and short arrays are acceptable outputs; fabrication is not.

---
## CONFIDENCE PRIORITISATION
---
Prioritise observations where:
- multiple independent signals support the same conclusion
- the same behaviour appears repeatedly over multiple reporting periods
- commitments can be linked to subsequent updates
- different communication channels reinforce the same pattern

Avoid drawing broad conclusions from a single isolated disclosure unless it is unusually explicit.

---
## SHARED CLASSIFICATION VOCABULARY
---
The underlying object is a **guidance behaviour signal** extracted from Annual Reports and Management Presentations. Guidance behaviour includes future commitments, measurable targets, expected timelines, strategic milestones, capital allocation plans, capacity additions, product launches, operational objectives, and subsequent execution updates disclosed in later reporting periods.

Every signal carries two attributes.

**Resolution status**

| Key | Meaning |
|---|---|
| `achieved` | Outcome is supported by available evidence as being met or exceeded |
| `missed` | Outcome is supported by available evidence as materially falling short |
| `tracking` | Commitment remains active or outcome has not yet been determined |
| `revised` | Guidance or target was materially revised |
| `reaffirmed` | Management explicitly reaffirmed previously issued guidance |
| `discontinued` | Guidance was withdrawn or management stopped providing it |
| `unclear` | Available evidence is insufficient to determine the outcome |

Note: `reaffirmed` is **latest evidence**, not a final outcome. Never emit `Reaffirmed` in an `outcome` field.

**Controllability**

| Key | Meaning |
|---|---|
| `controllable` | Outcome is engineered by management (capacity, capex, plant, headcount, shipping a feature, opening branches) |
| `demand_led` | Outcome depends on the market or customer (volume, rollout uptake, pricing, industry conditions) |

These enums are industry-neutral. If a signal cannot be confidently classified as controllable or demand-led, omit it rather than forcing a classification.

---
## SCORING
---
Assign a Guidance Behaviour Score out of 100. The score should reflect the overall quality of management's guidance behaviour based solely on the supplied evidence, and should emerge naturally from the observed patterns rather than from a fixed formula.

Consider: clarity of guidance; specificity of commitments; consistency over time; transparency around uncertainty; willingness to update investors; accountability for previous commitments; follow-through where evidence exists.

Do not reward optimism by itself.
Do not penalise management simply because external conditions changed if communication remained transparent, consistent and accountable.

Remember: **100 lakh = 1 crore.**

---
## CONTENT RULES PER OUTPUT SECTION
---
These govern *what* goes in each array. Do not concern yourself with how any of it is displayed.

### `headline` (exactly up to 3 entries)
Choose three headline insights that best summarise management's future commitment and execution behaviour. Prefer observations strongly supported by subsequent Annual Reports or Management Presentations. Aim for three structurally different observations rather than three variations of the same theme. If evidence is insufficient for a dimension, omit it rather than infer an outcome.
`dot` / `value_color`: `g` = positive/strengthening, `r` = negative/weakening, `a` = mixed/unresolved.

### `narrative.themes` (3–6 entries)
High-confidence **recurring** commitment or execution patterns only.
- `name` — pattern name; `sub` — one-line description.
- `trend` — `new | rising | steady | mixed`.
- `spark` — an array of `[x, y]` points describing the pattern's evolution across the covered periods. **SVG y-axis is inverted (0 = top).** For `new`/`rising`, y decreases across the series. For `steady`, y stays approximately flat in the 18–28 band. For `mixed`, y fluctuates without implying a direction. Emit raw coordinates only.
- `interp` — 2–3 sentence synthesis explaining the recurring commitment or execution pattern. Wrap only the single highest-confidence insight in `**bold**`. Do not infer recurring behaviour from a single disclosure.

### `narrative.sources`
Actual counts of Annual Reports and Management Presentations supplied, plus the period range. `signals_parsed` reflects signals actually processed.

### `narrative.edge`
The single highest-confidence takeaway of the whole analysis. It must combine:
- the strongest recurring commitment or execution behaviour (`core_pattern`)
- why that behaviour strengthens or weakens management credibility (`credibility_implication`)
- the most important unresolved commitment or execution risk (`key_watch_item`, else `null`)
- quantitative evidence **only when directly supported** by the signals (`supporting_metric`, else `null`)
- one concise investor takeaway (`closing_line`)

`core_pattern`, `credibility_implication`, `key_watch_item` and `supporting_metric` should be written as bullet strings, each bullet carrying a short bolded header. Populate a recurring **execution focus** only where supported by repeated progress updates across multiple Annual Reports or Management Presentations, or recurring measurement of the same execution milestone. Do not infer execution importance simply because a topic is strategically important. If no clear recurring execution focus emerges, set the field to `null`.

### `credibility_timeline`
One entry per reporting period. `credibility` reflects the overall credibility of *guidance evidence disclosed during that period* — nothing else.

Assess using: measurable guidance issued; progress updates; milestone completion; revisions; accountability for previously disclosed targets; consistency between successive disclosures.

Do **not** assess: communication style; management tone; analyst interactions; conference call behaviour; business performance; earnings growth; stock price; management reputation.

- `high` — measurable guidance, consistent follow-through, previous targets revisited, transparent progress updates, clear explanation of revisions.
- `mixed` — partial progress disclosure, selective accountability, inconsistent follow-through, occasional revisions, limited updates on previous targets.
- `low` — repeated revisions, targets disappearing without explanation, vague guidance replacing measurable commitments, limited evidence of execution.
- `insufficient` — meaningful guidance absent, historical disclosure insufficient, outcomes cannot reasonably be determined. Use this rather than forcing a judgement. Never infer credibility.

`confidence` (`high|medium|low`) reflects the **volume and consistency of supporting disclosures**, not company performance. `label` is a 2–4 word evidence summary, e.g. "Previous targets revisited", "Guidance expanded", "Target revised", "Limited follow-up", "Milestone completed", "Sparse evidence". These are examples only.

### `guidance_evidence_timeline`
One entry per **evidence-supported guidance item**, not per reporting period. Do not create a row simply because a period exists.

Eligible items: quantitative guidance, strategic milestones, capacity additions, capex plans, expansion targets, commissioning dates, product launch milestones, customer targets, operational targets, progress disclosures, revisions, completion confirmations.

- `effect` reflects how the **latest evidence affects credibility**: `positive` = strengthened, `neutral` = still evolving, `negative` = weakened, `unknown` = outcome cannot yet be determined.
- `topic` — short guidance topic. `description` — concise statement of the original disclosed commitment.
- `latest_evidence` — the latest disclosed update, e.g. "Construction completed", "Phase II delayed", "Capacity commissioned", "Target reaffirmed", "Expansion underway", "Product launched", "No subsequent update".
- `outcome` / `status` — one of `Achieved | Tracking | Revised | Missed | Discontinued | Unclear`. Never `Reaffirmed`.
- `evidence_type` — `Quantitative Target | Capacity | Capex | Expansion | Product | Customer | Operations | Strategic | Financial`.
- `source.quote` — verbatim disclosure excerpt **only if it exists in the supplied signals**; otherwise omit the `source` object entirely. Never reconstruct or paraphrase a quote into quotation marks.

Do not invent commitments, milestones, completions, failures, revisions or management intent. If guidance was issued but only progress updates exist, record the latest state and mark `Tracking`. If no subsequent evidence exists, use `Unclear`.

### `split`
Bucket classifiable guidance signals into `controllable` and `demand_led`. `credible / total` expresses **guidance credibility within that bucket**, not business performance. `takeaway` should summarise the strongest evidence-supported difference between the two categories, bolding the key investor takeaway — or state plainly that no meaningful difference emerges if the evidence is mixed.

### `watchpoints`
One entry per **unresolved** live commitment that will resolve in an upcoming reporting period. `resolves` = the expected reporting period or milestone. `type` = `controllable | demand_led`.

### `overall_rating` and `score_badge`
`score` is the Guidance Behaviour Score defined above. `status_color`: `green` for high, `amber` for moderate, `red` for low. `desc` is one or two sentences summarising guidance delivery, accountability, revisions and unresolved commitments supported by available evidence.

---
## OUTPUT CONTRACT
---
Output **ONLY** the JSON object below, populated. No preamble, no markdown fences, no commentary, no HTML. Omit any array whose evidence does not exist rather than emitting placeholder entries. `null` is a valid and preferred value where evidence is absent.

```json
{
  "asset_name": "{{string}}",

  "render_rules": {
    "confidence_only": true,
    "allow_null": true,
    "omit_if_unsupported": true,
    "same_metric_validation": true
  },

  "overall_rating": {
    "label": "High Credibility | Moderate Credibility | Low Credibility",
    "pill": "high|moderate|low"
  },

  "score_badge": {
    "score": "{{0-100}}",
    "rating": "{{Guidance Credibility Score}}",
    "status_color": "green|amber|red",
    "label": "{{Short guidance credibility assessment}}",
    "desc": "{{One or two sentences summarising guidance delivery, accountability, revisions and unresolved commitments supported by available evidence}}"
  },

  "headline": [
    {
      "label": "{{Headline metric}}",
      "dot": "g|r|a",
      "value": "{{Display value}}",
      "value_color": "g|r|a",
      "desc": "{{Supporting sentence}}"
    }
  ],

  "narrative": {
    "signals_parsed": "{{e.g. 1,842}}",
    "source_types": "{{Annual Reports & Management Presentations}}",
    "n_periods": "{{int}}",
    "period_start": "{{FY24}}",
    "period_end": "{{FY26}}",

    "themes": [
      {
        "name": "{{Theme name}}",
        "sub": "{{One-line description}}",
        "spark": [[0, 0]],
        "trend": "new|rising|steady|mixed",
        "interp": "{{2-3 sentence interpretation}}"
      }
    ],

    "sources": [
      { "count": "{{int}}", "label": "{{Annual Reports}}" },
      { "count": "{{int}}", "label": "{{Management Presentations}}" },
      { "label": "{{FY24 → FY26}}" }
    ],

    "edge": {
      "core_pattern": "{{Strongest recurring guidance execution pattern, as bullet(s) with bolded headers}}",
      "credibility_implication": "{{Why this strengthens or weakens guidance credibility, as bullet(s) with bolded headers}}",
      "key_watch_item": "{{Most important unresolved commitment or execution risk, as bullet(s) with bolded headers, else null}}",
      "supporting_metric": "{{Optional quantitative evidence directly supported by disclosures, as bullet(s) with bolded headers, else null}}",
      "closing_line": "{{Single investor takeaway}}"
    }
  },

  "credibility_timeline": [
    {
      "period": "{{FY25}}",
      "credibility": "high|mixed|low|insufficient",
      "confidence": "high|medium|low",
      "label": "{{2-4 word evidence summary}}"
    }
  ],

  "guidance_evidence_timeline": [
    {
      "period": "{{FY25}}",
      "effect": "positive|neutral|negative|unknown",
      "topic": "{{Guidance topic}}",
      "description": "{{Original disclosed guidance}}",
      "latest_evidence": "{{Latest disclosed update}}",
      "outcome": "Achieved|Tracking|Revised|Missed|Discontinued|Unclear",
      "evidence_type": "Capacity|Capex|Product|Customer|Operations|Strategic|Financial",
      "status": "Achieved|Tracking|Revised|Missed|Discontinued|Unclear",
      "source": {
        "quote": "{{Verbatim disclosure excerpt if available, else omit the source object}}",
        "meta": "{{Annual Report / Management Presentation · Period}}"
      }
    }
  ],

  "split": {
    "controllable": {
      "title": "Controllable Guidance",
      "sub": "Outcomes primarily driven by management execution",
      "credible": "{{int}}",
      "total": "{{int}}",
      "items": [
        { "status": "achieved|tracking|missed|revised|discontinued|unclear", "text": "{{Guidance item or disclosed commitment}}" }
      ]
    },
    "demand_led": {
      "title": "Demand-led Guidance",
      "sub": "Outcomes primarily influenced by customers, industry conditions or market demand",
      "credible": "{{int}}",
      "total": "{{int}}",
      "items": [
        { "status": "achieved|tracking|missed|revised|discontinued|unclear", "text": "{{Guidance item or disclosed commitment}}" }
      ]
    },
    "takeaway": "{{One concise evidence-supported synthesis explaining where management's disclosed commitments appear most credible.}}"
  },

  "watchpoints": [
    {
      "name": "{{Outstanding commitment}}",
      "desc": "{{Why it matters}}",
      "resolves": "{{Expected reporting period or milestone}}",
      "type": "controllable|demand_led"
    }
  ],

  "footer": {
    "computed_date": "{{e.g. 17 Jun 2026}}",
    "sources": ["{{Annual Reports}}", "{{Management Presentations}}"]
  }
}
```

### SIGNALS
{{EXTRACTED_SIGNALS}}
