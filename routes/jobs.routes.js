'use strict';

const router = require('express').Router();
const jobsController = require('../controllers/jobs.controller');

router.get('/:jobId', jobsController.getJobStatus);

module.exports = router;
