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
  // Preview-only — paginates the resolved ticker list. Ignored by /run.
  page:      z.number().int().positive().optional(),
  pageSize:  z.number().int().positive().optional(),
});

// ─── L1 Multi-Dispatch (transcript + ppt + annual report) ────────────────────

router.get(  '/l1-multi/options',     pipelineDispatchController.getL1MultiOptions);
router.post( '/l1-multi/preview',     validate(l1MultiOptionsSchema, 'body'), pipelineDispatchController.previewL1Multi);
router.post( '/l1-multi/preview/csv', validate(l1MultiOptionsSchema, 'body'), pipelineDispatchController.previewL1MultiCsv);
router.post( '/l1-multi/run',         validate(l1MultiOptionsSchema, 'body'), pipelineDispatchController.runL1Multi);
router.get(  '/l1-multi/runs',        pipelineDispatchController.getL1MultiRuns);

// ─── L2 Multi-Dispatch (html-incremental-skill runs) ──────────────────────────
// One job per ticker (its latest reporting period) — simpler than L1, which
// dispatches per-document. configKey is never part of this shape: each job
// resolves its own config from the ticker's CompanyGroup.config_key when the
// worker picks it up (see resolveRequiredConfigKey).

const l2MultiOptionsSchema = z.object({
  slug:      z.string(),
  groupSlug: z.string().optional(),
  tickers:   z.array(z.string()).optional(),
  all:       z.boolean().optional(),
  startFrom: z.string().optional(),
  historic:  z.boolean().optional(),
  force:     z.boolean().optional(),
  // Preview-only — paginates the resolved ticker list. Ignored by /run.
  page:      z.number().int().positive().optional(),
  pageSize:  z.number().int().positive().optional(),
});

router.get(  '/l2-multi/options',     pipelineDispatchController.getL2MultiOptions);
router.post( '/l2-multi/preview',     validate(l2MultiOptionsSchema, 'body'), pipelineDispatchController.previewL2Multi);
router.post( '/l2-multi/preview/csv', validate(l2MultiOptionsSchema, 'body'), pipelineDispatchController.previewL2MultiCsv);
router.post( '/l2-multi/run',         validate(l2MultiOptionsSchema, 'body'), pipelineDispatchController.runL2Multi);
router.get(  '/l2-multi/runs',        pipelineDispatchController.getL2MultiRuns);

module.exports = router;
