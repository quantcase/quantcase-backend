'use strict';

const prisma    = require('../config/prisma');
const jobQueue  = require('../lib/jobQueue');
const { enqueuePlugin, enqueueSkillJob } = require('./plugins.service');

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

// Human-readable labels for each skill slug in the opportunity pipeline
const SKILL_LABELS = {
  'nse-industry':               'Analyzing NSE Industry',
  'ofactor-industry':           'Analyzing Industry Overview',
  'ofactor-competition':        'Analyzing Competition',
  'ofactor-financial-strength-core':     'Analyzing Financial Strength',
  'ofactor-financial-strength-insights': 'Enriching Financial Insights',
  'ofactor-customer-traction':           'Analyzing Customer Traction',
  'ofactor-final-takeaways':    'Generating Final Takeaways',
};

/**
 * Enqueue the first skill in the "opportunity" plugin chain.
 * Each skill, when completed by the worker, enqueues the next skill in order.
 * This ensures sequential execution: nse-industry → ofactor-industry → competition
 * → financial_strength → customer_traction → final_takeaways.
 *
 * Returns the first BullMQ job with an `all_steps` array pre-populated on the DB record.
 */
async function addFullOpportunityAnalysis(callId) {
  const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
  if (!call) {
    const err = new Error('Call not found');
    err.status = 404;
    throw err;
  }

  const plugin = await prisma.plugin.findUnique({
    where: { slug: 'opportunity' },
    include: {
      pluginSkills: {
        where:   { skill: { isActive: true } },
        orderBy: { order: 'asc' },
        include: { skill: true },
      },
    },
  });
  if (!plugin?.isActive) {
    const err = new Error('Plugin "opportunity" not found or inactive');
    err.status = 404;
    throw err;
  }
  if (!plugin.pluginSkills.length) throw new Error('No active skills in "opportunity" plugin');

  const allSkills = plugin.pluginSkills;
  const firstPs   = allSkills[0];

  // Build the initial all_steps array — first step is "processing", rest are "waiting"
  const all_steps = allSkills.map((ps, i) => ({
    analysis_type: ps.skill.slug,
    label:         SKILL_LABELS[ps.skill.slug] ?? ps.skill.name,
    status:        i === 0 ? 'processing' : 'waiting',
  }));

  // Enqueue the first job — rootJobBullmqId is its own ID (known after enqueue)
  const firstJob = await enqueueSkillJob(plugin.slug, firstPs, {
    callId,
    subjectTicker: call.company,
    all_steps,
    rootJobBullmqId: null, // placeholder; updated in DB below after we have the ID
  });

  const rootJobBullmqId = firstJob.id;

  // Persist all_steps and rootJobBullmqId into the DB Job record
  await prisma.job.upsert({
    where:  { bullmqId: rootJobBullmqId },
    update: { result: { all_steps, rootJobBullmqId } },
    create: {
      callId,
      type:     firstPs.skill.slug,
      status:   'processing',
      bullmqId: rootJobBullmqId,
      result:   { all_steps, rootJobBullmqId },
    },
  });

  // Also patch the BullMQ job data so the worker has rootJobBullmqId when it runs
  await firstJob.updateData({ ...firstJob.data, rootJobBullmqId });

  firstJob.all_steps = all_steps;
  return firstJob;
}

/**
 * Search for a job across all known queues.
 * Returns { job, status } or null if not found.
 */
async function findJob(jobId) {
  const queues = ['summarization', 'ofactor_analysis', 'deal_analysis', 'qe_extraction', 'management_analysis'];
  for (const q of queues) {
    const job = await jobQueue.getJobStatus(q, jobId);
    if (job) {
      // all_steps lives on the root job's DB record.
      // job.data.rootJobBullmqId points to the root job; for the root job itself it equals job.id.
      const rootBullmqId = job.data?.rootJobBullmqId ?? job.id;
      const rootDbJob = await prisma.job.findUnique({ where: { bullmqId: rootBullmqId } });
      const all_steps = rootDbJob?.result?.all_steps ?? null;

      return {
        id:          job.id,
        callId:      job.data?.callId   ?? null,
        type:        job.data?.type     ?? null,
        status:      STATE_TO_STATUS[job.state] ?? job.state,
        bullmqId:    job.id,
        all_steps,
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
  addFullOpportunityAnalysis,
  findJob,
};
