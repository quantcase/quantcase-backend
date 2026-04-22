'use strict';

/**
 * Migration: split ofactor-industry into two skills
 *
 *  1. ofactor-industry      — non-BFSI companies (existing skill, cleaned up)
 *  2. ofactor-industry-bfsi — BFSI companies (new skill, kpi_metrics array)
 *
 * Run:  node prisma/migrations/migrate-ofactor-industry-bfsi.js
 */

const prisma = require('../../config/prisma');

// ─── Non-BFSI ─────────────────────────────────────────────────────────────────

const NON_BFSI_PROMPT_TEMPLATE = `You are a senior equity research analyst. Produce an industry overview for the {{INDUSTRY}} sector.

{{DATA_BLOCK}}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════════════

{{DEFAULT_INSTRUCTIONS}}

For ALL metrics values: always output a SINGLE specific number or label — never a range (e.g. "₹30,000–40,000 Cr" or "12–15%") and never a division (e.g. "Elecon / Triveni"). If you are uncertain, approximate using the midpoint or mean and state your basis in the _source field.

For metrics.industry_revenue_ttm: estimate total industry revenue (TTM) for the {{INDUSTRY}} sector using subject company revenue, peer data, and your knowledge. Express in a readable format (e.g. "₹4.2L Cr", "$180B"). Add a "change" field with the YoY % change (e.g. "+18.2% Q3 FY26"). Set sublabel to "" (empty). Put citation/methodology in the "_source" field instead.

For metrics.industry_cagr: provide three separate CAGR estimates for the industry revenue — "qoq" (quarter-on-quarter annualised), "one_year" (1Y CAGR), "three_year" (3Y CAGR). Each should be a single % string (e.g. "12.3%"). Use the revenue sparkline data and your knowledge of the sector. Set sublabel to "".

For metrics.current_opm: output a single OPM % value (e.g. "23%") and a "change" field in basis points (e.g. "+120bps Q3 FY26"). Use the EBIT/revenue sparkline above to derive the change. Set sublabel to "". Put any source/methodology in the "_source" field.

For metrics.industry_roce: use the ROCE trend above (last 4 Q4s) to populate "value" (latest, e.g. "24.8%") and "change" (YoY change in bps, e.g. "+180bps Q3 FY26"). Set sublabel to "". Put source notes in "_source".

For metrics.demand_signal and metrics.supply_constraint: sublabel must be ≤ 40 characters — a very short phrase (e.g. "India PV +19% YoY, EV tailwinds"). No long sentences.

Do NOT populate kpi_metrics — output it as an empty array [].

Populate the "final_scoring" field INSIDE the industry_overview JSON object (same level as "metrics"). Award points per check, max 25 total:
  1. Demand signal is "Strong" → metrics.demand_signal  [3 pts]
  2. Supply constraint is "Low" or "Moderate" (not High) → metrics.supply_constraint  [3 pts]
  3. Industry revenue TTM change is positive → metrics.industry_revenue_ttm.change  [2 pts]
  4. Industry CAGR 1Y > 10% → metrics.industry_cagr.one_year  [3 pts]
  5. Industry CAGR 3Y > 8% → metrics.industry_cagr.three_year  [3 pts]
  6. Operating margin ≥ 12% → metrics.current_opm.value  [3 pts]
  7. Operating margin YoY change is positive → metrics.current_opm.change  [2 pts]
  8. Industry ROCE ≥ 12% → metrics.industry_roce.value  [3 pts]
  9. Industry ROCE change is positive → metrics.industry_roce.change  [2 pts]
  10. OPM forward outlook is improving or stable → text.opm_trend.forward_outlook  [1 pt]
  status: score >= 18 → "FAVORABLE" (green), score 13–17 → "NEUTRAL" (yellow), score < 13 → "UNFAVORABLE" (red).

Also populate "signal_breakdown" inside final_scoring — an array of 8 objects, one per dimension. Each object: { "key", "label", "score" (0–25), "max_score": 25, "sentiment" ("positive"|"negative"|"neutral"), "details" (2–3 short bullet strings) }. Dimensions and scoring criteria:
  • PROFITABILITY (label: "Profitability") — ROCE level and trend. score 18–25: ROCE ≥ 15% and rising; 10–17: ROCE 10–15% or flat; 0–9: ROCE < 10% or falling.
  • MARGINS (label: "Margins") — OPM level and direction. score 18–25: OPM ≥ 15% and improving; 10–17: OPM 10–15% or stable; 0–9: OPM < 10% or declining.
  • GROWTH (label: "Growth") — Revenue CAGR trajectory. score 18–25: 1Y CAGR > 15%; 10–17: CAGR 8–15%; 0–9: CAGR < 8%.
  • DEMAND (label: "Demand") — Demand signal strength. score 18–25: Strong demand; 10–17: Moderate; 0–9: Weak.
  • SUPPLY (label: "Supply") — Supply constraint severity. score 18–25: Low constraint; 10–17: Moderate; 0–9: High constraint.
  • MARKET_STRUCTURE (label: "Market Structure") — Competitive structure, entry barriers, consolidation. score 18–25: oligopolistic, high barriers; 10–17: mixed/moderate; 0–9: fragmented, low barriers.
  • VALUATION_EARNINGS (label: "Valuation & Earnings Quality") — Earnings consistency, revenue quality, cash conversion. score 18–25: consistent earnings, high cash conversion; 10–17: moderate; 0–9: volatile earnings or poor conversion.
  • MANAGEMENT_QUALITY (label: "Management Quality") — Management guidance reliability, execution track record from transcripts. score 18–25: strong execution, guidance met; 10–17: mixed; 0–9: guidance misses, poor visibility.
  sentiment: "positive" if score ≥ 18, "negative" if score ≤ 9, else "neutral".
  details: 2–3 concise bullet strings, each ≤ 15 words, citing specific data points from the analysis.

Return ONLY valid JSON per the output schema. Use null where data is unavailable. No markdown fences.`;

