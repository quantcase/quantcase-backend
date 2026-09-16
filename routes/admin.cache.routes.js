'use strict';

const router = require('express').Router();
const adminCacheController = require('../controllers/admin.cache.controller');

// GET /admin/cache/stats — Redis status, memory info, key counts per domain
router.get('/stats', adminCacheController.getStats);

// POST /admin/cache/invalidate — purge cache keys by scope, ticker, or custom pattern
router.post('/invalidate', adminCacheController.invalidateCache);

// POST /admin/cache/warm — trigger cache warming for tickers
router.post('/warm', adminCacheController.warmCache);

// GET /admin/cache/warming-status — check active warming job progress
router.get('/warming-status', adminCacheController.getWarmingStatus);

module.exports = router;
