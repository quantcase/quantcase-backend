'use strict';

const { randomUUID }    = require('crypto');
const { PDFDocument }   = require('pdf-lib');
const prisma            = require('../config/prisma');
const jobQueue          = require('../lib/jobQueue');

// Sizing tuned against pipeline_job_failures: LLM output was truncating
// (finish_reason=length) at the old page-per-chunk targets even when nowhere
// near V2_MAX_CHUNKS — the model's real output ceiling (~65K tokens for
// google/gemini-2.5-flash-lite) is below the configured Skill.maxTokens, so
// the fix is smaller chunks, not a bigger maxTokens. MAX_CHUNKS caps are
// raised well past what these smaller per-chunk sizes need for real
// documents — they're just a safety net against pathologically long PDFs.
const V2_PAGES_PER_CHUNK     = 8;  // transcript
const V2_PPT_PAGES_PER_CHUNK = 6;  // PPT slides are more data-dense per page than transcripts
const V2_MAX_CHUNKS          = 20;
const AR_V2_PAGES_PER_CHUNK  = 10;
const AR_V2_MAX_CHUNKS       = 150; // largest AR seen in pipeline_job_failures was ~980 pages (49 chunks @ old 20/chunk); this keeps ~10/chunk up to ~1500 pages

const STATE_TO_STATUS = {
  waiting:   'pending',
  delayed:   'pending',
  paused:    'pending',
  active:    'processing',
  completed: 'completed',
  failed:    'failed',
};


async function addHtmlSkillJob({
  slug, ticker, fiscal_year = null, quarter = null, force = false,
  transcript_signal_types = null, ppt_signal_types = null, annual_report_signal_types = null,
  max_transcript_qtrs = null, max_ppt_qtrs = null, max_annual_report_years = null,
}) {
  return jobQueue.addJob('html_skill', {
    slug, ticker, fiscal_year, quarter, force,
    transcript_signal_types, ppt_signal_types, annual_report_signal_types,
    max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
    type: 'html_skill',
  });
}

async function addHtmlIncrementalSkillJob({
  slug, ticker, callId, force = false, historic = false, configKey = null,
}) {
  return jobQueue.addJob('html_skill_incremental', {
    slug, ticker, callId, force, historic, configKey,
    type: 'html_skill_incremental',
  });
}

async function addHtmlCompressedSkillJob({
  slug, ticker, callId, force = false, historic = false, configKey = null,
}) {
  return jobQueue.addJob('html_skill_compressed', {
    slug, ticker, callId, force, historic, configKey,
    type: 'html_skill_compressed',
  });
}

async function addHtmlSkillPreviewJob({ ticker, data_extraction_prompt, html_template_prompt, use_template_engine, enable_data_validation, data_validation_loops, enable_html_validation, transcript_signal_types, ppt_signal_types, annual_report_signal_types, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, market_data_signal_types = [], max_market_data_months = null, force = false }) {
  return jobQueue.addJob('html_skill_preview', {
    ticker, data_extraction_prompt, html_template_prompt, use_template_engine, enable_data_validation, data_validation_loops, enable_html_validation,
    transcript_signal_types:    transcript_signal_types    ?? [],
    ppt_signal_types:           ppt_signal_types           ?? [],
    annual_report_signal_types: annual_report_signal_types ?? [],
    extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens,
    max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
    market_data_signal_types: market_data_signal_types ?? [],
    max_market_data_months,
    force,
    type: 'html_skill_preview',
  });
}

async function findJob(jobId) {
  const queues = ['ai_insight_synthesis', 'html_skill', 'html_skill_preview', 'html_skill_incremental', 'html_skill_compressed'];
  for (const q of queues) {
    const job = await jobQueue.getJobStatus(q, jobId);
    if (job) {
      const result = {
        id:          job.id,
        callId:      job.data?.callId   ?? null,
        type:        job.data?.type     ?? null,
        status:      STATE_TO_STATUS[job.state] ?? job.state,
        bullmqId:    job.id,
        createdAt:   null,
        updatedAt:   null,
        completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        error:       job.failedReason ?? null,
        bullmqObject: {
          id:           job.id,
          name:         job.name,
          state:        job.state,
          progress:     job.progress,
          attemptsMade: job.attemptsMade,
          returnvalue:  job.returnvalue,
        },
      };

      // Embed output inline for completed preview jobs so the frontend needs no extra fetch
      if (result.type === 'html_skill_preview' && result.status === 'completed' && job.returnvalue?.outputId) {
        const row = await prisma.htmlSkillOutput.findUnique({ where: { id: job.returnvalue.outputId } });
        if (row) {
          result.output = {
            raw_html:      row.raw_html,
            input_tokens:  row.input_tokens,
            output_tokens: row.output_tokens,
            cost_usd:      row.cost_usd,
          };
        }
      }

      return result;
    }
  }
  return null;
}

async function addLensComputationJob(callId, lensSlug) {
  return jobQueue.addJob('lens_computation', { callId, lensSlug, type: 'lens_computation' });
}

