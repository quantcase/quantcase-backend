'use strict';
require('dotenv').config();
const prisma = require('./config/prisma');
const { querySignalsV2 } = require('./services/db/signals.db');
const { applySignalLimits } = require('./services/htmlSkill.service');

const TRANSCRIPT_SIGNAL_TYPES = ["guidance","industry_signal","capital_allocation","disclosure_quality","distribution_customer","growth_forecast","earnings_quality","mgmt_tone","analyst_questions","guidance_revision","pricing_power","competitive_position","milestone","ongoing"];

async function main() {
  const ticker = 'HDFCBANK';
  const rawSignals = await querySignalsV2({ ticker });
  console.log(`Raw signals total: ${rawSignals.length}`);

  const rawQtrs = new Set(rawSignals.filter(s => s.source_doc_type !== 'ppt' && s.source_doc_type !== 'annual_report').map(s => `${s.fiscal_year}|${s.quarter}`));
  console.log(`Distinct transcript quarters (raw): ${[...rawQtrs].sort().join(', ')}`);

  const signals = applySignalLimits(rawSignals, {
    max_transcript_qtrs: 2,
    max_ppt_qtrs: 2,
    max_annual_report_years: 2,
    transcript_signal_types: TRANSCRIPT_SIGNAL_TYPES,
    ppt_signal_types: [],
    annual_report_signal_types: [],
  });
  console.log(`\nAfter applySignalLimits: ${signals.length} signals`);

  const byType = {};
  for (const s of signals) { byType[s.signal_type] = (byType[s.signal_type] || 0) + 1; }
  console.log('By type:', JSON.stringify(byType, null, 2));

  const filteredQtrs = new Set(signals.filter(s => s.source_doc_type !== 'ppt' && s.source_doc_type !== 'annual_report').map(s => `${s.fiscal_year}|${s.quarter}`));
  console.log(`Distinct transcript quarters (filtered): ${[...filteredQtrs].sort().join(', ')}`);

  let totalStatement = 0, totalSourceCtx = 0, maxStatement = 0, maxSourceCtx = 0;
  for (const s of signals) {
    const stmt = s.statement ? String(s.statement).length : 0;
    const ctx  = s.source_context ? String(s.source_context).length : 0;
    totalStatement += stmt;
    totalSourceCtx += ctx;
    if (stmt > maxStatement) maxStatement = stmt;
    if (ctx > maxSourceCtx) maxSourceCtx = ctx;
  }
  const totalChars = totalStatement + totalSourceCtx;
  console.log(`\nField sizes across ${signals.length} signals:`);
  console.log(`  statement:      avg=${Math.round(totalStatement/signals.length)}, max=${maxStatement}, total=${totalStatement} chars`);
  console.log(`  source_context: avg=${Math.round(totalSourceCtx/signals.length)}, max=${maxSourceCtx}, total=${totalSourceCtx} chars`);
  console.log(`  combined chars: ${totalChars}  (~${Math.round(totalChars/4)} tokens estimate)`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

async function main2() {
  // Measure the full data block
  const { applySignalLimits, buildDataBlock } = require('./services/htmlSkill.service');
  const { querySignalsV2 } = require('./services/db/signals.db');

  const TRANSCRIPT_SIGNAL_TYPES = ["guidance","industry_signal","capital_allocation","disclosure_quality","distribution_customer","growth_forecast","earnings_quality","mgmt_tone","analyst_questions","guidance_revision","pricing_power","competitive_position","milestone","ongoing"];
  const rawSignals = await querySignalsV2({ ticker: 'HDFCBANK' });
  const signals = applySignalLimits(rawSignals, {
    max_transcript_qtrs: 2, max_ppt_qtrs: 2, max_annual_report_years: 2,
    transcript_signal_types: TRANSCRIPT_SIGNAL_TYPES, ppt_signal_types: [], annual_report_signal_types: [],
  });

  // We don't have access to buildDataBlock directly (not exported), so let's measure manually
  const COLS = ['signal_type','metric','metric_family','fiscal_year','quarter','call_date','source_doc_type','source_context','impact','severity','statement'];
  const rows = signals.map(s => {
    return COLS.map(k => {
      const v = s[k] ?? (s.data?.[k]) ?? '';
      return String(v).replace(/\n/g, ' ').replace(/\|/g, '/');
    }).join('\t');
  });
  const dataBlock = [COLS.join('\t'), ...rows].join('\n');
  console.log(`\nData block size: ${dataBlock.length} chars (~${Math.round(dataBlock.length/4)} tokens)`);

  // The skill_prompt from the curl is very long - let's measure just the spec portion
  // (the actual curl payload had the full spec, let's approximate with a known portion)
  console.log(`Data block line count: ${rows.length + 1}`);
  console.log(`Average row length: ${Math.round(dataBlock.length / rows.length)} chars`);

  // Check longest rows
  const sorted = [...rows].sort((a,b) => b.length - a.length).slice(0,3);
  console.log(`\nTop 3 longest rows (chars): ${sorted.map(r => r.length).join(', ')}`);
  console.log(`\nFirst row sample:\n${rows[0].slice(0, 300)}`);

  await prisma.$disconnect();
}
main2().catch(e => { console.error(e); process.exit(1); });
