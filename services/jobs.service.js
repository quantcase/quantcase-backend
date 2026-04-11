'use strict';

const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');
const { enqueuePlugin } = require('./plugins.service');

const VALID_OFACTOR_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'customer_traction', 'final_takeaways']);

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
    const err = new Error('No transcript or PPT text available for this call');
    err.status = 400;
    throw err;
  }

  const enqueuedJobs = await enqueuePlugin('management', {
    callId,
    companyName:    call.company_name || call.company,
    transcriptText: call.transcript_text,
    pptText:        call.ppt_text,
  });

  // Return the first job (summarization) as the primary job reference, matching prior API contract
  return enqueuedJobs[0];
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

async function addOFactorAnalysisJob(callId, section) {
  if (!section) {
    const err = new Error('section is required in request body');
    err.status = 400;
    throw err;
  }
  if (!VALID_OFACTOR_SECTIONS.has(section)) {
    const err = new Error(`Invalid section "${section}". Must be one of: ${[...VALID_OFACTOR_SECTIONS].join(', ')}`);
    err.status = 400;
    throw err;
  }

  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error('Call not found');
    err.status = 404;
    throw err;
  }

  return jobQueue.addJob('ofactor_analysis', {
    callId,
    type:          'ofactor_analysis',
    subjectTicker: call.company,
    section,
  }, { jobId: `ofactor_${callId}_${section}` });
}

/**
 * Enqueue all 5 opportunity sections at once via the "opportunity" plugin.
 */
async function addFullOpportunityAnalysis(callId) {
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error('Call not found');
    err.status = 404;
    throw err;
  }

  return enqueuePlugin('opportunity', {
    callId,
    subjectTicker: call.company,
  });
}

/**
 * Search for a job across all known queues.
 * Returns { job, status } or null if not found.
 */
async function findJob(jobId) {
  const queues = ['summarization', 'ofactor_analysis', 'deal_analysis', 'qe_extraction'];
  for (const q of queues) {
    const job = await jobQueue.getJobStatus(q, jobId);
    if (job) {
      return {
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
    }
  }
  return null;
}

module.exports = {
  addSummarizationJob,
  addQeExtractionJob,
  addOFactorAnalysisJob,
  addFullOpportunityAnalysis,
  findJob,
  VALID_OFACTOR_SECTIONS,
};
