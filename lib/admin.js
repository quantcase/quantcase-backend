require('dotenv').config();
const express = require('express');
const jobQueue = require('./jobQueue');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const app  = express();
const port = process.env.ADMIN_PORT || 9000;

const boardAdapter = new ExpressAdapter();
boardAdapter.setBasePath('/');

createBullBoard({
  queues: [
    new BullMQAdapter(jobQueue.getQueue('summarization')),
    new BullMQAdapter(jobQueue.getQueue('qe_extraction')),
    new BullMQAdapter(jobQueue.getQueue('deal_analysis')),
    new BullMQAdapter(jobQueue.getQueue('ofactor_analysis')),
    new BullMQAdapter(jobQueue.getQueue('technicals_analysis')),
    new BullMQAdapter(jobQueue.getQueue('management_analysis')),
    new BullMQAdapter(jobQueue.getQueue('lens_computation')),
    new BullMQAdapter(jobQueue.getQueue('ai_insight_synthesis')),
    new BullMQAdapter(jobQueue.getQueue('overview_synthesis')),
  ],
  serverAdapter: boardAdapter,
});

app.use('/', boardAdapter.getRouter());

app.listen(port, () => {
  console.log(`Bull Board running at http://localhost:${port}`);
});
