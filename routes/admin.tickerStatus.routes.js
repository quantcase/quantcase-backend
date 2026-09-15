'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/admin.tickerStatus.controller');

const tickerStatusOptionsSchema = z.object({
  groupSlug: z.string().optional(),
  tickers:   z.array(z.string()).optional(),
  all:       z.boolean().optional(),
  startFrom: z.string().optional(),
  search:    z.string().optional(),
  tier:      z.string().optional(),
  l2Status:  z.string().optional(),
  l3Status:  z.string().optional(),
  l4Status:  z.string().optional(),
  page:      z.number().int().positive().optional(),
  pageSize:  z.number().int().positive().optional(),
});

router.get(  '/options', ctrl.getTickerStatusOptions);
router.post( '/preview', validate(tickerStatusOptionsSchema, 'body'), ctrl.previewTickerStatus);

module.exports = router;
