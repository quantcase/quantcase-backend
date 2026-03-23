'use strict';

const router = require('express').Router();

router.use('/dashboard',   require('./wealthos/dashboard.routes'));
router.use('/clients',     require('./wealthos/clients.routes'));
router.use('/suggestions', require('./wealthos/suggestions.routes'));
router.use('/actions',     require('./wealthos/actions.routes'));
router.use('/rm',          require('./wealthos/rm.routes'));
router.use('/models',      require('./wealthos/models.routes'));
router.use('/analytics',   require('./wealthos/analytics.routes'));

module.exports = router;
