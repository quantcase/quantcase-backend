'use strict';

const asyncHandler  = require('../middleware/asyncHandler');
const jobsService   = require('../services/jobs.service');

const enqueueSummarization = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const job = await jobsService.addSummarizationJob(callId);
  res.json({
    success: true,
    message: 'Summarization job queued',
    job: { id: job.id, callId, type: 'summarization', status: 'pending', createdAt: job.createdAt },
  });
});

const enqueueQeExtraction = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const job = await jobsService.addQeExtractionJob(callId);
  res.json({
    success: true,
    message: 'QE extraction job created and queued',
    job: { id: job.id, callId, type: 'qe_extraction', status: 'pending' },
  });
});

const enqueueOFactorAnalysis = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const { section } = req.body ?? {};
  const job = await jobsService.addOFactorAnalysisJob(callId, section);
  res.json({
    success: true,
    message: `OFactor "${section}" analysis job created and queued`,
    job: { id: job.id, callId, type: 'ofactor_analysis', section, status: 'pending', createdAt: new Date(job.timestamp).toISOString() },
  });
});

const getJobStatus = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const job = await jobsService.findJob(jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: job });
});

module.exports = { enqueueSummarization, enqueueQeExtraction, enqueueOFactorAnalysis, getJobStatus };
