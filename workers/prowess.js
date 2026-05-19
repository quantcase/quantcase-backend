'use strict';

const { Worker }     = require('bullmq');
const { randomUUID } = require('crypto');
const connection     = require('../config/redis');
const prisma         = require('../config/prisma');
const openRouter     = require('../config/llm');
const { parseJson }  = require('../utils/workerUtils');
const { prowessExtractionPrompt, assembleSignal } = require('../prompts/prowess_extraction');
const { loadSkillConfig }         = require('../utils/skillConfig');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');
const { writeSignals, cacheHit }  = require('../services/db/signals.db');
const { normalizeSignal }         = require('../utils/signalShape');
const { ProwessHelper }           = require('../utils/prowessHelper');

// ─── Data fetching ────────────────────────────────────────────────────────────

async function resolveProwessCompany(ticker) {
  const helper = new ProwessHelper(prisma);
  const name   = await helper.resolveProwessName(ticker);
  if (!name) throw new Error(`No Prowess company mapping found for ticker "${ticker}"`);
  return name;
}

async function fetchAnnualRows(prowessCompany, fiscalYear) {
  const allAnnual = await prisma.$queryRaw`
    SELECT fiscal_year, quarter, source_type, period_type, statement,
           kpi_abbr, raw_value, unit, multiplier, start_date, end_date
    FROM   prowess_values_new
    WHERE  company      = ${prowessCompany}
      AND  quarter      = 'Q4'
      AND  period_type  IN ('annual', 'snapshot')
      AND  fiscal_year <= ${fiscalYear}
    ORDER BY fiscal_year ASC, source_type ASC, period_type ASC, kpi_abbr ASC
  `;

  if (!allAnnual.length) return [];

  // Per fiscal year: prefer C rows; fall back to S if no C exists.
  const byYear = new Map();
  for (const row of allAnnual) {
    const fy = row.fiscal_year;
    if (!byYear.has(fy)) byYear.set(fy, { C: [], S: [] });
    byYear.get(fy)[row.source_type]?.push(row);
  }

  const result = [];
  for (const [, { C, S }] of byYear) result.push(...(C.length ? C : S));
  return result;
}

async function fetchQuarterlyRows(prowessCompany, fiscalYear) {
  return prisma.$queryRaw`
    SELECT fiscal_year, quarter, source_type, period_type, statement,
           kpi_abbr, raw_value, unit, multiplier, start_date, end_date
    FROM   prowess_values_new
    WHERE  company     = ${prowessCompany}
      AND  fiscal_year = ${fiscalYear}
      AND  source_type = 'S'
      AND  period_type IN ('quarterly', 'snapshot')
    ORDER BY quarter ASC, period_type ASC, kpi_abbr ASC
  `;
}

// ─── Source hash ──────────────────────────────────────────────────────────────

