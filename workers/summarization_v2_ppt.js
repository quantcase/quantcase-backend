'use strict';

const { Worker }      = require('bullmq');
const { PDFDocument } = require('pdf-lib');
const connection      = require('../config/redis');
const prisma          = require('../config/prisma');
const { llmStream, parseJson, logUsage, wlog } = require('../utils/workerUtils');
const { pptExtractorPromptV2 }           = require('../prompts/ppt_call_v2');
const { upsertNewKpis }                  = require('../services/db/kpis.db');
const { loadSkillConfig }                = require('../utils/skillConfig');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');
const { downloadPdfCached }              = require('../utils/pdfCache');

const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31';

// PDFDocument.load() expands a PDF 3-5x in heap. Cap concurrent loads so
// chunk-jobs for the same PDF don't each hold a full copy simultaneously.
const PDF_LOAD_CONCURRENCY = 1;
const pdfSemaphore = (() => {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      return new Promise(resolve => {
        if (active < PDF_LOAD_CONCURRENCY) { active++; resolve(); }
        else queue.push(resolve);
      });
    },
    release() {
      if (queue.length) queue.shift()();
      else active--;
    },
  };
})();

// ─── PDF helpers ──────────────────────────────────────────────────────────────

async function extractPageRange(arrayBuffer, pageStart, pageEnd) {
  const srcDoc = await PDFDocument.load(arrayBuffer);
  const subDoc = await PDFDocument.create();
  const indices = Array.from({ length: pageEnd - pageStart }, (_, i) => pageStart + i);
  const pages   = await subDoc.copyPages(srcDoc, indices);
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
    // Raw leaves only -- a computed/formula Kpi (STOCK_CAGR_3Y, TTM_EBITDA,
    // REV_CAGR_5Y, ...) is a derived ratio, never something a transcript
    // reports as a distinct figure, so including it here only invites the
    // LLM to spuriously match transcript text against an abbr that can
    // never actually appear as an extractable raw value. registry_enabled
    // is deliberately NOT filtered on -- that flag belongs to the
    // formulaRegistry/resolver pipeline, unrelated to this one.
    prisma.kpi.findMany({ where: { source: 'QE', formula_expression: null } }),
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
    case 'milestone':             return sig.metric ?? null;
    case 'ongoing':               return sig.metric ?? null;
    case 'industry_signal':       return sig.topic ?? null;
    case 'capital_allocation':    return sig.category ?? sig.allocation_category ?? null;
    case 'disclosure_quality':    return sig.topic ?? null;
    case 'distribution_customer': return sig.topic ?? sig.segment_or_channel ?? null;
    case 'growth_forecast':       return sig.metric ?? null;
    case 'earnings_quality':      return sig.metric ?? sig.metric_affected ?? sig.eq_category ?? null;
    case 'kpi':                   return sig.metric ?? null;
    case 'competitive_position':  return sig.category ?? sig.comparison_dimension ?? null;
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
    source_doc_type: 'ppt',
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
// Each job = one PDF chunk (page range). The dispatcher in jobs.service.js
// splits the PPT into chunks and enqueues N jobs sharing one lineageId.

async function processSummarizationV2PptJob(job) {
  const { callId, pptUrl, pageStart, pageEnd, lineageId, chunkIndex, totalChunks } = job.data;
  wlog.info(`[summarization-v2-ppt] Job ${job.id} — callId: ${callId} chunk ${chunkIndex}/${totalChunks} (pages ${pageStart + 1}–${pageEnd})`);

  if (!pptUrl) throw new Error(`No PPT URL for call ${callId}`);
  await job.updateProgress(10);

  const skillConfig = await loadSkillConfig('summarization-v2-ppt');
  const sourceHash  = computeSourceHash(`ppt:${pptUrl}:${pageStart}:${pageEnd}`);
  const promptV     = computePromptVersion('summarization-v2-ppt', skillConfig.updatedAt);

  // Skip if this exact chunk has already been processed
  const existing = await prisma.transcriptSignalV2.count({
    where: { call_id: callId, source_hash: sourceHash, prompt_v: promptV, is_invalidated: false },
  });
  if (existing > 0) {
    wlog.warn(`[summarization-v2-ppt] Chunk ${chunkIndex} already processed — skipping`);
    await job.updateProgress(100);
    return { cached: true, callId, chunkIndex };
  }

  const callMeta = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, fiscal_year: true, quarter: true, call_date: true, basic_industry: true },
  });
  if (!callMeta) throw new Error(`Earnings call ${callId} not found`);

  const existingKpis = await getExistingKpisForPrompt(callMeta.basic_industry);
  wlog.info(`[summarization-v2-ppt] ${existingKpis.length} KPIs loaded`);
  await job.updateProgress(20);

  wlog.info(`[summarization-v2-ppt] Downloading PPT PDF (cached)...`);
  await pdfSemaphore.acquire();
  let base64;
  try {
    let arrayBuffer = await downloadPdfCached(pptUrl);
    base64          = await extractPageRange(arrayBuffer, pageStart, pageEnd);
    arrayBuffer     = null;
  } finally {
    pdfSemaphore.release();
  }
  await job.updateProgress(40);

  const { model, maxTokens, outputSchema } = skillConfig;
  const promptText = pptExtractorPromptV2(existingKpis, callMeta.call_date, FISCAL_YEAR_END);
  const content    = [{ type: 'text', text: promptText }, pdfContent(base64)];
  base64 = null; // base64 is now embedded in content; release the duplicate reference

  const llmParams = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  if (outputSchema) llmParams.response_format = outputSchema;

  wlog.info(`[summarization-v2-ppt] Calling LLM for chunk ${chunkIndex}/${totalChunks}...`);
  const { text: responseText, usage } = await llmStream(llmParams, { vertex: true });
  logUsage('summarization-v2-ppt', usage);
  if (!responseText) throw new Error(`Empty LLM response for chunk ${chunkIndex}`);
  await job.updateProgress(80);

  const extracted = parseJson(responseText);
  const signals   = extracted.signals  ?? [];
  const newKpis   = extracted.new_kpis ?? [];
  wlog.done(`[summarization-v2-ppt] Chunk ${chunkIndex}: ${signals.length} signals, ${newKpis.length} new_kpis`);

  if (newKpis.length > 0) {
    const kpiResult = await upsertNewKpis({ kpis: [], new_kpis: newKpis }, callMeta.basic_industry, 'transcript');
    if (kpiResult.failed?.length > 0) wlog.warn(`[summarization-v2-ppt] new_kpis failures: ${JSON.stringify(kpiResult.failed)}`);
  }

  const written = await writeSignals(
    lineageId, callId,
    callMeta.company, callMeta.company,
    callMeta, signals,
    sourceHash, promptV, model,
  );
  wlog.done(`[summarization-v2-ppt] Wrote ${written} signals`);

  await job.updateProgress(100);
  return { callId, chunkIndex, totalChunks, signalsWritten: written, lineageId };
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker('summarization_v2_ppt', processSummarizationV2PptJob, {
  connection,
  concurrency: 25,
  limiter: { max: 50, duration: 1000 },
  lockDuration: 300000, // 5 min — LLM calls can take 60–120s; default 30s causes lock renewal failures
});

worker.on('completed', job       => wlog.done(`[summarization-v2-ppt] Job ${job.id} completed`));
worker.on('failed', async (job, err) => {
  wlog.error(`[summarization-v2-ppt] Job ${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`);
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const d = job?.data ?? {};
  await prisma.pipelineJobFailure.upsert({
    where:  { bullmq_job_id: String(job.id) },
    create: { queue: 'summarization_v2_ppt', bullmq_job_id: String(job.id), call_id: d.callId ?? '', source_doc_type: 'ppt', chunk_index: d.chunkIndex ?? null, total_chunks: d.totalChunks ?? null, lineage_id: d.lineageId ?? null, error_message: err.message, attempts_made: job.attemptsMade },
    update: { error_message: err.message, attempts_made: job.attemptsMade },
  }).catch(e => wlog.error(`[summarization-v2-ppt] Failed to record failure: ${e.message}`));
});
worker.on('error',     err       => wlog.error(`[summarization-v2-ppt] Worker error: ${err}`));

wlog.done('Summarization V2 PPT worker ready');

module.exports = worker;
