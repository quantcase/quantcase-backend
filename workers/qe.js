'use strict';

const { Worker }     = require('bullmq');
const { randomUUID } = require('crypto');
const connection     = require('../config/redis');
const prisma         = require('../config/prisma');
const openRouter     = require('../config/llm');
const { parseJson }  = require('../utils/workerUtils');
const { quarterlyEarningsPrompt } = require('../prompts/quarterly_earnings');
const { upsertNewKpis } = require('../services/db/kpis.db');
const { loadSkillConfig } = require('../utils/skillConfig');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');
const { writeSignals, cacheHit } = require('../services/db/signals.db');
const { normalizeSignal } = require('../utils/signalShape');

const QE_KPI_CONFIG = require('../lib/qe_kpi_config.json');
const { isBFSI }    = require('../utils/industryClassifier');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Returns a flat array of { abbr, label, aliases, section } — section is one of
// "balance_sheet" | "pnl" | "cashflow", used by the prompt to embed metric_family.
function getKpiConfigForPrompt(basicIndustry) {
  const industryKey = isBFSI(basicIndustry) ? 'bfsi' : 'non_bfsi';
  const config      = QE_KPI_CONFIG[industryKey];
  const kpis        = [];

  function extractKpis(obj, section) {
    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== 'object') continue;
      if (value.label && Array.isArray(value.aliases)) {
        kpis.push({ abbr: key, label: value.label, aliases: value.aliases, section });
      } else {
        extractKpis(value, section);
      }
    }
  }

  for (const section of ['balance_sheet', 'pnl', 'cashflow']) {
    if (config[section]) extractKpis(config[section], section);
  }

  return kpis;
}

async function buildPdfBlock(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF download failed: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { type: 'file', file: { filename: 'quarterly_report.pdf', file_data: `data:application/pdf;base64,${base64}` } };
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processQeJob(job) {
  const { callId, type } = job.data;
  console.log(`[qe] Processing job ${job.id} (callId: ${callId})`);

  await prisma.job.upsert({
    where:  { bullmqId: job.id },
    update: { status: 'processing' },
    create: { callId, type: type || 'qe_extraction', status: 'processing', bullmqId: job.id },
  });
  await job.updateProgress(10);

  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) throw new Error(`Earnings call ${callId} not found`);

  const qeUrl = call.quarterly_result_url?.trim();
  if (!qeUrl) throw new Error(`No quarterly_result_url for call ${callId}`);
  await job.updateProgress(20);

  // L1 cache check — QE source hash is the PDF URL (stable content identifier)
  const sourceHash  = computeSourceHash(qeUrl);
  const skillConfig = await loadSkillConfig('qe-extraction');
  const promptV     = computePromptVersion('qe-extraction', skillConfig.updatedAt);

  const hit = await cacheHit(callId, sourceHash, promptV, ['kpi']);
  if (hit) {
    console.log(`[qe] L1 cache hit for ${callId} — skipping LLM`);
    await job.updateProgress(100);
    return { cached: true, callId };
  }

  const kpis = getKpiConfigForPrompt(call.basic_industry);
  console.log(`[qe] ${kpis.length} KPIs loaded (industry: ${call.basic_industry})`);
  await job.updateProgress(35);

  const { model, maxTokens, outputSchema, promptTemplate } = skillConfig;
  const prompt = quarterlyEarningsPrompt(
    kpis,
    call.quarter     || '',
    call.fiscal_year || '',
    call.call_date   || '',
    promptTemplate,
  );
  console.log(`[qe] Prompt length: ${prompt.length} chars`);

  console.log('[qe] Downloading PDF...');
  const pdfBlock = await buildPdfBlock(qeUrl);

  console.log('[qe] Calling LLM...');
  const qeParams = {
    model,
    max_tokens: maxTokens,
    provider:   { order: ['Anthropic'], allow_fallbacks: false },
    messages:   [{ role: 'user', content: [pdfBlock, { type: 'text', text: prompt }] }],
    stream:     true,
  };
  if (outputSchema) qeParams.response_format = outputSchema;
  const stream = await openRouter.chat.completions.create(qeParams);
  let responseText = '';
  for await (const chunk of stream) responseText += chunk.choices[0]?.delta?.content ?? '';
  await job.updateProgress(75);

  if (!responseText) throw new Error('Empty response from LLM');
  console.log(`[qe] Raw LLM response (first 500 chars): ${responseText.slice(0, 500)}`);

  const extractedData = parseJson(responseText);
  const rawSignals    = extractedData.extracted_signals ?? [];
  console.log(`[qe] LLM returned ${rawSignals.length} signals (top-level keys: ${Object.keys(extractedData).join(', ')})`);

  // QE doesn't discover new KPIs (schema is fixed), but call upsert defensively
  if (extractedData.new_kpis?.length > 0) {
    await upsertNewKpis({ kpis: [], new_kpis: extractedData.new_kpis }, call.basic_industry, 'QE');
  }
  await job.updateProgress(90);

  const lineageId = randomUUID();
  const sigBase = {
    call_id:         callId,
    ticker:          call.company,
    company:         call.company,
    fiscal_year:     call.fiscal_year ?? null,
    quarter:         call.quarter     ?? null,
    call_date:       call.call_date   ?? null,
    source_type:     'qe',
    source_hash:     sourceHash,
    prompt_v:        promptV,
    schema_v:        '2.0.0',
    extractor_model: model,
    lineage_id:      lineageId,
  };

  const signals = [];
  for (const raw of rawSignals) {
    try {
      signals.push(normalizeSignal(raw, sigBase));
    } catch (e) {
      console.warn(`[qe] Skipping malformed signal (${raw?.metric}): ${e.message}`);
    }
  }

  const written = await writeSignals(lineageId, signals);
  console.log(`[qe] Signal Store: wrote ${written} signals for ${callId} (lineage: ${lineageId})`);

  await prisma.job.update({
    where: { bullmqId: job.id },
    data:  { status: 'completed', result: { callId, signalsWritten: written } },
  });

  await job.updateProgress(100);
  console.log(`[qe] Job ${job.id} completed — ${written} signals written`);
  return { callId, signalsWritten: written, lineageId };
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('qe_extraction', processQeJob, {
  connection,
  concurrency: 1,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job       => console.log(`[qe] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[qe] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[qe] Worker error:', err));

console.log('QE extraction worker ready');

module.exports = worker;
