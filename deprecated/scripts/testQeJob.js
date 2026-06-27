'use strict';

/**
 * scripts/testQeJob.js
 * Run: node scripts/testQeJob.js [callId]
 * Default: ABB_FY2025_Q3
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { connection, openRouter, parseJson, computePeriodType, applyMultiplier } = require('../lib/workerSetup');
const { quarterlyEarningsPrompt } = require('../prompts/quarterly_earnings');
const { isBFSI } = require('../utils/industryClassifier');
const QE_KPI_CONFIG = require('../lib/qe_kpi_config.json');

const prisma = new PrismaClient();
const callId = process.argv[2] || 'ABB_FY2025_Q3';
const MAX_TOKENS = 16000;
const DENOM_UNIT = { rupee: 'Cr', percentage: '%', ratio: 'x', other: '' };

function getKpiConfigForPrompt(basicIndustry) {
  const industryKey = isBFSI(basicIndustry) ? 'bfsi' : 'non_bfsi';
  const config = QE_KPI_CONFIG[industryKey];
  const kpis = [];
  function extractKpis(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== 'object') continue;
      if (value.label && Array.isArray(value.aliases)) kpis.push({ abbr: key, label: value.label, aliases: value.aliases });
      else extractKpis(value);
    }
  }
  [config.balance_sheet, config.pnl, config.cashflow].forEach(s => { if (s) extractKpis(s); });
  return kpis;
}

function flattenQeResult(data) {
  const out = [];
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if ('abbr' in obj && 'value' in obj) {
      out.push({
        kpi_abbr:   obj.abbr,
        kpi_value:  obj.value,
        start_date: obj.start_date ?? null,
        end_date:   obj.end_date   ?? null,
        multiplier: obj.multiplier ?? 1,
      });
      return;
    }
    for (const v of Object.values(obj)) walk(v);
  }
  walk(data.balance_sheet);
  walk(data.pnl);
  walk(data.cashflow);
  return out;
}

async function buildPdfBlock(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF fetch failed: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { type: 'file', file: { filename: 'quarterly_report.pdf', file_data: `data:application/pdf;base64,${base64}` } };
}

async function main() {
  console.log(`\n=== QE Test: ${callId} ===\n`);

  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) throw new Error(`Call not found: ${callId}`);
  if (!call.quarterly_result_url) throw new Error(`No quarterly_result_url for ${callId}`);

  console.log(`Company: ${call.company}  FY: ${call.fiscal_year}  Q: ${call.quarter}`);
  console.log(`QE URL: ${call.quarterly_result_url}\n`);

  const kpis   = getKpiConfigForPrompt(call.basic_industry);
  const prompt = quarterlyEarningsPrompt(kpis, call.quarter || '', call.fiscal_year || '', call.call_date || '');

  console.log(`Prompt length: ${prompt.length} chars`);
  console.log('Downloading PDF...');
  const pdfBlock = await buildPdfBlock(call.quarterly_result_url);

  console.log('Calling LLM...');
  const stream = await openRouter.chat.completions.create({
    model:      'anthropic/claude-sonnet-4-6',
    max_tokens: MAX_TOKENS,
    provider:   { order: ['Anthropic'], allow_fallbacks: false },
    messages:   [{ role: 'user', content: [pdfBlock, { type: 'text', text: prompt }] }],
    stream:     true,
  });
  let responseText = '';
  for await (const chunk of stream) responseText += chunk.choices[0]?.delta?.content ?? '';

  console.log('\n─── Raw LLM response (first 1000 chars) ───');
  console.log(responseText.slice(0, 1000));
  console.log('...\n');

  const extractedData = parseJson(responseText);
  const flatKpis = flattenQeResult(extractedData);

  console.log(`─── Flattened KPIs (${flatKpis.length} total) ───`);
  const nonNull = flatKpis.filter(k => k.kpi_value != null);
  const withDates = nonNull.filter(k => k.start_date || k.end_date);
  console.log(`  Non-null values: ${nonNull.length}`);
  console.log(`  With date range: ${withDates.length}`);
  console.log('\nSample (first 10 non-null):');
  nonNull.slice(0, 10).forEach(k =>
    console.log(`  ${k.kpi_abbr.padEnd(20)} value=${String(k.kpi_value).padEnd(12)} start=${k.start_date || 'null'.padEnd(10)}  end=${k.end_date || 'null'}  mult=${k.multiplier}`)
  );

  // Save to summary_new
  await prisma.summaryNew.upsert({
    where:  { callId },
    update: { kpis: flatKpis },
    create: { callId, kpis: flatKpis },
  });
  console.log('\n✓ Saved to summary_new.kpis');

  // Save to kpi_values
  const kpiMeta = await prisma.kpi.findMany({ select: { abbr: true, denomination: true } });
  const denomMap = new Map(kpiMeta.map(k => [k.abbr, k.denomination]));

  const kpiValueRows = nonNull
    .filter(k => !isNaN(parseFloat(k.kpi_value)))
    .map(k => {
      const llmVal    = parseFloat(k.kpi_value);
      const mult      = Math.round(k.multiplier ?? 1);
      const startDate = k.start_date ?? null;
      const endDate   = k.end_date   ?? null;
      return {
        callId,
        company:     call.company,
        fiscal_year: call.fiscal_year ?? null,
        quarter:     call.quarter     ?? null,
        call_date:   call.call_date   ?? null,
        kpi_abbr:    k.kpi_abbr,
        value:       applyMultiplier(llmVal, mult),
        raw_value:   String(llmVal),
        unit:        DENOM_UNIT[denomMap.get(k.kpi_abbr)] ?? null,
        multiplier:  mult,
        start_date:  startDate,
        end_date:    endDate,
        period_type: computePeriodType(startDate, endDate),
        source:      'QE',
        source_path: '',
        statement:   null,
      };
    });

  await prisma.kpiValue.deleteMany({ where: { callId, source: 'QE' } });
  await prisma.kpiValue.createMany({ data: kpiValueRows, skipDuplicates: true });
  console.log(`✓ Saved ${kpiValueRows.length} rows to kpi_values`);

  // Verify
  const saved = await prisma.kpiValue.findMany({
    where:   { callId },
    orderBy: { kpi_abbr: 'asc' },
    select:  { kpi_abbr: true, value: true, unit: true, multiplier: true, start_date: true, end_date: true },
  });
  console.log(`\n─── kpi_values rows saved (${saved.length}) ───`);
  saved.forEach(r =>
    console.log(`  ${r.kpi_abbr.padEnd(20)} ${String(r.value).padEnd(14)} unit=${String(r.unit).padEnd(4)} mult=${r.multiplier}  ${r.start_date || 'null'} → ${r.end_date || 'null'}`)
  );
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => Promise.all([prisma.$disconnect(), connection.quit()]));
