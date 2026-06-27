'use strict';

const { Worker }  = require('bullmq');
const { randomUUID } = require('crypto');
const connection   = require('../config/redis');
const prisma       = require('../config/prisma');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { transcriptExtractorPrompt } = require('../prompts/transcript_call');
const { upsertNewKpis } = require('../services/db/kpis.db');
const { loadSkillConfig } = require('../utils/skillConfig');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');
const { writeSignals, cacheHit } = require('../services/db/signals.db');
const { normalizeSignal } = require('../utils/signalShape');

const TRANSCRIPT_CHAR_LIMIT = 150000;
const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31';

async function getExistingKpisForPrompt(basicIndustry) {
  const qeKpis = await prisma.kpi.findMany({ where: { source: 'QE' } });
  const transcriptWhere = basicIndustry
    ? { source: 'transcript', industry: { has: basicIndustry } }
    : { source: 'transcript' };
  const transcriptKpis = await prisma.kpi.findMany({ where: transcriptWhere });
  return [...qeKpis, ...transcriptKpis]
    .filter(k => !/^new_kpis/i.test(k.abbr))  // exclude legacy dirty abbrs from LLM context
    .map(k => ({
      id:           k.id,
      abbr:         k.abbr,
      full_form:    k.full_form,
      kpi_type:     k.kpi_type    ?? undefined,
      denomination: k.denomination ?? undefined,
      source:       k.source,
    }));
}

async function getCallMeta(callId) {
  return prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, fiscal_year: true, quarter: true, call_date: true, basic_industry: true },
  });
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function downloadAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download PDF (${res.status}): ${url}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

function buildBase64FileContent(base64Data) {
  return { type: 'file', file: { file_data: `data:application/pdf;base64,${base64Data}` } };
}

async function processSummarizationJob(job) {
  const { callId, transcriptText, pptText, transcriptUrl, pptUrl } = job.data;
  console.log(`[summarization] Processing job ${job.id} (callId: ${callId})`);

  const usingUrls = !transcriptText && !pptText && (transcriptUrl || pptUrl);

  const combinedText = usingUrls ? '' : [transcriptText || '', pptText || '']
    .filter(t => t.trim().length > 0)
    .join('\n\n');

  if (!usingUrls && !combinedText.trim()) throw new Error(`No transcript or PPT text for call ${callId}`);
  await job.updateProgress(10);

  // L1 cache check
  const sourceHash = usingUrls
    ? computeSourceHash(transcriptUrl || '', pptUrl || '')
    : computeSourceHash(transcriptText || '', pptText || '');
  const skillConfig = await loadSkillConfig('summarization');
  const promptV     = computePromptVersion('summarization', skillConfig.updatedAt);
  const signalTypes = ['kpi', 'governance', 'entity', 'milestone', 'industry', 'customer', 'financial_health', 'tone'];

  const hit = await cacheHit(callId, sourceHash, promptV, signalTypes);
  if (hit) {
    console.log(`[summarization] L1 cache hit for ${callId} — skipping LLM`);
    await job.updateProgress(100);
    return { cached: true, callId };
  }

  const callMeta = await getCallMeta(callId);
  if (!callMeta) throw new Error(`Earnings call ${callId} not found`);

  const existingKpis = await getExistingKpisForPrompt(callMeta.basic_industry);
  console.log(`[summarization] ${existingKpis.length} KPIs loaded, industry: ${callMeta.basic_industry}`);
  await job.updateProgress(25);

  const { model, maxTokens, outputSchema, promptTemplate } = skillConfig;

  let userMessageContent;
  if (usingUrls) {
    console.log(`[summarization] Downloading PDFs for base64 encoding...`);
    const fileParts = [];
    if (transcriptUrl) fileParts.push(buildBase64FileContent(await downloadAsBase64(transcriptUrl)));
    if (pptUrl)        fileParts.push(buildBase64FileContent(await downloadAsBase64(pptUrl)));
    const prompt = transcriptExtractorPrompt('', existingKpis, callMeta.call_date, FISCAL_YEAR_END, promptTemplate);
    userMessageContent = [{ type: 'text', text: prompt }, ...fileParts];
    console.log(`[summarization] PDF mode: ${fileParts.length} PDF(s) attached as base64`);
  } else {
    const truncatedText = combinedText.substring(0, TRANSCRIPT_CHAR_LIMIT);
    const prompt = transcriptExtractorPrompt(truncatedText, existingKpis, callMeta.call_date, FISCAL_YEAR_END, promptTemplate);
    userMessageContent = prompt;
    console.log(`[summarization] Text mode: prompt length ${prompt.length} chars`);
  }
  await job.updateProgress(40);

  console.log('[summarization] Calling LLM...');
  const llmParams = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: userMessageContent }] };
  if (outputSchema) llmParams.response_format = outputSchema;
  const { text: responseText, usage } = await llmStream(llmParams);
  logUsage('summarization', usage);
  await job.updateProgress(70);

  if (!responseText) throw new Error('Empty response from LLM');
  console.log(`[summarization] Raw LLM response (first 500 chars): ${responseText.slice(0, 500)}`);

  const extractedData = parseJson(responseText);
  const rawSignals    = extractedData.extracted_signals ?? [];
  console.log(`[summarization] LLM returned ${rawSignals.length} signals (top-level keys: ${Object.keys(extractedData).join(', ')})`);

  // Register any new KPIs the LLM discovered
  if (extractedData.new_kpis?.length > 0) {
    const kpiResult = await upsertNewKpis({ kpis: [], new_kpis: extractedData.new_kpis }, callMeta.basic_industry, 'transcript');
    console.log('[summarization] new_kpis upsert:', kpiResult);
    if (kpiResult.failed.length > 0) console.warn('[summarization] new_kpis failures:', kpiResult.failed);
  }
  await job.updateProgress(85);

  // Build shared base fields for every signal
  const lineageId = randomUUID();
  const sigBase = {
    call_id:         callId,
    ticker:          callMeta.company,
    company:         callMeta.company,
    fiscal_year:     callMeta.fiscal_year  ?? null,
    quarter:         callMeta.quarter      ?? null,
    call_date:       callMeta.call_date    ?? null,
    source_type:     'transcript',
    source_hash:     sourceHash,
    prompt_v:        promptV,
    schema_v:        '2.0.0',
    extractor_model: model,
    lineage_id:      lineageId,
  };

  // Normalize every signal through the canonical shape validator
  const signals = [];
  for (const raw of rawSignals) {
    try {
      signals.push(normalizeSignal(raw, sigBase));
    } catch (e) {
      console.warn(`[summarization] Skipping malformed signal (${raw?.signal_type}/${raw?.metric}): ${e.message}`);
    }
  }

  const written = await writeSignals(lineageId, signals);
  console.log(`[summarization] Signal Store: wrote ${written} signals for ${callId} (lineage: ${lineageId})`);

  await job.updateProgress(100);
  console.log(`[summarization] Job ${job.id} completed`);
  return { callId, signalsWritten: written, lineageId };
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('summarization', processSummarizationJob, {
  connection,
  concurrency: 25,
  limiter: { max: 30, duration: 1000 },
});

worker.on('completed', job       => console.log(`[summarization] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[summarization] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[summarization] Worker error:', err));

console.log('Summarization worker ready');

module.exports = worker;
