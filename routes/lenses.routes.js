'use strict';

const { Router } = require('express');
const prisma = require('../config/prisma');
const cache  = require('../lib/cache');
const {
  composeLens,
  composeAllLenses,
  getLensScores,
  getLensesByCategory,
  markLensStaleBySlug,
} = require('../services/lensComposer');
const { addLensComputationJob } = require('../services/jobs.service');

const router = Router();

// GET /api/lenses?ticker=&category= — lens scores grouped by category for the latest available quarter
router.get('/', async (req, res, next) => {
  try {
    const { ticker, category, refresh } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    const sym = ticker.toUpperCase();
    const cacheKey = `qc:lenses:${sym}:${category || 'all'}`;

    if (refresh === '1') {
      await cache.del(cacheKey);
    } else {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
    }

    // Resolve the call_id with the most recently computed non-stale score for this ticker
    const latest = await prisma.lensScore.findFirst({
      where:   { ticker: sym, is_stale: false },
      select:  { call_id: true },
      orderBy: { computed_at: 'desc' },
    });
    if (!latest) return res.json({ ticker: sym, callId: null, categories: {} });

    const result = await getLensesByCategory(latest.call_id, category);
    const payload = { ...result, ticker: sym };
    cache.set(cacheKey, payload, 7 * 86400).catch(() => {});
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /api/lenses/configs — list all active LensConfigs
router.get('/configs', async (req, res, next) => {
  try {
    const configs = await prisma.lensConfig.findMany({
      where:   req.query.includeInactive === 'true' ? {} : { is_active: true },
      orderBy: { slug: 'asc' },
    });
    res.json({ count: configs.length, configs });
  } catch (err) {
    next(err);
  }
});

// POST /api/lenses/configs — create or update a LensConfig
router.post('/configs', async (req, res, next) => {
  try {
    const { slug, name, description, config, is_active, version } = req.body;
    if (!slug || !name || !config) {
      return res.status(400).json({ error: 'slug, name, and config are required' });
    }
    const lensConfig = await prisma.lensConfig.upsert({
      where:  { slug },
      update: { name, description, config, is_active: is_active ?? true, version: version ?? '1.0.0', updated_at: new Date() },
      create: { slug, name, description, config, is_active: is_active ?? true, version: version ?? '1.0.0' },
    });
    // Mark all existing scores for this lens as stale
    const staleCount = await markLensStaleBySlug(slug);
    res.json({ lensConfig, staleCount });
  } catch (err) {
    next(err);
  }
});

// GET /api/lenses/scores?callId= — get computed L2 scores for a call
router.get('/scores', async (req, res, next) => {
  try {
    const { callId } = req.query;
    if (!callId) return res.status(400).json({ error: 'callId is required' });
    const scores = await getLensScores(callId);
    res.json({ callId, count: scores.length, scores });
  } catch (err) {
    next(err);
  }
});

// POST /api/lenses/compute — enqueue async lens computation jobs via BullMQ
// Body: { callId, lenses?: string[] }  (alias: lensSlugs)
// Returns jobIds; results are computed by the lens_computation worker.
router.post('/compute', async (req, res, next) => {
  try {
    const { callId, lenses, lensSlugs } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    let slugs = lenses ?? lensSlugs;
    if (!slugs || slugs.length === 0) {
      const configs = await prisma.lensConfig.findMany({ where: { is_active: true }, select: { slug: true } });
      slugs = configs.map(c => c.slug);
    }

    const jobs = await Promise.all(slugs.map(slug => addLensComputationJob(callId, slug)));
    const jobIds = jobs.map(j => j.id);

    res.json({ success: true, callId, lenses: slugs, jobIds, count: jobIds.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
