'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/opportunities.controller');

const OPP_CATEGORIES = [
  'client_asked', 'life_event', 'idle_cash', 'coverage_gap',
  'rebalance', 'tax_saving', 'new_product', 'estate_planning'
];
const OPP_STATUS = ['open', 'actioned', 'dismissed', 'expired'];

const listOpportunitiesSchema = z.object({
  page:          z.coerce.number().int().min(1).default(1),
  size:          z.coerce.number().int().min(1).max(100).default(20),
  client_id:     z.string().uuid().optional(),
  rm_profile_id: z.string().uuid().optional(),
  category:      z.string().optional(),
  status:        z.string().optional(),
});

const createOpportunitySchema = z.object({
  client_id:           z.string().uuid(),
  category:            z.enum(OPP_CATEGORIES),
  sub_category:        z.string().optional().nullable(),
  headline:            z.string().min(1),
  evidence:            z.string().optional().nullable(),
  source_type:         z.string().optional().default('manual'),
  source_ref:          z.string().optional().nullable(),
  fit_score:           z.number().min(0).max(1).optional(),
  indicative_value_cr: z.number().min(0).optional().nullable(),
  status:              z.enum(OPP_STATUS).optional().default('open'),
  talking_points:      z.any().optional(),
});

const updateOpportunitySchema = createOpportunitySchema.partial();

router.get('/',          validate(listOpportunitiesSchema, 'query'),   ctrl.listOpportunities);
router.get('/summary',  ctrl.getOpportunitiesSummary);
router.post('/',         validate(createOpportunitySchema, 'body'),    ctrl.createOpportunity);
router.put('/:oppId',    validate(updateOpportunitySchema, 'body'),    ctrl.updateOpportunity);

module.exports = router;
