'use strict';

/**
 * Debug script: inspect what values are injected into the financial_strength
 * operating leverage prompt section for a given ticker (default: ABB).
 *
 * Usage:  node scripts/debug_op_leverage.js [TICKER]
 *
 * Prints:
 *  - Q4 REV_OP series (raw)
 *  - Q4 EBIT series (derived)
 *  - computed revenue_growth_yoy, ebit_growth_yoy, leverage_spread
 */

const ticker = process.argv[2] || 'ABB';

const prisma          = require('../lib/prisma');
const { FinHelper }   = require('../utils/finHelper');
const { isBFSI }      = require('../utils/industryClassifier');

async function main() {
  const helper = new FinHelper(prisma);

  // Need industry to know if BFSI (affects EBIT derivation)
  const latestSummary = await prisma.summaryNew.findFirst({
    where:   { callId: { startsWith: ticker + '_' } },
    orderBy: { createdAt: 'desc' },
    select:  { industryAnalysis: true },
  });
  const industry = latestSummary?.industryAnalysis?.industry ?? 'Unknown';
  const bfsi     = isBFSI(industry);

  console.log(`\nTicker  : ${ticker}`);
  console.log(`Industry: ${industry}`);
  console.log(`BFSI    : ${bfsi}`);

  const RAW_ABBRS = ['REV_OP'];
  const [rawBatch, derivedBatch] = await Promise.all([
    helper.getTimeSeriesBatch(ticker, RAW_ABBRS),
    helper.getDerivedKpiBatch(ticker, bfsi),
  ]);

  // Q4-only filter (same as in the prompt builder)
  const q4Only = series => (series ?? []).filter(s => s.quarter === 'Q4');

  const revOpQ4 = q4Only(rawBatch['REV_OP']);
  const ebitQ4  = q4Only(derivedBatch['EBIT']);

  // _qSeries equivalent: filter nulls, format label
  function qSeries(series) {
    return series.filter(s => s.value != null).map(s => ({
      quarter: `${s.quarter}'${String(s.fiscal_year ?? '').slice(-2)}`,
      value:   s.value,
    }));
  }

  const revQ4s  = qSeries(revOpQ4);
  const ebitQ4s = qSeries(ebitQ4);

  console.log('\n── REV_OP Q4 series (with values) ──');
  if (revQ4s.length === 0) {
    console.log('  (no data)');
  } else {
    revQ4s.forEach(r => console.log(`  ${r.quarter} = ${r.value}`));
  }

  console.log('\n── EBIT Q4 series (derived, with values) ──');
  if (ebitQ4s.length === 0) {
    console.log('  (no data)');
  } else {
    ebitQ4s.forEach(r => console.log(`  ${r.quarter} = ${r.value}`));
  }

  // _yoyGrowth equivalent
  function yoyGrowth(series) {
    if (series.length < 2) return null;
    const prev = series[series.length - 2].value;
    const curr = series[series.length - 1].value;
    if (!prev || prev === 0) return null;
    return parseFloat(((curr - prev) / Math.abs(prev) * 100).toFixed(1));
  }

  const revGrowthYoy   = yoyGrowth(revQ4s);
  const ebitGrowthYoy  = yoyGrowth(ebitQ4s);
  const leverageSpread = (revGrowthYoy != null && ebitGrowthYoy != null)
    ? parseFloat((ebitGrowthYoy - revGrowthYoy).toFixed(1))
    : null;

  console.log('\n── Operating Leverage Pre-computed Metrics (what goes into the prompt) ──');
  console.log(`Revenue Growth YoY (latest Q4 vs prior Q4): ${revGrowthYoy != null ? revGrowthYoy + '%' : 'N/A'}`);
  console.log(`EBIT Growth YoY    (latest Q4 vs prior Q4): ${ebitGrowthYoy != null ? ebitGrowthYoy + '%' : 'N/A'}`);
  console.log(`Leverage Spread (EBIT growth − Rev growth): ${leverageSpread != null ? leverageSpread + 'pp' : 'N/A'}`);

  // Diagnose why N/A
  if (revGrowthYoy == null) {
    if (revQ4s.length === 0)     console.log('\n[DIAGNOSIS] REV_OP: no Q4 data at all for this ticker.');
    else if (revQ4s.length === 1) console.log('\n[DIAGNOSIS] REV_OP: only 1 Q4 data point — need ≥2 for YoY growth.');
    else                          console.log('\n[DIAGNOSIS] REV_OP: prior Q4 value is 0 or null — cannot compute growth.');
  }
  if (ebitGrowthYoy == null) {
    if (ebitQ4s.length === 0)     console.log('[DIAGNOSIS] EBIT: no Q4 data — check if source KPIs (REV_OP, EMP_EXP, OTH_EXP, DEP_AMORT, FIN_COST) are populated.');
    else if (ebitQ4s.length === 1) console.log('[DIAGNOSIS] EBIT: only 1 Q4 data point — need ≥2 for YoY growth.');
    else                           console.log('[DIAGNOSIS] EBIT: prior Q4 value is 0 or null.');
  }

  // Also show what source KPIs for EBIT look like
  const EBIT_SOURCES = ['REV_OP', 'EMP_EXP', 'OTH_EXP', 'DEP_AMORT', 'FIN_COST', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG'];
  const sourceBatch  = await helper.getTimeSeriesBatch(ticker, EBIT_SOURCES);

  console.log('\n── EBIT source KPI Q4 counts (periods with non-null Q4 value) ──');
  for (const abbr of EBIT_SOURCES) {
    const nonNull = q4Only(sourceBatch[abbr]).filter(s => s.value != null).length;
    console.log(`  ${abbr.padEnd(16)} Q4 non-null periods: ${nonNull}`);
  }
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
