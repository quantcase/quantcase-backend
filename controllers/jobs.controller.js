'use strict';

const asyncHandler  = require('../middleware/asyncHandler');
const jobsService   = require('../services/jobs.service');

const enqueueSummarization = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const job = await jobsService.addSummarizationJob(callId);
  res.json({
    success: true,
    message: 'Summarization job enqueued',
    job: { id: job.id, callId, type: 'summarization', status: 'pending' },
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

const enqueueProwessExtraction = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const job = await jobsService.addProwessExtractionJob(callId);
  res.json({
    success: true,
    message: 'Prowess extraction job created and queued',
    job: { id: job.id, callId, type: 'prowess_extraction', status: 'pending' },
  });
});

const enqueueSummarizationV2 = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const result = await jobsService.addSummarizationV2Jobs(callId);
  res.json({ success: true, message: 'Summarization V2 jobs enqueued', ...result });
});

const getJobStatus = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const job = await jobsService.findJob(jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: job });
});

module.exports = { enqueueSummarization, enqueueQeExtraction, enqueueProwessExtraction, enqueueSummarizationV2, getJobStatus };
