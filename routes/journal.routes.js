'use strict';

const router       = require('express').Router();
const { z }        = require('zod');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const ctrl         = require('../controllers/journal.controller');
const { VALID_SUB_FACTORS } = require('../services/journal/journal.service');

const ALL_SUB_FACTORS = new Set(Object.values(VALID_SUB_FACTORS).flat());

const subFactorItem = z.string().refine(v => ALL_SUB_FACTORS.has(v), {
  message: `Invalid sub-factor. Valid values: ${[...ALL_SUB_FACTORS].join(', ')}`,
});

const createEntrySchema = z.object({
  symbol:        z.string().min(1),
  portfolioType: z.enum(['user', 'shadow']),
  dimension:     z.enum(['M', 'O', 'D']),
  subFactors:    z.array(subFactorItem).min(1),
  thesis:        z.string().min(1).max(300),
  conviction:    z.number().int().min(1).max(5),
});

const updateEntrySchema = z.object({
  dimension:  z.enum(['M', 'O', 'D']).optional(),
  subFactors: z.array(subFactorItem).min(1).optional(),
  thesis:     z.string().min(1).max(300).optional(),
  conviction: z.number().int().min(1).max(5).optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field must be provided' });

router.use(authenticate);

router.get('/pending',                        ctrl.getPending);
router.get('/entries',                        ctrl.getAllEntries);
router.post('/entries',  validate(createEntrySchema, 'body'), ctrl.createEntry);
router.get('/entries/:symbol',                ctrl.getEntry);
router.put('/entries/:entryId',  validate(updateEntrySchema, 'body'), ctrl.updateEntry);
router.delete('/entries/:entryId',            ctrl.deleteEntry);
router.post('/entries/:entryId/evaluate',     ctrl.evaluateEntry);

module.exports = router;
