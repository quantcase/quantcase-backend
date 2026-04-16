'use strict';

const router = require('express').Router();
const modelsController = require('../controllers/models.controller');

// POST /api/models — create a portfolio model
router.post('/', modelsController.createModel);

// GET /api/models — list all portfolio models
router.get('/', modelsController.getModels);

module.exports = router;
