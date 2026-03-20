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

// Admin routes
router.use('/admin', adminRouter);

module.exports = router;
