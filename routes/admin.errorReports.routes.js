'use strict';

const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/admin.errorReports.controller');
const { CATEGORIES, STATUSES } = require('../services/errorReport.service');

const listQuerySchema = z.object({
  page: z.string().optional(),
  size: z.string().optional(),
  status: z.enum(STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
});

const updateBodySchema = z.object({
  status: z.enum(STATUSES).optional(),
  adminNotes: z.string().max(5000).optional(),
});

// GET /admin/error-reports?page=1&size=20&status=open&category=bug — triage list
router.get('/', validate(listQuerySchema, 'query'), ctrl.listErrorReports);

// GET /admin/error-reports/:id — full detail incl. metadata/reporter
router.get('/:id', ctrl.getErrorReport);

// PATCH /admin/error-reports/:id — update triage status / admin notes
router.patch('/:id', validate(updateBodySchema, 'body'), ctrl.updateErrorReport);

module.exports = router;
