'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const prisma = require('../config/prisma');
const cache  = require('../lib/cache');
const postHtmlAnalysisService = require('../services/postHtmlAnalysis.service');

const { L3_TYPES, L4_TYPE } = postHtmlAnalysisService;
const VALID_LAYERS = new Set(['l3', 'l4']);
const CONFIG_FIELDS = ['name', 'prompt', 'output_schema', 'model', 'max_tokens', 'is_active'];

function validTypesForLayer(layerId) {
  return layerId === 'l4' ? [L4_TYPE] : L3_TYPES;
}

function assertValidLayerType(layerId, type, res) {
  if (!VALID_LAYERS.has(layerId)) {
    res.status(400).json({ success: false, error: `Invalid layer_id. Valid values: ${[...VALID_LAYERS].join(', ')}` });
    return false;
  }
  if (!validTypesForLayer(layerId).includes(type)) {
    res.status(400).json({ success: false, error: `Invalid type for layer_id=${layerId}. Valid values: ${validTypesForLayer(layerId).join(', ')}` });
    return false;
  }
  return true;
}

/**
 * POST /api/post-html-analysis
 * Body: { ticker, layer_id: 'l3'|'l4', types?: [...], fiscal_year?, quarter?, forceRefresh? }
 * Enqueues postHtmlAnalysis jobs and returns jobIds for polling.
 */
const enqueuePostHtmlAnalysis = asyncHandler(async (req, res) => {
  const { ticker, layer_id, types, fiscal_year, quarter, forceRefresh } = req.body;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const layerId = String(layer_id || 'l3').trim().toLowerCase();
  if (!VALID_LAYERS.has(layerId)) {
    return res.status(400).json({ success: false, error: `Invalid layer_id. Valid values: ${[...VALID_LAYERS].join(', ')}` });
  }

  const allowedTypes = validTypesForLayer(layerId);
  const requestedTypes = Array.isArray(types) ? types : allowedTypes;
  const validTypes = requestedTypes
    .map(t => String(t).trim().toLowerCase())
    .filter(t => allowedTypes.includes(t));

  if (validTypes.length === 0) {
    return res.status(400).json({ success: false, error: `Invalid types for layer_id=${layerId}. Valid values: ${allowedTypes.join(', ')}` });
  }

  if (forceRefresh) {
    await cache.delByPattern(`qc:analysis:${ticker.toUpperCase()}:*`);
  }

  const jobs = await postHtmlAnalysisService.enqueuePostHtmlAnalysis(ticker, validTypes, layerId, {
    forceRefresh: !!forceRefresh,
    fiscal_year: fiscal_year || undefined,
    quarter: quarter || undefined,
  });

  res.json({
    success: true,
    message: `Enqueued ${jobs.length} post-html-analysis job(s)`,
    ticker,
    layer_id: layerId,
    jobs,
  });
});

/**
 * GET /api/post-html-analysis?ticker=X&layer_id=l3&type=management,opportunity
 * Returns stored PostHtmlAnalysis results.
 */
const getPostHtmlAnalysis = asyncHandler(async (req, res) => {
  const { ticker, layer_id, type, refresh } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  const layerId = String(layer_id || 'l3').trim().toLowerCase();
  if (!VALID_LAYERS.has(layerId)) {
    return res.status(400).json({ success: false, error: `Invalid layer_id. Valid values: ${[...VALID_LAYERS].join(', ')}` });
  }

  const allowedTypes = validTypesForLayer(layerId);
  const types = (type ?? allowedTypes.join(','))
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => allowedTypes.includes(t));

  if (types.length === 0) {
    return res.status(400).json({ success: false, error: `Invalid type(s) for layer_id=${layerId}. Valid values: ${allowedTypes.join(', ')}` });
  }

  const sortedTypes = types.slice().sort().join(',');
  const cacheKey = `qc:analysis:${ticker.toUpperCase()}:${layerId}:${sortedTypes}`;

  if (refresh === '1') {
    await cache.del(cacheKey);
  }

  const rows = await cache.getOrSet(cacheKey, 7 * 86400, () => postHtmlAnalysisService.getPostHtmlAnalysis(ticker, layerId, types));
  res.json({ success: true, data: { ticker, layer_id: layerId, results: rows } });
});

