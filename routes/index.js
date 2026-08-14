'use strict';

const router = require('express').Router();

const healthController    = require('../controllers/health.controller');
const callsRouter         = require('./calls.routes');
const transcriptsRouter   = require('./transcripts.routes');
const summaryRouter       = require('./summary.routes');
const jobsRouter          = require('./jobs.routes');
const adminRouter         = require('./admin.routes');
const authenticate        = require('../middleware/authenticate');
const requireAdmin        = require('../middleware/requireAdmin');
const wealthosRouter      = require('./wealthos.routes');
const screenerRouter      = require('./screener.routes');
const tickersRouter       = require('./tickers.routes');
const basketsRouter              = require('./baskets.routes');
const industryBasketsRouter      = require('./industryBaskets.routes');
const modelsRouter        = require('./models.routes');
const privateEquityRouter = require('./privateEquity.routes');
const industryIntelligenceRouter = require('./industryIntelligence.routes');
const mutualFundsRouter   = require('./mutualFunds.routes');
const authRouter          = require('./auth.routes');
const invitesRouter       = require('./invites.routes');
const errorReportsRouter  = require('./errorReports.routes');
const portfolioRouter     = require('./portfolio.routes');
const signalsRouter       = require('./signals.routes');
const lensesRouter        = require('./lenses.routes');
const analysisRouter      = require('./analysis.routes');
const postHtmlAnalysisRouter = require('./postHtmlAnalysis.routes');
const annualReportsRouter     = require('./annual_reports.routes');
const htmlSkillsRouter             = require('./htmlSkills.routes');
const htmlIncrementalSkillsRouter  = require('./htmlIncrementalSkills.routes');
const billingRouter           = require('./billing.routes');
const smallcaseRouter         = require('./smallcase.routes');
const pipelineRouter          = require('./pipeline.routes');
const journalRouter           = require('./journal.routes');
const monitoringRouter        = require('./monitoring.routes');
const { discover: discoverRouter, researchLibrary: researchLibraryRouter, market: marketRouter } = require('./dashboard.routes');
const accessRequestRouter = require('./accessRequest.routes');

// Standalone health check
router.get('/health', healthController.healthCheck);

// API routes
router.use('/api/request-access', accessRequestRouter);
router.use('/api/calls',       callsRouter);
router.use('/api/transcript',  transcriptsRouter);
router.use('/api/summary',     summaryRouter);
router.use('/api/jobs',        jobsRouter);

// Screener routes
router.use('/api/screener', screenerRouter);

// Batch ticker metrics (caller-supplied ticker list)
router.use('/api/tickers', tickersRouter);

// Baskets (stock screen) routes
router.use('/api/baskets', basketsRouter);

// Industry baskets routes
router.use('/api/industry-baskets', industryBasketsRouter);

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
// Auth routes
router.use('/api/auth', authRouter);

// Invite-only registration
router.use('/api/invites', invitesRouter);

// Error reporting ("Report Error" button on the frontend)
router.use('/api/error-reports', errorReportsRouter);

// Portfolio routes
router.use('/api/portfolio', portfolioRouter);

// 3-Layer pipeline routes
router.use('/api/signals',  signalsRouter);
router.use('/api/lenses',   lensesRouter);
router.use('/api/analysis', analysisRouter);
router.use('/api/post-html-analysis', postHtmlAnalysisRouter);
router.use('/api/annual-reports', annualReportsRouter);
router.use('/api/html-skills',             htmlSkillsRouter);
router.use('/api/html-incremental-skills', htmlIncrementalSkillsRouter);
router.use('/api/billing',       billingRouter);
router.use('/api/smallcase',     smallcaseRouter);
router.use('/api/pipeline',      pipelineRouter);
router.use('/api/journal',       journalRouter);
router.use('/api/monitoring',    monitoringRouter);

// Investor dashboard routes
router.use('/api/discover',         discoverRouter);
router.use('/api/research-library', researchLibraryRouter);
router.use('/api/market',           marketRouter);

// Admin routes — restricted to the single admin account (see middleware/requireAdmin.js)
router.use('/admin', authenticate, requireAdmin, adminRouter);

module.exports = router;
