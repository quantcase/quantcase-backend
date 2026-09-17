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
router.post( '/l2-multi/regenerate-html', validate(l2MultiOptionsSchema, 'body'), pipelineDispatchController.regenerateHtmlL2Multi);
router.get(  '/l2-multi/runs',        pipelineDispatchController.getL2MultiRuns);

// ─── L3 Multi-Dispatch (post-html-analysis runs) ──────────────────────────────
// One job-fanout POST per ticker (to POST /api/post-html-analysis, which
// itself enqueues one job per requested type) — no configKey concept here,
// unlike L2: PostHtmlAnalysisConfig has no per-group config variant yet, only
// one config per (layer_id, type) globally (see l3MultiDispatch.service.js
// module docstring).

const l3MultiOptionsSchema = z.object({
  layerId:   z.enum(['l3', 'l4']).optional(),
  types:     z.array(z.string()).optional(),
  groupSlug: z.string().optional(),
  tickers:   z.array(z.string()).optional(),
  all:       z.boolean().optional(),
  startFrom: z.string().optional(),
  force:     z.boolean().optional(),
  // Preview-only — paginates the resolved ticker list. Ignored by /run.
  page:      z.number().int().positive().optional(),
  pageSize:  z.number().int().positive().optional(),
});

router.get(  '/l3-multi/options',     pipelineDispatchController.getL3MultiOptions);
router.post( '/l3-multi/preview',     validate(l3MultiOptionsSchema, 'body'), pipelineDispatchController.previewL3Multi);
router.post( '/l3-multi/preview/csv', validate(l3MultiOptionsSchema, 'body'), pipelineDispatchController.previewL3MultiCsv);
router.post( '/l3-multi/run',         validate(l3MultiOptionsSchema, 'body'), pipelineDispatchController.runL3Multi);
router.get(  '/l3-multi/runs',        pipelineDispatchController.getL3MultiRuns);

// ─── L2 Compressed Multi-Dispatch (html-compressed-skill runs) ────────────────
// Identical to L2 multi, but dispatches to /api/html-compressed-skills/:slug/run.

router.get(  '/l2-compressed-multi/options',     pipelineDispatchController.getL2CompressedMultiOptions);
router.post( '/l2-compressed-multi/preview',     validate(l2MultiOptionsSchema, 'body'), pipelineDispatchController.previewL2CompressedMulti);
router.post( '/l2-compressed-multi/preview/csv', validate(l2MultiOptionsSchema, 'body'), pipelineDispatchController.previewL2CompressedMultiCsv);
router.post( '/l2-compressed-multi/run',         validate(l2MultiOptionsSchema, 'body'), pipelineDispatchController.runL2CompressedMulti);
router.post( '/l2-compressed-multi/regenerate-html', validate(l2MultiOptionsSchema, 'body'), pipelineDispatchController.regenerateHtmlL2CompressedMulti);
router.get(  '/l2-compressed-multi/runs',        pipelineDispatchController.getL2CompressedMultiRuns);

// ─── Lens Tier Configs Management ──────────────────────────────────────────

const bulkUpdateTierSchema = z.object({
  tierKey: z.string(),
  slugs:   z.array(z.string()).optional(),
  updates: z.record(z.any()),
});

router.get(  '/lens-tier-configs', pipelineDispatchController.getLensTierConfigs);
router.put(  '/lens-tier-configs/:tierKey/:slug', pipelineDispatchController.updateLensTierConfig);
router.post( '/lens-tier-configs/bulk-update', validate(bulkUpdateTierSchema, 'body'), pipelineDispatchController.bulkUpdateLensTierConfigs);

module.exports = router;
