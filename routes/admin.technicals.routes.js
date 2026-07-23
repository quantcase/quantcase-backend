'use strict';

const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/admin.technicals.controller');

// Mounted at /admin/technicals — the whole /admin tree is already gated by
// authenticate + requireAdmin (see routes/index.js), so no per-route auth here.

const bulkAnalyzeSchema = z.object({
  tickers: z.array(z.string().min(1)).min(1).max(500),
  force: z.boolean().optional(),
});

const bulkStatusSchema = z.object({
  tickers: z.array(z.string().min(1)).min(1).max(500),
});

// POST /admin/technicals/bulk-analyze — enqueue technicals-intelligence jobs for many tickers.
router.post('/bulk-analyze', validate(bulkAnalyzeSchema, 'body'), ctrl.bulkAnalyze);

// POST /admin/technicals/bulk-status — batch-poll insight/job state for many tickers.
router.post('/bulk-status', validate(bulkStatusSchema, 'body'), ctrl.bulkStatus);

module.exports = router;