// ── Config CRUD (admin) ────────────────────────────────────────────────────
// layer_id/type is a fixed, small set (l3: management/opportunity/deal,
// l4: summary) baked into the worker/service — no POST/create here, only
// list/read/update/soft-delete of the seeded rows (see scripts/seedPostHtmlAnalysisConfigs.js).

/**
 * GET /api/post-html-analysis/configs?includeInactive=true
 */
const listConfigs = asyncHandler(async (req, res) => {
  const configs = await prisma.postHtmlAnalysisConfig.findMany({
    where: req.query.includeInactive === 'true' ? {} : { is_active: true },
    orderBy: [{ layer_id: 'asc' }, { type: 'asc' }],
  });
  res.json({ success: true, count: configs.length, configs });
});

/**
 * GET /api/post-html-analysis/configs/:layer_id/:type
 */
const getConfig = asyncHandler(async (req, res) => {
  const { layer_id: layerId, type } = req.params;
  if (!assertValidLayerType(layerId, type, res)) return;

  const config = await prisma.postHtmlAnalysisConfig.findUnique({
    where: { layer_id_type: { layer_id: layerId, type } },
  });
  if (!config) return res.status(404).json({ success: false, error: 'Config not found' });
  res.json({ success: true, config });
});

/**
 * PUT /api/post-html-analysis/configs/:layer_id/:type
 * Body: any subset of { name, prompt, output_schema, model, max_tokens, is_active }
 */
const updateConfig = asyncHandler(async (req, res) => {
  const { layer_id: layerId, type } = req.params;
  if (!assertValidLayerType(layerId, type, res)) return;

  const data = {};
  for (const field of CONFIG_FIELDS) {
    if (req.body[field] !== undefined) data[field] = req.body[field];
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ success: false, error: 'No updatable fields provided' });
  }

  try {
    const config = await prisma.postHtmlAnalysisConfig.update({
      where: { layer_id_type: { layer_id: layerId, type } },
      data,
    });
    res.json({ success: true, config });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, error: 'Config not found' });
    throw err;
  }
});

/**
 * DELETE /api/post-html-analysis/configs/:layer_id/:type  (soft delete)
 */
const deactivateConfig = asyncHandler(async (req, res) => {
  const { layer_id: layerId, type } = req.params;
  if (!assertValidLayerType(layerId, type, res)) return;

  try {
    const config = await prisma.postHtmlAnalysisConfig.update({
      where: { layer_id_type: { layer_id: layerId, type } },
      data: { is_active: false },
    });
    res.json({ success: true, layer_id: config.layer_id, type: config.type, is_active: false });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, error: 'Config not found' });
    throw err;
  }
});

// ── Prompt preview (dry-run) ────────────────────────────────────────────────

/**
 * GET /api/post-html-analysis/configs/:layer_id/:type/preview?ticker=X&fiscal_year=&quarter=
 * Assembles the exact prompt that would be sent to the LLM, without calling it.
 */
const previewPrompt = asyncHandler(async (req, res) => {
  const { layer_id: layerId, type } = req.params;
  if (!assertValidLayerType(layerId, type, res)) return;

  const { ticker, fiscal_year, quarter } = req.query;
  if (!ticker) return res.status(400).json({ success: false, error: 'ticker is required' });

  try {
    const preview = await postHtmlAnalysisService.buildPreviewPrompt(layerId, type, ticker, {
      fiscal_year: fiscal_year || undefined,
      quarter: quarter || undefined,
    });
    res.json({ success: true, ticker, layer_id: layerId, type, ...preview });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    throw err;
  }
});

const getBulkScores = asyncHandler(async (req, res) => {
  const { tickers } = req.query;
  const tickerArray = tickers ? tickers.split(',').map(t => t.trim()).filter(Boolean) : [];
  const data = await postHtmlAnalysisService.getBulkScores(tickerArray);
  res.json({ success: true, data });
});

module.exports = {
  enqueuePostHtmlAnalysis,
  getPostHtmlAnalysis,
  listConfigs,
  getConfig,
  updateConfig,
  deactivateConfig,
  previewPrompt,
  getBulkScores,
};
