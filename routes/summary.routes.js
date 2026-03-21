'use strict';

const router = require('express').Router();
const summaryController = require('../controllers/summary.controller');

router.get('/:callId', summaryController.getSummary);

module.exports = router;
