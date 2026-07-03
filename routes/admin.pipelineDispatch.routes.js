'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const pipelineDispatchController = require('../controllers/admin.pipelineDispatch.controller');

// Shared shape for L1 multi-dispatch options — mirrors
// scripts/analysis/analyze_L1_v2_multi_all.js flags. Used for both preview
// (dry run) and run (actual dispatch).
const l1MultiOptionsSchema = z.object({
  groupSlug: z.string().optional(),
  tickers:   z.array(z.string()).optional(),
  all:       z.boolean().optional(),
  startFrom: z.string().optional(),
  limit:     z.number().int().positive().optional(),
  latest:    z.number().int().positive().optional(),
  force:     z.boolean().optional(),
  arOnly:    z.boolean().optional(),
  noAr:      z.boolean().optional(),
});

// ─── L1 Multi-Dispatch (transcript + ppt + annual report) ────────────────────

router.get(  '/l1-multi/options', pipelineDispatchController.getL1MultiOptions);
router.post( '/l1-multi/preview', validate(l1MultiOptionsSchema, 'body'), pipelineDispatchController.previewL1Multi);
router.post( '/l1-multi/run',     validate(l1MultiOptionsSchema, 'body'), pipelineDispatchController.runL1Multi);
router.get(  '/l1-multi/runs',    pipelineDispatchController.getL1MultiRuns);

module.exports = router;
