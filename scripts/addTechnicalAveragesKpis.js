'use strict';

/**
 * Registers the Kpi rows needed to route the "raw average" part of
 * technicals (SMA_20/50/100/200, AVG_VOL_20/30) through the same
 * formulaRegistry every other DB-driven metric uses, instead of each of
 * getPrices/technicalAnalysis.js hand-rolling its own copy via
 * utils/taIndicators.js. Everything else (EMA/RSI/MACD/Bollinger/ADX/CMF/
 * 52w high-low/crossovers/patterns) stays on taIndicators.js -- no
 * CAGR/AVG/SUM-shaped primitive exists for those, and Kpi has no
 * boolean/label value type.
 *
 * VOLUME_DAILY, not VOLUME -- 'VOLUME' already exists as a
 * source:'transcript' dedup-pipeline abbr (industry-specific sales/units
 * volume, 76 industries) -- an unrelated concept, same collision class as
 * EV (Electric Vehicle) vs. ENTERPRISE_VALUE. _DAILY suffix mirrors
 * PE_DAILY's own naming for the same reason.
 *
 * Idempotent, uses the real admin service (validation + registry cache
 * invalidation). Usage: node scripts/addTechnicalAveragesKpis.js
 */

const kpis = require('../services/admin.kpis.service');
const prisma = require('../config/prisma');

async function ensureKpi(abbr, fields) {
  const existing = await prisma.kpi.findUnique({ where: { abbr } });
  if (existing) {
    console.log(`  exists: ${abbr}`);
    return existing;
  }
  const created = await kpis.createKpi({ abbr, ...fields });
  console.log(`  created: ${abbr} (${fields.formula_expression ?? 'raw'})`);
  return created;
}

async function main() {
  console.log('== New raw daily leaf, backed by nse_equity_new (no CSV involved) ==');
  await ensureKpi('VOLUME_DAILY', {
    full_form: 'Trading Volume (daily, as reported by NSE)',
    frequency: 'daily',
    unit_label: 'shares',
    denomination: 'other',
    description: 'Raw daily traded volume from nse_equity_new.volume — one row per trading day. Not "VOLUME" (that abbr is an unrelated source:transcript industry-specific sales-volume metric).',
  });

  console.log('\n== SMA family (AVG(PRICE, N)) ==');
  for (const period of [20, 50, 100, 200]) {
    await ensureKpi(`SMA_${period}`, {
      full_form: `Simple Moving Average (${period}-day)`,
      formula_expression: `AVG(PRICE, ${period})`,
      frequency: 'daily',
      unit_label: 'Rs',
      denomination: 'rupee',
      description: `Trailing ${period}-trading-day average of PRICE. Averages whatever history exists if fewer than ${period} days are available (see averageFromSeries) — callers wanting SMA's usual "null until enough history" convention must apply their own length guard, same as getPrices/technicalAnalysis.js do.`,
    });
  }

  console.log('\n== Volume-average family (AVG(VOLUME_DAILY, N)) ==');
  for (const period of [20, 30]) {
    await ensureKpi(`AVG_VOL_${period}`, {
      full_form: `Average Trading Volume (${period}-day)`,
      formula_expression: `AVG(VOLUME_DAILY, ${period})`,
      frequency: 'daily',
      unit_label: 'shares',
      denomination: 'other',
      description: `Trailing ${period}-trading-day average of VOLUME_DAILY. Unlike taIndicators.avgVolume(), this does NOT filter out zero-volume days before averaging — a small, accepted divergence on tickers with occasional zero-volume days.`,
    });
  }

  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