function hashRows(annualRows, quarterlyRows) {
  const key = JSON.stringify([
    annualRows.map(r  => `${r.fiscal_year}|${r.quarter}|${r.source_type}|${r.period_type}|${r.kpi_abbr}|${r.raw_value}`),
    quarterlyRows.map(r => `${r.fiscal_year}|${r.quarter}|${r.source_type}|${r.period_type}|${r.kpi_abbr}|${r.raw_value}`),
  ]);
  return computeSourceHash(key);
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processProwessJob(job) {
  const { callId, type } = job.data;
  console.log(`[prowess] Processing job ${job.id} (callId: ${callId})`);

  await prisma.job.upsert({
    where:  { bullmqId: job.id },
    update: { status: 'processing' },
    create: { callId, type: type || 'prowess_extraction', status: 'processing', bullmqId: job.id },
  });
  await job.updateProgress(10);

  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) throw new Error(`Earnings call ${callId} not found`);

  const prowessCompany = await resolveProwessCompany(call.company);
  console.log(`[prowess] Resolved "${call.company}" → "${prowessCompany}"`);
  await job.updateProgress(20);

  const [annualRows, quarterlyRows] = await Promise.all([
    fetchAnnualRows(prowessCompany, call.fiscal_year),
    fetchQuarterlyRows(prowessCompany, call.fiscal_year),
  ]);

  if (!annualRows.length && !quarterlyRows.length) {
    throw new Error(`No prowess_values_new data found for "${prowessCompany}" up to ${call.fiscal_year}`);
  }

  // Combined ordered list — row_id = index in this array, matching what the LLM sees.
  const allRows = [...annualRows, ...quarterlyRows];
  console.log(`[prowess] Fetched ${annualRows.length} annual rows, ${quarterlyRows.length} quarterly rows (${allRows.length} total)`);
  await job.updateProgress(30);

  // L1 cache check
  const sourceHash  = hashRows(annualRows, quarterlyRows);
  const skillConfig = await loadSkillConfig('prowess-extraction');
  const promptV     = computePromptVersion('prowess-extraction', skillConfig.updatedAt);

  const hit = await cacheHit(callId, sourceHash, promptV, ['kpi']);
  if (hit) {
    console.log(`[prowess] L1 cache hit for ${callId} — skipping LLM`);
    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { callId, cached: true } },
    });
    await job.updateProgress(100);
    return { cached: true, callId };
  }

  const { model, maxTokens, outputSchema, promptTemplate } = skillConfig;
  const prompt = prowessExtractionPrompt(
    annualRows,
    quarterlyRows,
    call.quarter        || '',
    call.fiscal_year    || '',
    call.company_name   || call.company,
    promptTemplate,
    call.basic_industry || null,
  );
  console.log(`[prowess] Prompt length: ${prompt.length} chars (${allRows.length} rows)`);
  await job.updateProgress(40);

  console.log('[prowess] Calling LLM...');
  const params = {
    model,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    stream:     true,
  };
  if (outputSchema) params.response_format = outputSchema;

  const stream = await openRouter.chat.completions.create(params);
  let responseText = '';
  for await (const chunk of stream) responseText += chunk.choices[0]?.delta?.content ?? '';
  await job.updateProgress(75);

  if (!responseText) throw new Error('Empty response from LLM');
  console.log(`[prowess] Raw LLM response (first 300 chars): ${responseText.slice(0, 300)}`);

  const parsed      = parseJson(responseText);
  const enrichments = parsed.enrichments ?? [];
  console.log(`[prowess] LLM returned ${enrichments.length} enrichments for ${allRows.length} rows`);
  await job.updateProgress(90);

  // Build a map of row_id → enrichment for O(1) lookup
  const enrichMap = new Map(enrichments.map(e => [e.row_id, e]));

  const lineageId = randomUUID();
  const sigBase = {
    call_id:         callId,
    ticker:          call.company,
    company:         call.company,
    fiscal_year:     call.fiscal_year ?? null,
    quarter:         call.quarter     ?? null,
    call_date:       call.call_date   ?? null,
    source_type:     'prowess',
    source_hash:     sourceHash,
    prompt_v:        promptV,
    schema_v:        '2.0.0',
    extractor_model: model,
    lineage_id:      lineageId,
  };

  const signals = [];
  for (let i = 0; i < allRows.length; i++) {
    const row        = allRows[i];
    const enrichment = enrichMap.get(i);
    try {
      const assembled = assembleSignal(row, enrichment, sigBase);
      signals.push(normalizeSignal(assembled, sigBase));
    } catch (e) {
      console.warn(`[prowess] Skipping malformed signal (row ${i}, ${row?.kpi_abbr}): ${e.message}`);
    }
  }

  const written = await writeSignals(lineageId, signals);
  console.log(`[prowess] Signal Store: wrote ${written} signals for ${callId} (lineage: ${lineageId})`);

  await prisma.job.update({
    where: { bullmqId: job.id },
    data:  { status: 'completed', result: { callId, signalsWritten: written } },
  });
  await job.updateProgress(100);
  console.log(`[prowess] Job ${job.id} completed — ${written} signals written`);
  return { callId, signalsWritten: written, lineageId };
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('prowess_extraction', processProwessJob, {
  connection,
  concurrency: 50,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job       => console.log(`[prowess] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[prowess] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[prowess] Worker error:', err));

console.log('Prowess extraction worker ready');

module.exports = worker;
