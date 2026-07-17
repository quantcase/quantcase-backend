'use strict';

/**
 * One-off seed of real KpiFilter rows (and one demo kpi_filter CompanyGroup),
 * so /admin/kpi-filters and /admin/company-groups aren't empty for frontend
 * to test against. Drawn from controllers/baskets.controller.js's BASKETS
 * conditions text — but only the subset that's a plain "kpi_abbr vs constant"
 * threshold, which is all KpiFilter can express. NOT included, and not
 * expressible via KpiFilter at all:
 *   - metric-vs-metric comparisons (e.g. "PE < Historical PE 5Years",
 *     "Current price < 0.5 x High price all time") — KpiFilter only compares
 *     one kpi_abbr against a constant, never against another kpi_abbr.
 *   - "grew every quarter for 4 quarters" streak/QoQ logic.
 *   - technical-indicator screens (golden crossover, RSI, moving averages,
 *     power candle) — SMA/RSI/etc. live in utils/formulaRegistry/technical.js's
 *     TECHNICAL_REGISTRY, not the Kpi table, so kpi_abbr can't reference them.
 *   - HISTORICAL_PE_3Y/5Y — confirmed not migrated into the Kpi table.
 *
 * Idempotent (upsert by slug). Uses the real service layer (not raw prisma
 * writes) so validation/slugify/cache-invalidation all run exactly as if an
 * admin used the UI.
 *
 * Usage: node scripts/seedBasketKpiFilters.js
 */

const kpiFilters = require('../services/admin.kpiFilters.service');
const companyGroups = require('../services/companyGroups');
const prisma = require('../config/prisma');

// [slug, label, kpi_abbr, operator, value, value_max, sourceBasket]
const FILTERS = [
  ['market-cap-gt-500',    'Market Cap > ₹500 Cr',        'MARKET_CAP_CR', '>',  500,  null, 'small-size-solid-fundamentals / near-lows-quality-intact / golden-crossover / oversold-on-rsi'],
  ['market-cap-500-2000',  'Market Cap ₹500-2000 Cr',      'MARKET_CAP_CR', 'between', 500, 2000, 'small-size-solid-fundamentals'],
  ['market-cap-gt-1000',   'Market Cap > ₹1000 Cr',        'MARKET_CAP_CR', '>',  1000, null, 'profit-momentum-reasonably-priced / quality-compounders-at-a-discount / down-50pct-fundamentals-strong / cheap-on-book-strong-returns / four-mas-in-one-candle / power-candle'],
  ['net-profit-positive',  'Net Profit > 0',               'PAT',           '>',  0,    null, 'small-size-solid-fundamentals'],
  ['eps-positive',         'EPS > 0',                      'EPS_BASIC',     '>',  0,    null, 'small-size-solid-fundamentals'],
  ['sales-growth-3y-positive', 'Sales Growth 3Y > 0%',     'REV_CAGR_3Y',   '>',  0,    null, 'small-size-solid-fundamentals'],
  ['sales-growth-5y-gt-10','Sales Growth 5Y > 10%',        'REV_CAGR_5Y',   '>',  10,   null, 'down-50pct-fundamentals-strong / quality-compounders-at-a-discount'],
  ['debt-equity-lt-1',     'Debt to Equity < 1',           'DE',            '<',  1,    null, 'small-size-solid-fundamentals / quality-compounders-at-a-discount / near-lows-quality-intact'],
  ['debt-equity-lt-0.5',   'Debt to Equity < 0.5',         'DE',            '<',  0.5,  null, 'down-50pct-fundamentals-strong / cheap-on-book-strong-returns'],
  ['peg-lt-1',             'PEG Ratio < 1',                'PEG_RATIO',     '<',  1,    null, 'small-size-solid-fundamentals / profit-momentum-reasonably-priced'],
  ['peg-lt-2',             'PEG Ratio < 2',                'PEG_RATIO',     '<',  2,    null, 'down-50pct-fundamentals-strong'],
  ['roe-gt-12',            'ROE > 12%',                    'ROE',           '>',  12,   null, 'quality-compounders-at-a-discount / cheap-on-book-strong-returns'],
  ['roe-gt-15',            'ROE > 15%',                    'ROE',           '>',  15,   null, 'down-50pct-fundamentals-strong'],
  ['roce-gt-12',           'ROCE > 12%',                   'ROCE',          '>',  12,   null, 'cheap-on-book-strong-returns'],
  ['roce-gt-15',           'ROCE > 15%',                   'ROCE',          '>',  15,   null, 'down-50pct-fundamentals-strong / near-lows-quality-intact / profit-growing-faster-than-sales'],
  ['pb-lt-2',              'Price to Book < 2',            'PB_TTM',        '<',  2,    null, 'cheap-on-book-strong-returns'],
  ['pe-lt-30',             'Price to Earning < 30',        'PE_TTM',        '<',  30,   null, 'profit-momentum-reasonably-priced'],
  ['ocf-pat-gt-0.8',       'OCF/PAT > 0.8',                'OCF_PAT',       '>',  0.8,  null, 'cheap-on-book-strong-returns / profit-growing-faster-than-sales'],
  ['opm-gt-15',            'Operating Margin > 15%',       'OP_MARGIN',     '>',  15,   null, 'profit-momentum-reasonably-priced'],
  ['net-profit-positive-strong', 'Profit After Tax > 0',   'PAT',           '>',  0,    null, 'near-lows-quality-intact'],
];

