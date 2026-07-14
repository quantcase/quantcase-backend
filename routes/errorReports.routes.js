'use strict';

const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const ctrl = require('../controllers/errorReport.controller');
const { CATEGORIES } = require('../services/errorReport.service');

const createErrorReportSchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  message: z.string().min(1, 'message is required').max(5000),
  pageUrl: z.string().max(2048).optional(),
  errorMessage: z.string().max(10000).optional(),
  userAgent: z.string().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// POST /api/error-reports — submit a "Report Error" form from the frontend.
// Requires a valid Bearer JWT (see middleware/authenticate.js); req.user.sub/email
// are attached to the report automatically.
router.post('/', authenticate, validate(createErrorReportSchema, 'body'), ctrl.createErrorReport);

module.exports = router;
