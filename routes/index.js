'use strict';

const router = require('express').Router();

const healthController    = require('../controllers/health.controller');
const callsRouter         = require('./calls.routes');
const transcriptsRouter   = require('./transcripts.routes');
const summaryRouter       = require('./summary.routes');
const managementRouter    = require('./management.routes');
const jobsRouter          = require('./jobs.routes');
const opportunityRouter   = require('./opportunity.routes');
const dealRouter          = require('./deal.routes');
const adminRouter         = require('./admin.routes');
const wealthosRouter      = require('./wealthos.routes');
const screenerRouter      = require('./screener.routes');
const basketsRouter       = require('./baskets.routes');
const watchlistRouter     = require('./watchlist.routes');
const modelsRouter        = require('./models.routes');
const privateEquityRouter = require('./privateEquity.routes');
const mutualFundsRouter          = require('./mutualFunds.routes');
const industryIntelligenceRouter = require('./industryIntelligence.routes');

// Standalone health check
router.get('/health', healthController.healthCheck);

// API routes
router.use('/api/calls',       callsRouter);
router.use('/api/transcript',  transcriptsRouter);
router.use('/api/summary',     summaryRouter);
router.use('/api/management',  managementRouter);
router.use('/api/jobs',        jobsRouter);
router.use('/api/opportunity', opportunityRouter);
router.use('/api/deal',        dealRouter);

// Screener routes
router.use('/api/screener', screenerRouter);

// Baskets (stock screen) routes
router.use('/api/baskets', basketsRouter);

// Watchlist routes
router.use('/api/watchlists', watchlistRouter);

// Portfolio model routes
router.use('/api/models', modelsRouter);

// WealthOS routes
router.use('/api/wealthos', wealthosRouter);

// Private equity routes
router.use('/api/private-equity', privateEquityRouter);

// Mutual funds routes
router.use('/api/mutual-funds', mutualFundsRouter);

// Industry Intelligence Tracker
router.use('/api/industry-intelligence', industryIntelligenceRouter);

// Admin routes
router.use('/admin', adminRouter);

module.exports = router;