async function addSummarizationV2Jobs(callId) {
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error('Call not found'); err.status = 404; throw err;
  }
  if (!call.transcript_url?.trim()) {
    const err = new Error('No transcript URL for this call'); err.status = 400; throw err;
  }

  const res = await fetch(call.transcript_url);
  if (!res.ok) {
    const err = new Error(`PDF download failed (${res.status})`); err.status = 502; throw err;
  }
  const arrayBuffer = await res.arrayBuffer();
  const srcDoc      = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  const pageCount   = srcDoc.getPageCount();

  const numChunks = Math.min(V2_MAX_CHUNKS, Math.max(1, Math.ceil(pageCount / V2_PAGES_PER_CHUNK)));
  const perChunk  = Math.ceil(pageCount / numChunks);
  const lineageId = randomUUID();
  const jobs      = [];

  for (let i = 0; i < numChunks; i++) {
    const pageStart = i * perChunk;
    const pageEnd   = Math.min(pageStart + perChunk, pageCount);
    const job = await jobQueue.addJob('summarization_v2', {
      callId,
      transcriptUrl: call.transcript_url,
      pageStart,
      pageEnd,
      lineageId,
      chunkIndex:  i + 1,
      totalChunks: numChunks,
    });
    jobs.push({ id: job.id, pages: `${pageStart + 1}-${pageEnd}` });
  }

  return { callId, lineageId, pageCount, chunks: numChunks, jobs };
}

async function addSummarizationV2PptJobs(callId) {
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error('Call not found'); err.status = 404; throw err;
  }
  if (!call.ppt_url?.trim()) {
    const err = new Error('No PPT URL for this call'); err.status = 400; throw err;
  }

  const res = await fetch(call.ppt_url);
  if (!res.ok) {
    const err = new Error(`PPT PDF download failed (${res.status})`); err.status = 502; throw err;
  }
  const arrayBuffer = await res.arrayBuffer();
  const srcDoc      = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  const pageCount   = srcDoc.getPageCount();

  const numChunks = Math.min(V2_MAX_CHUNKS, Math.max(1, Math.ceil(pageCount / V2_PPT_PAGES_PER_CHUNK)));
  const perChunk  = Math.ceil(pageCount / numChunks);
  const lineageId = randomUUID();
  const jobs      = [];

  for (let i = 0; i < numChunks; i++) {
    const pageStart = i * perChunk;
    const pageEnd   = Math.min(pageStart + perChunk, pageCount);
    const job = await jobQueue.addJob('summarization_v2_ppt', {
      callId,
      pptUrl: call.ppt_url,
      pageStart,
      pageEnd,
      lineageId,
      chunkIndex:  i + 1,
      totalChunks: numChunks,
    });
    jobs.push({ id: job.id, pages: `${pageStart + 1}-${pageEnd}` });
  }

  return { callId, lineageId, pageCount, chunks: numChunks, jobs };
}

async function addSummarizationV2AnnualReportJobs(reportId) {
  const report = await prisma.annual_reports.findUnique({ where: { id: BigInt(reportId) } });
  if (!report) {
    const err = new Error('Annual report not found'); err.status = 404; throw err;
  }
  if (!report.annual_report_url?.trim()) {
    const err = new Error('No annual_report_url for this report'); err.status = 400; throw err;
  }

  const res = await fetch(report.annual_report_url);
  if (!res.ok) {
    const err = new Error(`Annual report PDF download failed (${res.status})`); err.status = 502; throw err;
  }
  const arrayBuffer = await res.arrayBuffer();
  const srcDoc      = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  const pageCount   = srcDoc.getPageCount();

  const numChunks = Math.min(AR_V2_MAX_CHUNKS, Math.max(1, Math.ceil(pageCount / AR_V2_PAGES_PER_CHUNK)));
  const perChunk  = Math.ceil(pageCount / numChunks);
  const lineageId = randomUUID();
  const jobs      = [];

  for (let i = 0; i < numChunks; i++) {
    const pageStart = i * perChunk;
    const pageEnd   = Math.min(pageStart + perChunk, pageCount);
    const job = await jobQueue.addJob('summarization_v2_annual_report', {
      reportId:         reportId.toString(),
      annualReportUrl:  report.annual_report_url,
      pageStart,
      pageEnd,
      lineageId,
      chunkIndex:  i + 1,
      totalChunks: numChunks,
    });
    jobs.push({ id: job.id, pages: `${pageStart + 1}-${pageEnd}` });
  }

  return { reportId: reportId.toString(), lineageId, pageCount, chunks: numChunks, jobs };
}

module.exports = {
  addLensComputationJob,
  addSummarizationV2Jobs,
  addSummarizationV2PptJobs,
  addSummarizationV2AnnualReportJobs,
  addHtmlSkillJob,
  addHtmlSkillPreviewJob,
  addHtmlIncrementalSkillJob,
  addHtmlCompressedSkillJob,
  findJob,
};
