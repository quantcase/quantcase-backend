'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const technicalsService = require('../services/admin.technicals.service');

// POST /admin/technicals/bulk-analyze — enqueue technicals regeneration for many tickers.
const bulkAnalyze = asyncHandler(async (req, res) => {
  const { tickers, force } = req.body;
  const result = await technicalsService.bulkEnqueueTechnicals({ tickers, force });
  res.status(202).json({ success: true, ...result });
});

// POST /admin/technicals/bulk-status — batch-poll insight/job state for many tickers.
const bulkStatus = asyncHandler(async (req, res) => {
  const { tickers } = req.body;
  const result = await technicalsService.bulkTechnicalsStatus({ tickers });
  res.json({ success: true, ...result });
});

module.exports = { bulkAnalyze, bulkStatus };
