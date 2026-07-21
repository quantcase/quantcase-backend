'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/admin.prowessCoverage.controller');

// Shared shape for the coverage preview — mirrors L1/L2's
// groupSlug|tickers|all + pagination (see admin.pipelineDispatch.routes.js).
const coverageOptionsSchema = z.object({
  groupSlug: z.string().optional(),
  tickers:   z.array(z.string()).optional(),
  all:       z.boolean().optional(),
  startFrom: z.string().optional(),
  // Explicit KPI abbr override — checked against both annual and quarterly
  // for every ticker instead of the default P&L/Balance Sheet/Cash Flow sets.
  kpis:      z.array(z.string()).optional(),
  page:      z.number().int().positive().optional(),
  pageSize:  z.number().int().positive().optional(),
});

router.get(  '/options', ctrl.getCoverageOptions);
router.post( '/preview', validate(coverageOptionsSchema, 'body'), ctrl.previewCoverage);

module.exports = router;
