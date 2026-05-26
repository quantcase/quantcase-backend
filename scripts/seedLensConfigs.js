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
const MAX_TOKENS = 8000;

const LENS_CONFIGS = [
  // ── Management lenses ────────────────────────────────────────────────────────
  {
    slug:         'guidance-credibility',
    name:         'Guidance Credibility',
    category:     'management',
    description:  'How consistently management delivers on its forward-looking promises',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:      ['milestone', 'governance'],
        metric_family:     ['milestone', 'governance'],
        include_historical: true,
      },
      weights: [
        { metric: 'guidance_given',       w: 0.5 },
        { metric: 'guidance_missed',      w: -0.8 },
        { metric: 'proactive_disclosure', w: 0.3 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  {
    slug:        'capital-allocation',
    name:        'Capital Allocation Quality',
    category:    'management',
    description: 'Discipline in deploying capital — capex returns, debt management, FCF generation',
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'financial_health'],
        metric_family: ['capital', 'profitability', 'growth'],
      },
      weights: [
        { metric: 'CFO',      w: 0.25, b: 0 },
        { metric: 'DEBT_LT',  w: -0.2, b: 0 },
        { metric: 'ASSET_PPE',w: 0.15, b: 0 },
        { metric: 'EBITDA',   w: 0.2,  b: 0 },
        { metric: 'CAPEX',    w: 0.2,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  {
    slug:         'disclosure-honesty',
    name:         'Disclosure Honesty',
    category:     'management',
    description:  'Transparency and candour of management disclosures — proactive vs defensive communication',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:      ['governance'],
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
      prompt_template: null,
    },
  },
  {
    slug:         'promoter-activity',
    name:         'Promoter Activity',
    category:     'management',
    description:  'Promoter shareholding trends, pledging, and insider confidence signals',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:      ['governance'],
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
      prompt_template: null,
    },
  },
  // ── Opportunity lenses ───────────────────────────────────────────────────────
  {
    slug:        'industry-analysis',
    name:        'Industry Analysis',
    category:    'opportunity',
    description: 'Demand/supply dynamics and structural positioning within the industry',
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'industry'],
        metric_family: ['industry', 'growth'],
      },
      weights: [
        { metric: 'REV_OP',        w: 0.4,  b: 0 },
        { metric: 'EBITDA_MARGIN', w: 0.3,  b: 0 },
        { metric: 'TOTAL_INCOME',  w: 0.1,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  {
    slug:        'competition',
    name:        'Competition',
    category:    'opportunity',
    description: 'Market moat, pricing power, and competitive differentiation vs peers',
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'industry'],
        metric_family: ['growth', 'industry', 'profitability'],
      },
      weights: [
        { metric: 'EBITDA_MARGIN', w: 0.35, b: 0 },
        { metric: 'PAT',           w: 0.2,  b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  {
    slug:        'financial-strength',
    name:        'Financial Strength',
    category:    'opportunity',
    description: 'Balance sheet strength, FCF generation, and margin quality',
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'financial_health'],
        metric_family: ['profitability', 'capital', 'growth'],
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
      prompt_template: null,
    },
  },
  {
    slug:        'customer-distribution',
    name:        'Customer & Distribution',
    category:    'opportunity',
    description: 'Client base growth, channel quality, and revenue concentration risk',
    config: {
      signal_filters: {
        signal_types:  ['kpi', 'customer'],
        metric_family: ['customer', 'growth'],
      },
      weights: [
        { metric: 'REV_OP', w: 0.35, b: 0 },
      ],
      aggregation:     'weighted_sum',
      model:           HAIKU,
      max_tokens:      MAX_TOKENS,
      prompt_template: null,
    },
  },
  // ── Deal lenses ──────────────────────────────────────────────────────────────
  {
    slug:         'earnings-forecast',
    name:         'Earnings Forecast',
    category:     'deal',
    description:  'Scenario-based earnings forecast — bull/base/bear EPS trajectory driven by revenue growth, margin expansion, and volume-mix dynamics',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'financial_health', 'milestone'],
        metric_family:      ['profitability', 'growth', 'capital'],
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
      prompt_template: `Output a 3-column (Bull / Base / Bear), 5-row scenario matrix. Rows: (1) Scenario Condition/Assumptions, (2) Industry Growth CAGR (3Y), (3) Company Revenue CAGR (3Y), (4) Margin Assumption, (5) Earnings/PAT CAGR (3Y). For every number include a one-line "because" rationale.

Rules:
1. Industry Growth CAGR — Use historical industry CAGR from signals as the base anchor.
   Bull: Historical CAGR × 1.15–1.3 (sector tailwinds, capacity utilisation rising).
   Base: Historical CAGR (steady-state, no structural shift).
   Bear: Historical CAGR × 0.6–0.8 (demand slowdown, pricing pressure).

2. Company Revenue CAGR — Start with the industry CAGR and adjust for market share movement, drawing on management revenue guidance, order book commentary, and new segment signals.
   Bull: Industry CAGR + 50–100 bps market share gain.
   Base: Management-guided revenue growth (cite the specific guidance signal).
   Bear: Industry CAGR − 50–100 bps market share loss.

3. Margin Assumptions — Use the adjusted last-4-quarter average EBITDA_MARGIN as the base. Cite the primary margin driver (operating leverage / pricing power / input costs / utilisation).
   Bull: Margin expansion from operating leverage, pricing power, or lower input costs.
   Base: Flat margins, in line with recent trend.
   Bear: Margin compression from cost pressure, lower utilisation, or competitive pricing.

4. Earnings / PAT CAGR — Project using the waterfall:
   Future Revenue = Current REV_OP × (1 + Revenue CAGR)^3
   Future EBITDA  = Future Revenue × Scenario Margin %
   Future PAT     = Future EBITDA − Historical Interest (proxy: DEBT_LT × avg rate) − Depreciation (from signals) − Tax (effective rate from signals)
   PAT CAGR       = CAGR(Current PAT → Future PAT, 3Y)
   Show the arithmetic step-by-step in the "because" statement. If any input is unavailable, state the assumption explicitly.`,
    },
  },
  {
    slug:         'earning-quality',
    name:         'Earning Quality',
    category:     'deal',
    description:  'EPS growth trajectory and quality — company vs industry, beat rate, consistency score, and growth trend over rolling 5-year window',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'financial_health'],
        metric_family:      ['profitability', 'growth', 'capital'],
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
      prompt_template: `Output a table with exactly 5 rows: Cash Conversion Quality, Revenue Quality, Margin Authenticity, Non-Operating/One-Time Dependence, Provisioning & Accounting Quality. For each row provide: Verdict (Strong/Neutral/Weak), 2-3 line reasoning, key supporting metrics/signals, and red flags if any.

Rules:
1. Cash Conversion Quality — Assess whether PAT converts to real cash using CFO/PAT ratio and FCF (CFO minus CAPEX). Flag as Weak if CFO/PAT <0.5x for 2+ consecutive periods. Benchmark: >0.8x is healthy.
2. Revenue Quality — Assess whether revenue is recurring, diversified, and organically driven. Look for customer concentration risk, segment mix shifts, and acquisition-driven vs organic growth signals.
3. Margin Authenticity — Check if margin expansion is operational or driven by one-offs (cost deferrals, reclassification, temporary efficiencies, unusually low COGS/opex). Use EBITDA_MARGIN trend.
4. Non-Operating/One-Time Dependence — Evaluate how much PBT/PAT depends on other income, exceptional items, or tax distortions. Flag as Weak if other income >25% of PBT or exceptional items are large.
5. Provisioning & Accounting Quality — Assess whether risks are conservatively recognised using depreciation trends (D&A % of gross block), provisions, write-offs, and deferred tax signals. For BFSI use PCR trends.`,
    },
  },
  {
    slug:         'pe-rerating-potential',
    name:         'P/E Re-Rating Potential',
    category:     'deal',
    description:  'Likelihood of multiple expansion driven by improving fundamentals, guidance clarity, and sector tailwinds',
    force_config: true,
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'financial_health', 'milestone', 'governance'],
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
      prompt_template: `Output the following sections:

1. INDUSTRY VALUATION CONTEXT — Compute industry current P/E, industry median P/E, and 10th–90th percentile range using all available peer P/E signals from the last 5 years.

2. HISTORICAL COMPANY P/E ANALYSIS — From company P/E signals over 5+ years, compute: median P/E, trough P/E, and peak P/E. Describe valuation behaviour across earnings cycles.

3. BASE P/E (Rule-Based) — Apply the formula:
   Base P/E = Industry Median P/E × (Company 5Y Median P/E / Industry 5Y Median P/E) + ROE Premium Adjustment
   ROE Premium: if company 3Y avg ROE > sector 3Y avg ROE by Δ%, apply +Δ/2 turns on P/E (cap at +5x). If below, apply negative adjustment symmetrically.

4. BULL / BASE / BEAR P/E — Assign P/E multiples using the re-rating tag determined in section 6:
   Strong:   Bull = Higher of (company peak, top-quartile peer P/E);  Bear = Company trough P/E
   Moderate: Bull = Average of (company peak, top-quartile peer P/E); Bear = Average of (company trough, industry trough P/E)
   Weak:     Bull = Lower of (company peak, 75th-percentile peer P/E); Bear = Industry trough P/E
   For each case state the scenario condition/assumption in one sentence.

5. CATALYSTS — List exactly 3 positive re-rating catalysts (tag each High/Medium/Low impact) and 3 negative/de-rating risks. Draw from: earnings acceleration, margin expansion, ROE/ROCE improvement, deleveraging, recurring revenue mix shift, sector tailwinds, capital allocation upgrades (positive); guidance misses, leverage stress, pricing pressure, execution delays, regulatory risk, governance concerns (negative).

6. RE-RATING POTENTIAL TAG (Strong / Moderate / Weak) — Assess by analysing:
   • PAT/Earnings growth acceleration or deceleration over the last 2 years
   • ROE/ROCE trajectory (improving, stable, deteriorating)
   • Catalyst strength from section 5
   • Current P/E discount or premium vs company past median and industry median
   • Business cycle position: entering upcycle (margins bottoming, revenue recovery) or downcycle`,
    },
  },
  {
    slug:        'target-price-matrix',
    name:        'Target Price Matrix',
    category:    'deal',
    description: '3-year exit price matrix with bull/base/bear target ranges, EPS CAGR, exit P/E, probability-weighted outcome, and risk/reward ratio',
    config: {
      signal_filters: {
        signal_types:       ['kpi', 'financial_health', 'milestone', 'governance'],
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
      prompt_template: null,
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
      if (force_config) updateData.config = dbCfg.config;
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
