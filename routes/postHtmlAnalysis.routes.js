'use strict';

const { Router } = require('express');
const postHtmlAnalysisController = require('../controllers/postHtmlAnalysis.controller');

const router = Router();

// ── Config CRUD (admin) ────────────────────────────────────────────────────
// layer_id/type is one of: l3/management, l3/opportunity, l3/deal, l4/summary.

// GET /api/post-html-analysis/configs?includeInactive=true
router.get('/configs', postHtmlAnalysisController.listConfigs);

// GET /api/post-html-analysis/configs/:layer_id/:type/preview?ticker=X&fiscal_year=&quarter=
router.get('/configs/:layer_id/:type/preview', postHtmlAnalysisController.previewPrompt);

// GET /api/post-html-analysis/configs/:layer_id/:type
router.get('/configs/:layer_id/:type', postHtmlAnalysisController.getConfig);

// PUT /api/post-html-analysis/configs/:layer_id/:type
// Body: any subset of { name, prompt, output_schema, model, max_tokens, is_active }
router.put('/configs/:layer_id/:type', postHtmlAnalysisController.updateConfig);

// DELETE /api/post-html-analysis/configs/:layer_id/:type  (soft delete)
router.delete('/configs/:layer_id/:type', postHtmlAnalysisController.deactivateConfig);

// ── Run / read results ──────────────────────────────────────────────────────

// GET /api/post-html-analysis?ticker=X&layer_id=l3&type=management,opportunity,deal
router.get('/', postHtmlAnalysisController.getPostHtmlAnalysis);

// POST /api/post-html-analysis  { ticker, layer_id, types?, fiscal_year?, quarter?, forceRefresh? }
router.post('/', postHtmlAnalysisController.enqueuePostHtmlAnalysis);

module.exports = router;
