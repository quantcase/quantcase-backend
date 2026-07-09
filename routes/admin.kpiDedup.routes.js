'use strict';

const router = require('express').Router();
const c = require('../controllers/admin.kpiDedup.controller');

// Phase 6 (per-industry KPI cap) only — phases 1-5 of scripts/dedup_kpis.js
// remain CLI-only for now. See services/kpiDedup.service.js.
router.post('/phase6/preview', c.previewPhase6);
router.post('/phase6/run',     c.runPhase6);

module.exports = router;
