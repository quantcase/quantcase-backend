'use strict';

const { Worker }        = require('bullmq');
const { PDFDocument }   = require('pdf-lib');
const connection        = require('../config/redis');
const prisma            = require('../config/prisma');
const { llmStream, parseJson }          = require('../utils/workerUtils');
const { transcriptExtractorPromptV2 }   = require('../prompts/transcript_call_v2');
const { upsertNewKpis }                 = require('../services/db/kpis.db');
const { loadSkillConfig }               = require('../utils/skillConfig');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');

const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31';

// ─── PDF helpers ──────────────────────────────────────────────────────────────

async function downloadPdf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download PDF (${res.status}): ${url}`);
  return res.arrayBuffer();
}

async function extractPageRange(arrayBuffer, pageStart, pageEnd) {
  const srcDoc = await PDFDocument.load(arrayBuffer);
  const subDoc = await PDFDocument.create();
  const indices = Array.from({ length: pageEnd - pageStart }, (_, i) => pageStart + i);
  const pages  = await subDoc.copyPages(srcDoc, indices);
  pages.forEach(p => subDoc.addPage(p));
  return subDoc.saveAsBase64();
}

function pdfContent(base64) {
  return { type: 'file', file: { file_data: `data:application/pdf;base64,${base64}` } };
}

// ─── KPI reference ────────────────────────────────────────────────────────────

async function getExistingKpisForPrompt(basicIndustry) {
  const transcriptWhere = basicIndustry
    ? { source: 'transcript', industry: { has: basicIndustry } }
    : { source: 'transcript' };
  const [qeKpis, transcriptKpis] = await Promise.all([
    prisma.kpi.findMany({ where: { source: 'QE' } }),
    prisma.kpi.findMany({ where: transcriptWhere }),
  ]);
  return [...qeKpis, ...transcriptKpis]
    .filter(k => !/^new_kpis/i.test(k.abbr))
    .map(k => ({
      id:           k.id,
      abbr:         k.abbr,
      full_form:    k.full_form,
      kpi_type:     k.kpi_type    ?? undefined,
      denomination: k.denomination ?? undefined,
      source:       k.source,
    }));
}

// ─── Metric extraction ────────────────────────────────────────────────────────

function extractMetric(sig) {
  switch (sig.signal_type) {
    case 'guidance':              return sig.metric ?? null;
    case 'claim':                 return sig.metric ?? null;
    case 'industry_signal':       return sig.topic ?? null;
    case 'capital_allocation':    return sig.allocation_category ?? null;
    case 'disclosure_quality':    return sig.topic ?? null;
    case 'distribution_customer': return sig.segment_or_channel ?? sig.distribution_category ?? null;
    case 'growth_forecast':       return sig.forecast_metric ?? null;
    case 'earnings_quality':      return sig.metric_affected ?? sig.eq_category ?? null;
    case 'kpi':                   return sig.metric ?? null;
    case 'mgmt_tone':             return 'dominant_tone';
    case 'analyst_questions':     return sig.question_topic ?? null;
    case 'guidance_revision':     return sig.prior_guidance?.metric ?? sig.revised_guidance?.metric ?? null;
    case 'pricing_power':         return 'pricing_realization';
    case 'competitive_position':  return sig.comparison_dimension ?? null;
    default:                      return sig.metric ?? sig.topic ?? null;
  }
}

// ─── Signal writer ────────────────────────────────────────────────────────────

async function writeSignals(lineageId, callId, ticker, company, callMeta, signals, sourceHash, promptV, model) {
  if (!signals.length) return 0;
  const rows = signals.map(sig => ({
    call_id:         callId,
    ticker,
    company,
    fiscal_year:     callMeta.fiscal_year  ?? null,
    quarter:         callMeta.quarter      ?? null,
    call_date:       callMeta.call_date    ?? null,
    signal_type:     sig.signal_type       ?? 'unknown',
    source_context:  sig.source_context    ?? null,
    source_stmt_id:  sig.source_statement_id ?? null,
    signal_seq_id:   sig.signal_id         ?? null,
    metric:          extractMetric(sig),
    impact:          sig.impact            ?? null,
    severity:        sig.severity          ?? null,
    statement:       sig.statement         ?? null,
    data:            sig,
    source_hash:     sourceHash,
    prompt_v:        promptV,
    extractor_model: model,
    lineage_id:      lineageId,
  }));
  const result = await prisma.transcriptSignalV2.createMany({ data: rows, skipDuplicates: false });
  return result.count;
}

// ─── Job processor ────────────────────────────────────────────────────────────
// Each job = one PDF chunk (page range). analyze_L1_v2.js dispatches N jobs
// per call, sharing one lineageId so signals can be grouped by call.

async function processSummarizationV2Job(job) {
  const { callId, transcriptUrl, pageStart, pageEnd, lineageId, chunkIndex, totalChunks } = job.data;
  console.log(`[summarization-v2] Job ${job.id} — callId: ${callId} chunk ${chunkIndex}/${totalChunks} (pages ${pageStart + 1}–${pageEnd})`);

  if (!transcriptUrl) throw new Error(`No transcript URL for call ${callId}`);
  await job.updateProgress(10);

  const skillConfig = await loadSkillConfig('summarization-v2');
  const sourceHash  = computeSourceHash(`${transcriptUrl}:${pageStart}:${pageEnd}`);
  const promptV     = computePromptVersion('summarization-v2', skillConfig.updatedAt);

  // Skip if this exact chunk has already been processed
  const existing = await prisma.transcriptSignalV2.count({
    where: { call_id: callId, source_hash: sourceHash, prompt_v: promptV, is_invalidated: false },
  });
  if (existing > 0) {
    console.log(`[summarization-v2] Chunk ${chunkIndex} already processed — skipping`);
    await job.updateProgress(100);
    return { cached: true, callId, chunkIndex };
  }

  const callMeta = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, fiscal_year: true, quarter: true, call_date: true, basic_industry: true },
  });
  if (!callMeta) throw new Error(`Earnings call ${callId} not found`);

  const existingKpis = await getExistingKpisForPrompt(callMeta.basic_industry);
  console.log(`[summarization-v2] ${existingKpis.length} KPIs loaded`);
  await job.updateProgress(20);

  console.log(`[summarization-v2] Downloading PDF...`);
  const arrayBuffer = await downloadPdf(transcriptUrl);
  const base64      = await extractPageRange(arrayBuffer, pageStart, pageEnd);
  await job.updateProgress(40);

  const { model, maxTokens, outputSchema } = skillConfig;
  const promptText = transcriptExtractorPromptV2('', existingKpis, callMeta.call_date, FISCAL_YEAR_END);
  const content    = [{ type: 'text', text: promptText }, pdfContent(base64)];

  const llmParams = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  if (outputSchema) llmParams.response_format = outputSchema;

  console.log(`[summarization-v2] Calling LLM for chunk ${chunkIndex}/${totalChunks}...`);
  const responseText = await llmStream(llmParams);
  if (!responseText) throw new Error(`Empty LLM response for chunk ${chunkIndex}`);
  await job.updateProgress(80);

  const extracted = parseJson(responseText);
  const signals   = extracted.signals  ?? [];
  const newKpis   = extracted.new_kpis ?? [];
  console.log(`[summarization-v2] Chunk ${chunkIndex}: ${signals.length} signals, ${newKpis.length} new_kpis`);

  if (newKpis.length > 0) {
    const kpiResult = await upsertNewKpis({ kpis: [], new_kpis: newKpis }, callMeta.basic_industry, 'transcript');
    if (kpiResult.failed?.length > 0) console.warn('[summarization-v2] new_kpis failures:', kpiResult.failed);
  }

  const written = await writeSignals(
    lineageId, callId,
    callMeta.company, callMeta.company,
    callMeta, signals,
    sourceHash, promptV, model,
  );
  console.log(`[summarization-v2] Wrote ${written} signals`);

  await job.updateProgress(100);
  return { callId, chunkIndex, totalChunks, signalsWritten: written, lineageId };
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('summarization_v2', processSummarizationV2Job, {
  connection,
  concurrency: 10,
  limiter: { max: 15, duration: 1000 },
});

worker.on('completed', job       => console.log(`[summarization-v2] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[summarization-v2] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[summarization-v2] Worker error:', err));

console.log('Summarization V2 worker ready');

module.exports = worker;
