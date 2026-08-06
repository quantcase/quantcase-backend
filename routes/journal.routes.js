'use strict';

const router       = require('express').Router();
const { z }        = require('zod');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const ctrl         = require('../controllers/journal.controller');
const { VALID_SUB_FACTORS, resolveSubFactorSlug } = require('../services/journal/journal.service');

const ALL_SUB_FACTORS = Object.values(VALID_SUB_FACTORS).flat();

// Accepts the display label (case-insensitive), a legacy label, or a lens slug.
const subFactorItem = z.string().refine(v => resolveSubFactorSlug(v) != null, {
  message: `Invalid sub-factor. Valid values: ${ALL_SUB_FACTORS.join(', ')}`,
});

// ─── Schemas (camelCase request bodies) ───────────────────────────────────────

const journalNameSchema = z.object({
  name: z.string().min(1).max(80),
});

const addTickersSchema = z.object({
  tickers: z.array(z.string().min(1)).min(1),
});

// An entry is either a plain note (noteText) or a full thesis (dimension +
// subFactors + thesis + conviction, which must be provided together).
const createEntrySchema = z.object({
  noteText:   z.string().min(1).max(2000).optional(),
  dimension:  z.enum(['M', 'O', 'D']).optional(),
  subFactors: z.array(subFactorItem).min(1).optional(),
  thesis:     z.string().min(1).max(300).optional(),
  conviction: z.number().int().min(1).max(5).optional(),
})
  .refine(o => o.noteText != null || o.dimension != null, {
    message: 'Provide noteText or a thesis (dimension + subFactors + thesis + conviction)',
  })
  .refine(o => o.dimension == null || (o.subFactors != null && o.thesis != null && o.conviction != null), {
    message: 'A thesis requires dimension, subFactors, thesis, and conviction together',
  });

const updateEntrySchema = z.object({
  noteText:   z.string().min(1).max(2000).optional(),
  dimension:  z.enum(['M', 'O', 'D']).optional(),
  subFactors: z.array(subFactorItem).min(1).optional(),
  thesis:     z.string().min(1).max(300).optional(),
  conviction: z.number().int().min(1).max(5).optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field must be provided' });

router.use(authenticate);

// ─── Journals ─────────────────────────────────────────────────────────────────
router.get('/journals',                 ctrl.listJournals);
router.post('/journals',                validate(journalNameSchema, 'body'), ctrl.createJournal);
router.get('/journals/:journalId',      ctrl.getJournalDetail);
router.patch('/journals/:journalId',    validate(journalNameSchema, 'body'), ctrl.renameJournal);
router.delete('/journals/:journalId',   ctrl.deleteJournal);

// ─── Tickers within a journal ─────────────────────────────────────────────────
router.post('/journals/:journalId/tickers',                validate(addTickersSchema, 'body'), ctrl.addTickers);
router.delete('/journals/:journalId/tickers/:ticker',      ctrl.removeTicker);

// ─── Entries for a ticker within a journal ────────────────────────────────────
router.get('/journals/:journalId/tickers/:ticker/entries',  ctrl.listEntries);
router.post('/journals/:journalId/tickers/:ticker/entries', validate(createEntrySchema, 'body'), ctrl.createEntry);

// ─── Entry-level ops (by entry id) ────────────────────────────────────────────
router.patch('/entries/:entryId',           validate(updateEntrySchema, 'body'), ctrl.updateEntry);
router.delete('/entries/:entryId',           ctrl.deleteEntry);
router.post('/entries/:entryId/evaluate',    ctrl.evaluateEntry);

// ─── Holdings journal sync ────────────────────────────────────────────────────
router.post('/sync-holdings',                ctrl.syncHoldings);

module.exports = router;
