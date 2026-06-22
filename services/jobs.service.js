'use strict';

const { randomUUID }    = require('crypto');
const { PDFDocument }   = require('pdf-lib');
const prisma            = require('../config/prisma');
const jobQueue          = require('../lib/jobQueue');
const { ProwessHelper } = require('../utils/prowessHelper');

const V2_PAGES_PER_CHUNK    = 15;
const V2_MAX_CHUNKS         = 4;
const AR_V2_PAGES_PER_CHUNK = 20;

const STATE_TO_STATUS = {
  waiting:   'pending',
  delayed:   'pending',
  paused:    'pending',
  active:    'processing',
  completed: 'completed',
  failed:    'failed',
};

async function addSummarizationJob(callId) {
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error('Call not found');
    err.status = 404;
    throw err;
  }

  const hasTranscript = call.transcript_text && call.transcript_text.trim().length > 0;
  const hasPPT        = call.ppt_text && call.ppt_text.trim().length > 0;

  if (!hasTranscript && !hasPPT) {
    const hasTranscriptUrl = call.transcript_url && call.transcript_url.trim().length > 0;
    const hasPptUrl        = call.ppt_url && call.ppt_url.trim().length > 0;
    if (!hasTranscriptUrl && !hasPptUrl) {
      const err = new Error('No transcript or PPT text available for this call');
      err.status = 400;
      throw err;
    }
    return jobQueue.addJob('summarization', {
      callId,
      transcriptUrl: hasTranscriptUrl ? call.transcript_url : null,
      pptUrl:        hasPptUrl        ? call.ppt_url        : null,
      type:          'summarization',
    });
  }

  return jobQueue.addJob('summarization', {
    callId,
    transcriptText: call.transcript_text,
    pptText:        call.ppt_text,
    type:           'summarization',
  });
}

async function addQeExtractionJob(callId) {
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error('Call not found');
    err.status = 404;
    throw err;
  }
  if (!call.quarterly_result_url?.trim()) {
    const err = new Error('No quarterly_result_url for this call');
    err.status = 400;
    throw err;
  }

  return jobQueue.addJob('qe_extraction', { callId, type: 'qe_extraction' });
}

async function addProwessExtractionJob(callId) {
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error('Call not found');
    err.status = 404;
    throw err;
  }

  // Verify prowess company mapping and data exist before enqueuing
  const helper = new ProwessHelper(prisma);
  const prowessName = await helper.resolveProwessName(call.company);
  if (!prowessName) {
    const err = new Error(`No Prowess company mapping found for ticker "${call.company}"`);
    err.status = 400;
    throw err;
  }
  const rowCount = await prisma.prowessValueNew.count({
    where: { company: prowessName, fiscal_year: { lte: call.fiscal_year } },
  });
  if (!rowCount) {
    const err = new Error(`No Prowess data found for "${prowessName}" up to ${call.fiscal_year}`);
    err.status = 400;
    throw err;
  }

  return jobQueue.addJob('prowess_extraction', { callId, type: 'prowess_extraction' });
}

async function addHtmlSkillJob({ slug, ticker, fiscal_year = null, quarter = null, force = false }) {
  return jobQueue.addJob('html_skill', { slug, ticker, fiscal_year, quarter, force, type: 'html_skill' });
}

async function addHtmlSkillPreviewJob({ ticker, skill_prompt, signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, force = false }) {
  return jobQueue.addJob('html_skill_preview', {
    ticker, skill_prompt, signal_types, model, max_tokens,
    max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
    force,
    type: 'html_skill_preview',
  });
}

async function findJob(jobId) {
  const queues = ['summarization', 'qe_extraction', 'prowess_extraction', 'ai_insight_synthesis', 'html_skill', 'html_skill_preview'];
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

  const numChunks = Math.min(V2_MAX_CHUNKS, Math.max(1, Math.ceil(pageCount / V2_PAGES_PER_CHUNK)));
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

  const numChunks = Math.max(1, Math.ceil(pageCount / AR_V2_PAGES_PER_CHUNK));
  const lineageId = randomUUID();
  const jobs      = [];

  for (let i = 0; i < numChunks; i++) {
    const pageStart = i * AR_V2_PAGES_PER_CHUNK;
    const pageEnd   = Math.min(pageStart + AR_V2_PAGES_PER_CHUNK, pageCount);
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
  addSummarizationJob,
  addQeExtractionJob,
  addProwessExtractionJob,
  addLensComputationJob,
  addSummarizationV2Jobs,
  addSummarizationV2PptJobs,
  addSummarizationV2AnnualReportJobs,
  addHtmlSkillJob,
  addHtmlSkillPreviewJob,
  findJob,
};
