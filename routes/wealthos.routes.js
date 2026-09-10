'use strict';

const router = require('express').Router();
const wealthOrgContext = require('../middleware/wealthOrgContext');

// Mount WealthOS organization context resolution across all WealthOS routes
router.use(wealthOrgContext);

router.use('/dashboard',     require('./wealthos/dashboard.routes'));
router.use('/clients',       require('./wealthos/clients.routes'));
router.use('/heartbeat',     require('./wealthos/heartbeat.routes'));
router.use('/tasks',         require('./wealthos/tasks.routes'));
router.use('/opportunities', require('./wealthos/opportunities.routes'));
router.use('/suggestions',   require('./wealthos/suggestions.routes'));
router.use('/actions',       require('./wealthos/actions.routes'));
router.use('/rm',            require('./wealthos/rm.routes'));
router.use('/models',        require('./wealthos/models.routes'));
router.use('/analytics',     require('./wealthos/analytics.routes'));
router.use('/import',        require('./wealthos/import.routes'));
router.use('/export',        require('./wealthos/export.routes'));

module.exports = router;

