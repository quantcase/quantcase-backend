'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/clients.controller');

const SEGMENTS      = ['HNI', 'UHNI', 'Retail', 'Institutional', 'Private'];
const RISK_PROFILES = ['conservative', 'moderate', 'aggressive'];
const INT_TYPES     = ['call', 'email', 'whatsapp', 'meeting', 'sms'];
const CHANNELS      = ['call', 'email', 'whatsapp'];

const listClientsSchema = z.object({
  page:    z.coerce.number().int().min(1).default(1),
  size:    z.coerce.number().int().min(1).max(100).default(20),
  segment: z.enum(SEGMENTS).optional(),
  rm_id:   z.string().uuid().optional(),
  search:  z.string().optional(),
});

const createClientSchema = z.object({
  name:              z.string().min(1),
  email:             z.string().email().optional(),
  phone:             z.string().optional(),
  rm_id:             z.string().uuid().optional(),
  segment:           z.enum(SEGMENTS),
  risk_profile:      z.enum(RISK_PROFILES),
  engagement_score:  z.number().min(0).max(100).optional(),
  churn_probability: z.number().min(0).max(1).optional(),
  metadata:          z.record(z.string(), z.unknown()).optional(),
});

const updateClientSchema = createClientSchema.partial();

const portfolioSchema = z.object({
  total_value:         z.number().min(0),
  risk_score:          z.number().min(0).max(10).optional(),
  last_rebalance_date: z.string().datetime().optional(),
  holdings:            z.array(z.object({
    symbol: z.string(),
    weight: z.number().min(0).max(1),
    qty:    z.number().min(0),
  })).optional(),
});

const interactionSchema = z.object({
  rm_id:     z.string().uuid().optional(),
  type:      z.enum(INT_TYPES),
  summary:   z.string().optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  timestamp: z.string().datetime().optional(),
  metadata:  z.record(z.string(), z.unknown()).optional(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

const suggestionsFilterSchema = z.object({
  status:   z.enum(['pending', 'used', 'ignored']).optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
});

const generateMessageSchema = z.object({
  channel: z.enum(CHANNELS),
  context: z.string().optional(),
  rm_id:   z.string().uuid().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/',     validate(listClientsSchema, 'query'),    ctrl.listClients);
router.post('/',    validate(createClientSchema, 'body'),    ctrl.createClient);
router.get('/:clientId',                                     ctrl.getClient);
router.put('/:clientId', validate(updateClientSchema, 'body'), ctrl.updateClient);

router.get('/:clientId/portfolio',                           ctrl.getPortfolio);
router.post('/:clientId/portfolio', validate(portfolioSchema, 'body'), ctrl.upsertPortfolio);

router.get('/:clientId/interactions', validate(paginationSchema, 'query'), ctrl.listInteractions);
router.post('/:clientId/interactions', validate(interactionSchema, 'body'), ctrl.createInteraction);

router.get('/:clientId/suggestions', validate(suggestionsFilterSchema, 'query'), ctrl.listSuggestions);
router.get('/:clientId/actions', validate(paginationSchema, 'query'), ctrl.listActions);

router.post('/:clientId/models/:modelId',    ctrl.assignModel);
router.delete('/:clientId/models/:modelId',  ctrl.removeModel);

router.post(
  '/:clientId/message/generate',
  validate(generateMessageSchema, 'body'),
  ctrl.generateMessage
);

module.exports = router;
