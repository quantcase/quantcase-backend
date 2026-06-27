'use strict';

const asyncHandler  = require('../middleware/asyncHandler');
const jobsService   = require('../services/jobs.service');

const enqueueSummarizationV2 = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const result = await jobsService.addSummarizationV2Jobs(callId);
  res.json({ success: true, message: 'Summarization V2 jobs enqueued', ...result });
});

const enqueueSummarizationV2Ppt = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const result = await jobsService.addSummarizationV2PptJobs(callId);
  res.json({ success: true, message: 'Summarization V2 PPT jobs enqueued', ...result });
});

const enqueueSummarizationV2AnnualReport = asyncHandler(async (req, res) => {
  const { reportId } = req.params;
  const result = await jobsService.addSummarizationV2AnnualReportJobs(reportId);
  res.json({ success: true, message: 'Summarization V2 Annual Report jobs enqueued', ...result });
});

const getJobStatus = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const job = await jobsService.findJob(jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: job });
});

module.exports = { enqueueSummarizationV2, enqueueSummarizationV2Ppt, enqueueSummarizationV2AnnualReport, getJobStatus };
