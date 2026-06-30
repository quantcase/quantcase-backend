'use strict';

const jobQueue = require('../lib/jobQueue');

const ALL_QUEUES = [
  'summarization_v2',
  'summarization_v2_ppt',
  'summarization_v2_annual_report',
  'html_skill',
  'html_skill_preview',
  'ai_insight_synthesis',
  'overview_synthesis',
  'lens_computation',
  'technicals_analysis',
  'fundamentals_analysis',
  'wealthos_suggestion',
  'wealthos_message',
];

async function getQueueStats(queueName) {
  const queue  = jobQueue.getQueue(queueName);
  const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  return { name: queueName, ...counts };
}

async function getAllQueueStats() {
  const stats = await Promise.all(ALL_QUEUES.map(getQueueStats));
  return stats;
}

async function getFailedJobs(queueName, limit = 20) {
  const queue = jobQueue.getQueue(queueName);
  const jobs  = await queue.getFailed(0, limit - 1);
  return jobs.map(j => ({
    id:           j.id,
    name:         j.name,
    failedReason: j.failedReason,
    attemptsMade: j.attemptsMade,
    finishedOn:   j.finishedOn ? new Date(j.finishedOn) : null,
    data:         j.data,
  }));
}

module.exports = { getAllQueueStats, getQueueStats, getFailedJobs, ALL_QUEUES };
