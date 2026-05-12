'use strict';

const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');

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

async function findJob(jobId) {
  const queues = ['summarization', 'qe_extraction', 'ai_insight_synthesis'];
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
  findJob,
};
