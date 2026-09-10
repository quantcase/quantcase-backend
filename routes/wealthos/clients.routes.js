'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/clients.controller');

const SEGMENTS       = ['HNI', 'UHNI', 'Retail', 'Institutional', 'Private'];
const RISK_PROFILES  = ['conservative', 'moderate', 'aggressive'];
const CLIENT_STATUS  = ['prospect', 'onboarding', 'active', 'dormant', 'churned'];
const KYC_STATUS     = ['not_started', 'pending', 'complete', 'expired'];
const CLIENT_SOURCES = ['referral', 'walk_in', 'digital', 'inherited', 'cold_outreach'];
const INT_TYPES      = ['call', 'email', 'meeting', 'sms', 'whatsapp', 'whatsapp_note'];
const INT_OUTCOMES   = ['positive', 'neutral', 'negative', 'needs_follow_up', 'no_show'];
const CHANNELS       = ['call', 'email', 'whatsapp'];
const ASSET_CLASSES  = [
  'equity', 'debt', 'mutual_fund', 'etf', 'pms', 'aif',
  'reit', 'real_estate', 'gold', 'cash', 'other'
];

const listClientsSchema = z.object({
  page:             z.coerce.number().int().min(1).default(1),
  size:             z.coerce.number().int().min(1).max(100).default(20),
  segment:          z.enum(SEGMENTS).optional(),
  lifecycle_status: z.enum(CLIENT_STATUS).optional(),
  kyc_status:       z.enum(KYC_STATUS).optional(),
  risk_profile:     z.enum(RISK_PROFILES).optional(),
  rm_profile_id:    z.string().uuid().optional(),
  rm_id:            z.string().uuid().optional(),
  search:           z.string().optional(),
});

const createClientSchema = z.object({
  name:              z.string().min(1),
  email:             z.string().email().optional().nullable(),
  phone:             z.string().optional().nullable(),
  city:              z.string().optional().nullable(),
  date_of_birth:     z.string().optional().nullable(),
  pan_number:        z.string().optional().nullable(),
  aum_cr:            z.number().min(0).optional().default(0),
  segment:           z.enum(SEGMENTS),
  risk_profile:      z.enum(RISK_PROFILES),
  lifecycle_status:  z.enum(CLIENT_STATUS).optional().default('prospect'),
  kyc_status:        z.enum(KYC_STATUS).optional().default('not_started'),
  source:            z.enum(CLIENT_SOURCES).optional().nullable(),
  rm_profile_id:     z.string().uuid().optional().nullable(),
  rm_id:             z.string().uuid().optional().nullable(),
  engagement_score:  z.number().min(0).max(100).optional(),
  churn_probability: z.number().min(0).max(1).optional(),
  family_members:    z.any().optional(),
  tags:              z.array(z.string()).optional(),
  metadata:          z.record(z.string(), z.unknown()).optional(),
});

const updateClientSchema = createClientSchema.partial();

const portfolioHoldingSchema = z.object({
  ticker:           z.string().optional().nullable(),
  isin:             z.string().optional().nullable(),
  scheme_name:      z.string().optional().nullable(),
  amfi_code:        z.string().optional().nullable(),
  asset_class:      z.enum(ASSET_CLASSES),
  quantity:         z.number().optional().nullable(),
  avg_price:        z.number().optional().nullable(),
  current_value_cr: z.number().optional().nullable(),
  weight_pct:       z.number().optional().nullable(),
  as_of_date:       z.string().optional().nullable(),
});

const portfolioSchema = z.object({
  total_value_cr:      z.number().min(0).optional(),
  total_value:         z.number().min(0).optional(), // backward compatibility
  equity_value_cr:     z.number().min(0).optional().nullable(),
  debt_value_cr:       z.number().min(0).optional().nullable(),
  mf_value_cr:         z.number().min(0).optional().nullable(),
  reit_value_cr:       z.number().min(0).optional().nullable(),
  alt_value_cr:        z.number().min(0).optional().nullable(),
  cash_value_cr:       z.number().min(0).optional().nullable(),
  risk_score:          z.number().min(0).max(10).optional().nullable(),
  last_rebalance_date: z.string().optional().nullable(),
  holdings:            z.array(portfolioHoldingSchema).optional(),
});

const interactionSchema = z.object({
  type:             z.enum(INT_TYPES),
  summary:          z.string().optional().nullable(),
  sentiment:        z.enum(['positive', 'neutral', 'negative']).optional().nullable(),
  outcome:          z.enum(INT_OUTCOMES).optional().nullable(),
  duration_minutes: z.number().int().min(0).optional().nullable(),
  is_pinned:        z.boolean().optional(),
  follow_up_date:   z.string().optional().nullable(),
  timestamp:        z.string().optional(),
  rm_profile_id:    z.string().uuid().optional().nullable(),
  rm_id:            z.string().uuid().optional().nullable(),
  metadata:         z.record(z.string(), z.unknown()).optional().nullable(),
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
  channel:       z.enum(CHANNELS),
  context:       z.string().optional().nullable(),
  rm_profile_id: z.string().uuid().optional().nullable(),
  rm_id:         z.string().uuid().optional().nullable(),
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

router.post('/:clientId/models/:modelId',   ctrl.assignModel);
router.delete('/:clientId/models/:modelId', ctrl.removeModel);

router.post(
  '/:clientId/message/generate',
  validate(generateMessageSchema, 'body'),
  ctrl.generateMessage
);

const notesCtrl = require('../../controllers/wealthos/notes.controller');

const noteSchema = z.object({
  content:   z.string().min(1),
  is_pinned: z.boolean().optional(),
});

router.get('/:clientId/notes', notesCtrl.listNotes);
router.post('/:clientId/notes', validate(noteSchema, 'body'), notesCtrl.createNote);
router.put('/:clientId/notes/:noteId', validate(noteSchema.partial(), 'body'), notesCtrl.updateNote);
router.delete('/:clientId/notes/:noteId', notesCtrl.deleteNote);

module.exports = router;
