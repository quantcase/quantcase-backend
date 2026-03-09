'use strict';

const prisma    = require('../lib/prisma');
const jobQueue  = require('../lib/jobQueue');

const VALID_OFACTOR_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'customer_traction']);

const STATE_TO_STATUS = {
  waiting:   'pending',
  delayed:   'pending',
  paused:    'pending',
  active:    'processing',
  completed: 'completed',
  failed:    'failed',
};

async function enqueueSummarization(req, res) {
  try {
    const { callId } = req.params;

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }

    const hasTranscript = call.transcript_text && call.transcript_text.trim().length > 0;
    const hasPPT = call.ppt_text && call.ppt_text.trim().length > 0;
    if (!hasTranscript && !hasPPT) {
      return res.status(400).json({ success: false, error: 'No transcript or PPT text available for this call' });
    }

    const summarizationData = {
      callId,
      type: 'summarization',
      companyName: call.company_name || call.company,
      transcriptText: call.transcript_text,
      pptText: call.ppt_text
    };
    const summarizationJob = await jobQueue.addJob('summarization', summarizationData);

    await jobQueue.addJob('qe_extraction', { callId, type: 'qe_extraction' });

    res.json({
      success: true,
      message: 'Summarization job queued',
      job: { id: summarizationJob.id, callId, type: 'summarization', status: 'pending', createdAt: summarizationJob.createdAt }
    });
  } catch (error) {
    console.error('Error creating summarization job:', error);
    res.status(500).json({ success: false, error: 'Failed to create summarization job', message: error.message });
  }
}

async function enqueueQeExtraction(req, res) {
  try {
    const { callId } = req.params;

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }

    if (!call.quarterly_result_url?.trim()) {
      return res.status(400).json({ success: false, error: 'No quarterly_result_url for this call' });
    }

    const job = await jobQueue.addJob('qe_extraction', { callId, type: 'qe_extraction' });

    res.json({
      success: true,
      message: 'QE extraction job created and queued',
      job: { id: job.id, callId: job.callId, type: job.type, status: job.status, bullmqId: job.bullmqId, createdAt: job.createdAt }
    });
  } catch (error) {
    console.error('Error creating QE extraction job:', error);
    res.status(500).json({ success: false, error: 'Failed to create QE extraction job', message: error.message });
  }
}

async function enqueueOFactorAnalysis(req, res) {
  try {
    const { callId } = req.params;
    const { section } = req.body ?? {};

    if (!section) {
      return res.status(400).json({ success: false, error: 'section is required in request body' });
    }
    if (!VALID_OFACTOR_SECTIONS.has(section)) {
      return res.status(400).json({
        success: false,
        error: `Invalid section "${section}". Must be one of: ${[...VALID_OFACTOR_SECTIONS].join(', ')}`
      });
    }

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }

    const job = await jobQueue.addJob('ofactor_analysis', {
      callId,
      type: 'ofactor_analysis',
      subjectTicker: call.company,
      section,
    }, { jobId: `ofactor_${callId}_${section}` });

    res.json({
      success: true,
      message: `OFactor "${section}" analysis job created and queued`,
      job: {
        id:        job.id,
        callId,
        type:      'ofactor_analysis',
        section,
        status:    'pending',
        createdAt: new Date(job.timestamp).toISOString(),
      },
    });
  } catch (error) {
    console.error('Error creating OFactor analysis job:', error);
    res.status(500).json({ success: false, error: 'Failed to create OFactor analysis job', message: error.message });
  }
}

async function getJobStatus(req, res) {
  try {
    const { jobId } = req.params;

    const queues = ['summarization', 'ofactor_analysis', 'deal_analysis', 'qe_extraction'];
    let job = null;
    for (const q of queues) {
      job = await jobQueue.getJobStatus(q, jobId);
      if (job) break;
    }

    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({
      success: true,
      data: {
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
        }
      }
    });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch job', message: error.message });
  }
}

module.exports = { enqueueSummarization, enqueueQeExtraction, enqueueOFactorAnalysis, getJobStatus };
