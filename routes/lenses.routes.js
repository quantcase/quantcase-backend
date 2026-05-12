'use strict';

const { Router } = require('express');
const prisma = require('../config/prisma');
const {
  composeLens,
  composeAllLenses,
  getLensScores,
  getLensesByCategory,
  markLensStaleBySlug,
} = require('../services/lensComposer');

const router = Router();

// GET /api/lenses?callId=&category= — lens scores grouped by category (management/opportunity/deal)
router.get('/', async (req, res, next) => {
  try {
    const { callId, category } = req.query;
    if (!callId) return res.status(400).json({ error: 'callId is required' });
    const result = await getLensesByCategory(callId, category);
    res.json(result);
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

// POST /api/lenses/compute — sync lens composition (pure math, no worker needed)
// Body: { callId, lenses?: string[] }  (alias: lensSlugs)
router.post('/compute', async (req, res, next) => {
  try {
    const { callId, lenses, lensSlugs } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    const slugs = lenses ?? lensSlugs;
    let scores;
    if (slugs && slugs.length > 0) {
      const results = await Promise.all(slugs.map(slug => composeLens(callId, slug)));
      scores = Object.fromEntries(slugs.map((slug, i) => [slug, results[i]]));
    } else {
      scores = await composeAllLenses(callId);
    }

    res.json({ callId, scores });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