const NON_BFSI_OUTPUT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'ofactor_industry',
    strict: false,
    schema: {
      type: 'object',
      required: ['industry_overview'],
      properties: {
        industry_overview: {
          type: 'object',
          required: ['text', 'metrics', 'final_scoring'],
          properties: {
            meta: { type: 'object' },
            kpi_metrics: { type: 'array', items: { type: 'object' } },
            text: {
              type: 'object',
              required: ['takeaway'],
              properties: {
                takeaway:               { type: 'string' },
                opm_trend:              { type: 'object' },
                industry_transcripts:   { type: 'array' },
                demand_supply_dynamics: { type: 'object' },
              },
            },
            metrics: {
              type: 'object',
              properties: {
                industry_revenue_ttm: {
                  type: 'object',
                  properties: {
                    label:    { type: 'string' },
                    value:    { type: ['string', 'null'] },
                    change:   { type: ['string', 'null'] },
                    _source:  { type: 'string' },
                    sublabel: { type: 'string' },
                  },
                },
                industry_cagr: { type: 'object' },
                current_opm: {
                  type: 'object',
                  properties: {
                    label:    { type: 'string' },
                    value:    { type: ['string', 'null'] },
                    change:   { type: ['string', 'null'] },
                    _source:  { type: 'string' },
                    sublabel: { type: 'string' },
                  },
                },
                industry_roce: {
                  type: 'object',
                  properties: {
                    label:    { type: 'string' },
                    value:    { type: ['string', 'null'] },
                    change:   { type: ['string', 'null'] },
                    _source:  { type: 'string' },
                    sublabel: { type: 'string' },
                  },
                },
                demand_signal: {
                  type: 'object',
                  properties: {
                    label:    { type: 'string' },
                    value:    { type: ['string', 'null'] },
                    sublabel: { type: 'string' },
                  },
                },
                supply_constraint: {
                  type: 'object',
                  properties: {
                    label:    { type: 'string' },
                    value:    { type: ['string', 'null'] },
                    sublabel: { type: 'string' },
                  },
                },
              },
            },
            final_scoring: {
              type: 'object',
              required: ['score', 'status', 'status_color'],
              properties: {
                score:        { type: 'number' },
                max_score:    { type: 'number' },
                status:       { type: 'string' },
                status_color: { type: 'string', enum: ['green', 'yellow', 'red'] },
                title:        { type: 'string' },
                body:         { type: 'string' },
                signal_breakdown: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['key', 'label', 'score', 'max_score', 'sentiment', 'details'],
                    properties: {
                      key:       { type: 'string' },
                      label:     { type: 'string' },
                      score:     { type: 'number' },
                      max_score: { type: 'number' },
                      sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
                      details:   { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// ─── BFSI ─────────────────────────────────────────────────────────────────────

const BFSI_PROMPT_TEMPLATE = `You are a senior equity research analyst. Produce an industry overview for the {{INDUSTRY}} sector (BFSI).

{{DATA_BLOCK}}

══════════════════════════════════════════════════════════
C. ANALYSIS INSTRUCTIONS
══════════════════════════════════════════════════════════

{{DEFAULT_INSTRUCTIONS}}

For ALL metric values: always output a SINGLE specific number or label — never a range. If uncertain, approximate using the midpoint and note your basis.

Populate kpi_metrics as an array of exactly 8 objects, each: { "label": string, "value": string|null, "change": string|null }.
Cover these banking/NBFC industry KPIs in order:
  1. "Credit Growth YoY"     — industry-level loan/advance growth YoY (e.g. "~12%"),     change = trend note (e.g. "▲ PSBs outpacing PVBs")
  2. "Deposit Growth YoY"    — industry deposit growth YoY (e.g. "~10%"),               change = assessment (e.g. "→ Adequate but competitive")
  3. "Avg GNPA"              — sector average Gross NPA % (e.g. "2.2%"),               change = direction (e.g. "▼ Multi-year lows")
  4. "Avg Net NPA"           — sector average Net NPA % (e.g. "0.42%"),               change = direction (e.g. "▼ Record clean books")
  5. "Combined Sector Profit"— aggregate sector PAT for the latest period (e.g. "₹52,603 Cr"), change = YoY growth (e.g. "▲ 18% YoY")
  6. "FY Profit Track"       — full-year profit trajectory (e.g. "₹2L Cr+"),          change = milestone note (e.g. "▲ Historic first")
  7. "Avg ROE"               — sector average ROE (e.g. "~14%"),                       change = context (e.g. "▲ Well above CoE")
  8. "Avg NIM"               — sector average Net Interest Margin (e.g. "~3.0%"),     change = direction (e.g. "→ Slight compression")
Use data from the transcripts and financial snapshot above. Approximate where needed.

Do NOT populate industry_revenue_ttm, industry_cagr, current_opm, or industry_roce — set them all to null.

For metrics.demand_signal and metrics.supply_constraint: sublabel must be ≤ 40 characters.

Populate the "final_scoring" field INSIDE the industry_overview JSON object. Award points per check, max 25 total:
  1. demand_signal = "Strong"  [3 pts]
  2. supply_constraint = "Low" or "Moderate"  [3 pts]
  3. Credit Growth YoY > 10%  [3 pts]
  4. Avg GNPA < 3%  [3 pts]
  5. Avg Net NPA < 1%  [3 pts]
  6. Combined Sector Profit growth > 10%  [2 pts]
  7. Avg ROE > 12%  [2 pts]
  8. Avg NIM > 2.5%  [2 pts]
  9. Deposit Growth YoY > 8%  [2 pts]
  10. text.demand_supply_dynamics.net_impact is positive  [2 pts]
  status: score >= 18 → "FAVORABLE" (green), score 13–17 → "NEUTRAL" (yellow), score < 13 → "UNFAVORABLE" (red).

Also populate "signal_breakdown" inside final_scoring — an array of 8 objects, one per dimension. Each: { "key", "label", "score" (0–25), "max_score": 25, "sentiment" ("positive"|"negative"|"neutral"), "details" (2–3 short bullet strings ≤ 15 words) }. Dimensions:
  • PROFITABILITY    — ROE and ROA levels and trend
  • MARGINS         — NIM trend and compression risk
  • GROWTH          — Credit and deposit growth trajectory
  • DEMAND          — Demand signal strength (credit offtake, loan enquiries)
  • SUPPLY          — Deposit availability, funding cost pressure
  • MARKET_STRUCTURE— Concentration, PSB vs PVB dynamics, RBI regulatory environment
  • VALUATION_EARNINGS — NPA trajectory, earnings consistency, provisioning
  • MANAGEMENT_QUALITY — Guidance reliability, execution track record from transcripts
  sentiment: "positive" if score ≥ 18, "negative" if score ≤ 9, else "neutral".

Return ONLY valid JSON per the output schema. Use null where data is unavailable. No markdown fences.`;

const BFSI_DEFAULT_INSTRUCTIONS = `From ALL transcripts (subject + peer), identify:
  • What is the credit demand environment — retail, MSME, corporate?
  • Are NIMs expanding, stable, or compressing? What is management guiding?
  • How is the asset quality trending — GNPA, SLMA, restructured book?
  • What are the key systemic risks (RBI regulations, liquidity, rate cycle)?
  • Is deposit mobilisation keeping pace with loan growth?
Populate with short and crisp points.

Output length guidelines:
  • text.takeaway — ONE punchy sentence, 15 words max. Example: "Strong credit growth, NIM stable, NPA at multi-year lows"
  • text.demand_supply_dynamics.demand, .supply — 4–6 bullet points each, 20 words max per point
  • text.demand_supply_dynamics.net_impact — short thesis narrative in 30 words max`;

const BFSI_OUTPUT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'ofactor_industry_bfsi',
    strict: false,
    schema: {
      type: 'object',
      required: ['industry_overview'],
      properties: {
        industry_overview: {
          type: 'object',
          required: ['text', 'kpi_metrics', 'metrics', 'final_scoring'],
          properties: {
            meta: { type: 'object' },
            kpi_metrics: {
              type: 'array',
              items: {
                type: 'object',
                required: ['label', 'value', 'change'],
                properties: {
                  label:  { type: 'string' },
                  value:  { type: ['string', 'null'] },
                  change: { type: ['string', 'null'] },
                },
              },
            },
            text: {
              type: 'object',
              required: ['takeaway'],
              properties: {
                takeaway:               { type: 'string' },
                industry_transcripts:   { type: 'array' },
                demand_supply_dynamics: { type: 'object' },
              },
            },
            metrics: {
              type: 'object',
              properties: {
                industry_revenue_ttm: { type: ['object', 'null'] },
                industry_cagr:        { type: ['object', 'null'] },
                current_opm:          { type: ['object', 'null'] },
                industry_roce:        { type: ['object', 'null'] },
                demand_signal: {
                  type: 'object',
                  properties: {
                    label:    { type: 'string' },
                    value:    { type: ['string', 'null'] },
                    sublabel: { type: 'string' },
                  },
                },
                supply_constraint: {
                  type: 'object',
                  properties: {
                    label:    { type: 'string' },
                    value:    { type: ['string', 'null'] },
                    sublabel: { type: 'string' },
                  },
                },
              },
            },
            final_scoring: {
              type: 'object',
              required: ['score', 'status', 'status_color'],
              properties: {
                score:        { type: 'number' },
                max_score:    { type: 'number' },
                status:       { type: 'string' },
                status_color: { type: 'string', enum: ['green', 'yellow', 'red'] },
                title:        { type: 'string' },
                body:         { type: 'string' },
                signal_breakdown: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['key', 'label', 'score', 'max_score', 'sentiment', 'details'],
                    properties: {
                      key:       { type: 'string' },
                      label:     { type: 'string' },
                      score:     { type: 'number' },
                      max_score: { type: 'number' },
                      sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
                      details:   { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  // 1. Update ofactor-industry (non-BFSI) — clean up hardcoded BFSI references
  const existing = await prisma.skill.findUnique({ where: { slug: 'ofactor-industry' } });
  if (!existing) throw new Error('ofactor-industry skill not found in DB');

  await prisma.skill.update({
    where: { slug: 'ofactor-industry' },
    data: {
      promptTemplate: NON_BFSI_PROMPT_TEMPLATE,
      outputSchema:   NON_BFSI_OUTPUT_SCHEMA,
    },
  });
  console.log('✓ Updated ofactor-industry (non-BFSI)');

  // 2. Create ofactor-industry-bfsi skill
  await prisma.skill.upsert({
    where: { slug: 'ofactor-industry-bfsi' },
    update: {
      promptTemplate:      BFSI_PROMPT_TEMPLATE,
      defaultInstructions: BFSI_DEFAULT_INSTRUCTIONS,
      outputSchema:        BFSI_OUTPUT_SCHEMA,
    },
    create: {
      slug:                'ofactor-industry-bfsi',
      name:                'Opportunity Factor Industry (BFSI)',
      description:         'Industry overview for BFSI companies — outputs kpi_metrics array instead of named OPM/ROCE metrics',
      promptKey:           'ofactor-industry-bfsi',
      model:               existing.model,
      maxTokens:           existing.maxTokens,
      isActive:            true,
      promptTemplate:      BFSI_PROMPT_TEMPLATE,
      defaultInstructions: BFSI_DEFAULT_INSTRUCTIONS,
      outputSchema:        BFSI_OUTPUT_SCHEMA,
    },
  });
  console.log('✓ Upserted ofactor-industry-bfsi (BFSI)');

  console.log('\nDone. Update workers/ofactor.js SECTION_TO_SKILL to route by bfsi flag:');
  console.log("  industry: bfsi ? 'ofactor-industry-bfsi' : 'ofactor-industry'");
}

run()
  .catch(err => { console.error('Migration failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
