'use strict';

/**
 * scripts/testSummarizationJob.js
 * Run: node scripts/testSummarizationJob.js [callId]
 * Default: ABB_FY2025_Q3
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { connection, llmStream, parseJson, computePeriodType, applyMultiplier } = require('../lib/workerSetup');
const { transcriptExtractorPrompt } = require('../prompts/transcript_call');
const { upsertNewKpis } = require('../db-utils/upsertKpis');

const prisma = new PrismaClient();
const callId = process.argv[2] || 'ABB_FY2025_Q3';

const TRANSCRIPT_CHAR_LIMIT = 50000;
const MAX_TOKENS = 16000;
const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31';
const DENOM_UNIT = { rupee: 'Cr', percentage: '%', ratio: 'x', other: '' };

const TRANSCRIPT_KPI_PATHS = [
  { path: 'client_traction.customer_growth',     extract: d => d?.client_traction?.customer_growth?.kpis },
  { path: 'client_traction.revenue_streams',     extract: d => d?.client_traction?.revenue_streams?.kpis },
  { path: 'industry_analysis.demand',            extract: d => d?.industry_analysis?.demand?.kpis },
  { path: 'industry_analysis.supply',            extract: d => d?.industry_analysis?.supply?.kpis },
  { path: 'industry_analysis.operating_margins', extract: d => d?.industry_analysis?.operating_margins?.kpis },
];

const MILESTONE_CATEGORIES = ['future_goals', 'success_disclosures', 'failure_disclosures'];

async function main() {
  console.log(`\n=== Summarization Test: ${callId} ===\n`);

  // Load call
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) throw new Error(`Call not found: ${callId}`);

  const combinedText = [call.transcript_text || '', call.ppt_text || '']
    .filter(t => t.trim().length > 0)
    .join('\n\n');
  if (!combinedText.trim()) throw new Error(`No transcript or PPT text for ${callId}`);

  console.log(`Company: ${call.company}  FY: ${call.fiscal_year}  Q: ${call.quarter}`);
  console.log(`Industry: ${call.basic_industry}`);
  console.log(`Combined text length: ${combinedText.length} chars (truncating to ${TRANSCRIPT_CHAR_LIMIT})\n`);

  // Load KPIs for prompt
  const qeKpis = await prisma.kpi.findMany({ where: { source: 'QE' } });
  const transcriptWhere = call.basic_industry
    ? { source: 'transcript', industry: { has: call.basic_industry } }
    : { source: 'transcript' };
  const transcriptKpis = await prisma.kpi.findMany({ where: transcriptWhere });
  const existingKpis = [...qeKpis, ...transcriptKpis].map(k => ({
    id: k.id, abbr: k.abbr, full_form: k.full_form,
    kpi_type: k.kpi_type ?? undefined, denomination: k.denomination ?? undefined, source: k.source
  }));
  console.log(`Loaded ${existingKpis.length} KPIs for prompt\n`);

  // Build prompt
  let callDate = null;
  if (call.call_date) {
    const d = new Date(call.call_date);
    callDate = !isNaN(d) ? d.toISOString().slice(0, 10) : call.call_date.slice(0, 10);
  }
  const truncatedText = combinedText.substring(0, TRANSCRIPT_CHAR_LIMIT);
  const prompt = transcriptExtractorPrompt(truncatedText, existingKpis, callDate, FISCAL_YEAR_END);
  console.log(`Prompt length: ${prompt.length} chars`);

  // Call LLM
  console.log('Calling LLM...');
  const responseText = await llmStream({
    model: 'anthropic/claude-sonnet-4-6',
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }]
  });

  console.log('\n─── Raw LLM response (first 1000 chars) ───');
  console.log(responseText.slice(0, 1000));
  console.log('...\n');

  const extractedData = parseJson(responseText);

  // Upsert new KPIs
  if (extractedData.new_kpis?.length > 0 || extractedData.kpis?.length > 0) {
    const kpiResult = await upsertNewKpis(extractedData, call.basic_industry, 'transcript');
    console.log('KPI upsert:', kpiResult);
  }

  // Save summary_new
  const summaryPayload = {
    entities:          extractedData.entities           ?? null,
    milestones:        extractedData.milestones          ?? null,
    riskDisclosures:   extractedData.risk_disclosures    ?? null,
    governanceSignals: extractedData.governance_signals  ?? null,
    industryAnalysis:  extractedData.industry_analysis
      ? { ...extractedData.industry_analysis, industry: call.basic_industry }
      : (call.basic_industry ? { industry: call.basic_industry } : null),
    financialStrength: extractedData.financial_strength  ?? null,
    clientTraction:    extractedData.client_traction     ?? null,
    tone:              extractedData.tone                ?? null,
    confidence:        extractedData.confidence          ?? null,
  };
  await prisma.summaryNew.upsert({
    where:  { callId },
    update: summaryPayload,
    create: { callId, ...summaryPayload },
  });
  console.log('✓ Saved to summary_new\n');

  // Load denomination map
  const kpiMeta = await prisma.kpi.findMany({ select: { abbr: true, denomination: true } });
  const denomMap = new Map(kpiMeta.map(k => [k.abbr, k.denomination]));

  const written = new Set();
  const kpiValueRows = [];

  // Priority-ordered transcript KPI paths
  for (const { path, extract } of TRANSCRIPT_KPI_PATHS) {
    const kpisArr = extract(extractedData);
    if (!Array.isArray(kpisArr)) continue;
    for (const k of kpisArr) {
      if (!k?.kpi_abbr || written.has(k.kpi_abbr)) continue;
      const numVal = parseFloat(k.value);
      if (isNaN(numVal)) continue;
      const mult      = Math.round(k.multiplier ?? 1);
      const startDate = k.start_date ?? null;
      const endDate   = k.end_date   ?? null;
      written.add(k.kpi_abbr);
      kpiValueRows.push({
        callId,
        company:     call.company,
        fiscal_year: call.fiscal_year ?? null,
        quarter:     call.quarter     ?? null,
        call_date:   call.call_date   ?? null,
        kpi_abbr:    k.kpi_abbr,
        value:       applyMultiplier(numVal, mult),
        raw_value:   String(numVal),
        unit:        DENOM_UNIT[denomMap.get(k.kpi_abbr)] ?? null,
        multiplier:  mult,
        start_date:  startDate,
        end_date:    endDate,
        period_type: computePeriodType(startDate, endDate),
        source:      'transcript',
        source_path: path,
        statement:   k.statement ?? null,
      });
    }
  }

  // Milestones (current_value, uncovered only)
  const milestones = extractedData.milestones ?? {};
  for (const category of MILESTONE_CATEGORIES) {
    const targets = milestones[category]?.financial_targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (!t?.kpi_abbr || written.has(t.kpi_abbr)) continue;
      const numVal = parseFloat(t.current_value);
      if (isNaN(numVal)) continue;
      const mult = Math.round(t.multiplier ?? 1);
      written.add(t.kpi_abbr);
      kpiValueRows.push({
        callId,
        company:     call.company,
        fiscal_year: call.fiscal_year ?? null,
        quarter:     call.quarter     ?? null,
        call_date:   call.call_date   ?? null,
        kpi_abbr:    t.kpi_abbr,
        value:       applyMultiplier(numVal, mult),
        raw_value:   String(numVal),
        unit:        DENOM_UNIT[denomMap.get(t.kpi_abbr)] ?? null,
        multiplier:  mult,
        start_date:  null,
        end_date:    null,
        period_type: 'snapshot',
        source:      'transcript',
        source_path: `milestones.${category}`,
        statement:   t.statement ?? null,
      });
    }
  }

  await prisma.kpiValue.deleteMany({ where: { callId, source: 'transcript' } });
  if (kpiValueRows.length > 0) {
    await prisma.kpiValue.createMany({ data: kpiValueRows, skipDuplicates: true });
  }
  console.log(`✓ Saved ${kpiValueRows.length} transcript rows to kpi_values`);

  // Print transcript kpi_values
  console.log('\n─── kpi_values (transcript) ───');
  kpiValueRows.forEach(r =>
    console.log(`  ${r.kpi_abbr.padEnd(20)} value=${String(r.value).padEnd(16)} raw=${String(r.raw_value).padEnd(10)} mult=${String(r.multiplier).padEnd(10)} [${(r.period_type||'').padEnd(11)}]  ${r.start_date || 'null'} → ${r.end_date || 'null'}`)
  );

  // Milestone KPI targets
  const milestoneRows = [];
  for (const category of MILESTONE_CATEGORIES) {
    const targets = milestones[category]?.financial_targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (!t?.kpi_abbr) continue;
      const mult = Math.round(t.multiplier ?? 1);
      const cv   = parseFloat(t.current_value);
      const tv   = parseFloat(t.targeted_value);
      milestoneRows.push({
        callId,
        company:        call.company,
        fiscal_year:    call.fiscal_year ?? null,
        quarter:        call.quarter     ?? null,
        call_date:      call.call_date   ?? null,
        category,
        kpi_abbr:       t.kpi_abbr,
        statement:      t.statement    ?? null,
        current_value:  isNaN(cv) ? null : applyMultiplier(cv, mult),
        targeted_value: isNaN(tv) ? null : applyMultiplier(tv, mult),
        multiplier:     mult,
        initial_time:   t.initial_time ?? null,
        target_time:    t.target_time  ?? null,
      });
    }
  }

  if (milestoneRows.length > 0) {
    await prisma.milestoneKpiTarget.deleteMany({ where: { callId } });
    await prisma.milestoneKpiTarget.createMany({ data: milestoneRows });
  }
  console.log(`✓ Saved ${milestoneRows.length} rows to milestone_kpi_targets`);

  console.log('\n─── milestone_kpi_targets ───');
  milestoneRows.forEach(r =>
    console.log(`  [${r.category}] ${r.kpi_abbr.padEnd(20)} current=${String(r.current_value).padEnd(10)} target=${String(r.targeted_value).padEnd(10)} mult=${r.multiplier}  ${r.initial_time || 'null'} → ${r.target_time || 'null'}`)
  );

  // All kpi_values for this call
  const allSaved = await prisma.kpiValue.findMany({
    where:   { callId },
    orderBy: { kpi_abbr: 'asc' },
    select:  { kpi_abbr: true, value: true, unit: true, multiplier: true, start_date: true, end_date: true, source: true, source_path: true },
  });
  console.log(`\n─── All kpi_values for ${callId} (${allSaved.length} total) ───`);
  allSaved.forEach(r =>
    console.log(`  ${r.kpi_abbr.padEnd(20)} ${String(r.value).padEnd(14)} unit=${String(r.unit).padEnd(4)} mult=${r.multiplier}  ${r.start_date || 'null'} → ${r.end_date || 'null'}  [${r.source}]`)
  );
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => Promise.all([prisma.$disconnect(), connection.quit()]));
