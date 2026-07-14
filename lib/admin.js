require('dotenv').config();
const express = require('express');
const jobQueue = require('./jobQueue');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

process.on('unhandledRejection', (reason) => {
  console.error('[admin] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[admin] Uncaught exception:', err);
  process.exit(1);
});

const app  = express();
const port = process.env.ADMIN_PORT || 9000;

const boardAdapter = new ExpressAdapter();
boardAdapter.setBasePath('/');

createBullBoard({
  queues: [
    new BullMQAdapter(jobQueue.getQueue('summarization_v2')),
    new BullMQAdapter(jobQueue.getQueue('summarization_v2_ppt')),
    new BullMQAdapter(jobQueue.getQueue('summarization_v2_annual_report')),
    new BullMQAdapter(jobQueue.getQueue('technicals_analysis')),
    new BullMQAdapter(jobQueue.getQueue('ai_insight_synthesis')),
    new BullMQAdapter(jobQueue.getQueue('overview_synthesis')),
    new BullMQAdapter(jobQueue.getQueue('html_skill_incremental')),
    new BullMQAdapter(jobQueue.getQueue('post_html_analysis')),
  ],
  serverAdapter: boardAdapter,
});

app.use('/', boardAdapter.getRouter());

app.listen(port, () => {
  console.log(`Bull Board running at http://localhost:${port}`);
});
