'use strict';

const { Router } = require('express');
const c = require('../controllers/monitoring.controller');

const router = Router();

// Dashboard overview
router.get('/overview', c.getOverview);

// BullMQ queue stats
router.get('/queues',      c.getQueues);
router.get('/queues/:name', c.getQueue);

// Scheduler run history
router.get('/scheduler', c.getSchedulerStatus);

// Pipeline coverage and failures
router.get('/pipeline/coverage', c.getPipelineCoverage);
router.get('/pipeline/failures', c.getPipelineFailures);

// Signal stats
router.get('/signals/stats', c.getSignalStats);

// BSE discovered URLs (written by Server 2 scraper, read here on Server 1)
router.get('/bse/discovered',            c.getBseDiscovered);
router.get('/bse/discovered/:scripCd',   c.getBseDiscoveredCompany);

// KPI data query (all via formulaRegistry)
router.get('/kpis/registry',                    c.getKpiRegistry);
router.get('/kpis/:ticker',                     c.getKpis);
router.get('/kpis/:ticker/:kpiAbbr/timeseries', c.getKpiTimeseries);

// Market / OHLCV data
router.get('/market/:ticker',      c.getMarketSnapshot);
router.get('/market/:ticker/ohlcv', c.getMarketOhlcv);
router.get('/market/:ticker/pe',    c.getMarketPe);

module.exports = router;