// The one basket where every condition is a plain threshold — wired up as a
// full working kpi_filter CompanyGroup so frontend can test attach+recompute+resolve
// against something real, not just an empty demo.
const DEMO_GROUP_SLUG = 'demo-cheap-on-book-strong-returns';
const DEMO_GROUP_FILTER_SLUGS = ['pb-lt-2', 'roe-gt-12', 'roce-gt-12', 'market-cap-gt-1000', 'ocf-pat-gt-0.8', 'debt-equity-lt-0.5'];

async function upsertFilter([slug, label, kpi_abbr, operator, value, value_max]) {
  const existing = await prisma.kpiFilter.findUnique({ where: { slug } });
  if (existing) {
    console.log(`  exists: ${slug}`);
    return existing;
  }
  const created = await kpiFilters.createKpiFilter({ slug, label, kpi_abbr, operator, value, value_max });
  console.log(`  created: ${slug} (${kpi_abbr} ${operator} ${value}${value_max != null ? `..${value_max}` : ''})`);
  return created;
}

async function main() {
  console.log('== KpiFilter seed (from baskets.controller.js conditions) ==');
  for (const f of FILTERS) await upsertFilter(f);

  console.log('\n== Demo CompanyGroup: cheap-on-book-strong-returns ==');
  let group = await prisma.companyGroup.findUnique({ where: { slug: DEMO_GROUP_SLUG } });
  if (!group) {
    group = await companyGroups.createGroup({
      name: 'Demo — Cheap on book, strong returns',
      slug: DEMO_GROUP_SLUG,
      description: 'Seeded demo group replicating the basket screen of the same name — for frontend testing.',
      filter_type: 'kpi_filter',
      filter_config: {},
    });
    console.log(`  created group: ${DEMO_GROUP_SLUG}`);
  } else {
    console.log(`  group exists: ${DEMO_GROUP_SLUG}`);
  }

  const attached = await companyGroups.listAttachedFilters(DEMO_GROUP_SLUG);
  const attachedSlugs = new Set(attached.map(a => a.kpi_filter.slug));
  for (const slug of DEMO_GROUP_FILTER_SLUGS) {
    if (attachedSlugs.has(slug)) { console.log(`  already attached: ${slug}`); continue; }
    await companyGroups.attachFilter(DEMO_GROUP_SLUG, { kpi_filter_slug: slug });
    console.log(`  attached: ${slug}`);
  }

  console.log('\n  recomputing (this scans the full company universe, ~2 min)...');
  const result = await companyGroups.recomputeGroup(DEMO_GROUP_SLUG);
  console.log(`  matched: ${result.matched} companies`);
  console.log(`  sample: ${result.symbols.slice(0, 10).join(', ')}`);

  console.log('\nDone. Skipped (not expressible via KpiFilter): metric-vs-metric comparisons,');
  console.log('QoQ streak logic, all 4 technical-indicator screens, HISTORICAL_PE.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
