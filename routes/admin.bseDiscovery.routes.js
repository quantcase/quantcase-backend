'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const c = require('../controllers/admin.bseDiscovery.controller');

const approveSchema = z.object({
  docType:     z.enum(['transcript', 'ppt', 'annual_report']),
  url:         z.string().min(1),
  company:     z.string().min(1),
  fiscal_year: z.string().min(1),
  quarter:     z.string().optional(),
  call_date:   z.string().optional(),
});

const previewSchema = z.object({
  url:  z.string().min(1),
  page: z.string().optional(),
});

const dismissSchema = z.object({
  url:    z.string().min(1),
  reason: z.string().optional(),
});

const undismissSchema = z.object({
  url: z.string().min(1),
});

router.post('/run',       c.triggerRun);
router.get( '/runs',      c.getRuns);
router.get( '/urls',      c.listUrls);
router.get( '/preview',   validate(previewSchema, 'query'), c.previewDocument);
router.post('/approve',   validate(approveSchema, 'body'), c.approve);
router.post('/dismiss',   validate(dismissSchema, 'body'), c.dismiss);
router.post('/undismiss', validate(undismissSchema, 'body'), c.undismiss);

module.exports = router;
