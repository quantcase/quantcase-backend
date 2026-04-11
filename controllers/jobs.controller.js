'use strict';

const asyncHandler  = require('../middleware/asyncHandler');
const jobsService   = require('../services/jobs.service');

const enqueueSummarization = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const job = await jobsService.addSummarizationJob(callId);
  res.json({
    success: true,
    message: 'Management plugin enqueued (summarization + qe_extraction)',
    job: { id: job.jobId, callId, type: job.skillName, status: 'pending' },
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

const enqueueFullOpportunityAnalysis = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const jobs = await jobsService.addFullOpportunityAnalysis(callId);
  res.json({
    success: true,
    message: `Opportunity full-pipeline enqueued (${jobs.length} skills)`,
    jobs: jobs.map(j => ({ skillName: j.skillName, queue: j.queue, jobId: j.jobId })),
  });
});

const getJobStatus = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const job = await jobsService.findJob(jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: job });
});

module.exports = { enqueueSummarization, enqueueQeExtraction, enqueueOFactorAnalysis, enqueueFullOpportunityAnalysis, getJobStatus };
