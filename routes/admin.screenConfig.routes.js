'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const ctrl      = require('../controllers/admin.screenConfig.controller');

const listQuerySchema = z.object({
  search: z.string().optional(),
});

const screenConfigFieldsSchema = z.object({
  label:          z.string().min(1),
  endpoint:       z.string().nullable().optional(),
  periods_shown:  z.coerce.number().int().positive().nullable().optional(),
  decimal_places: z.coerce.number().int().min(0).optional(),
  // Which KpiGroup branch populates this section's rows (e.g.
  // "pnl-statement--annual") -- null/omitted for chart/peer configs, which
  // still use `items` below.
  kpi_group_slug: z.string().nullable().optional(),
  // Makes this ScreenConfig a company-group-scoped variant of another one --
  // e.g. a BFSI-only "financials.pnl.quarterly.bfsi" with variant_of_key:
  // "financials.pnl.quarterly", company_group_slug: "bfsi", and its own
  // kpi_group_slug tree. Both fields must be set together (or neither) --
  // see admin.screenConfig.service.js for the pairing check.
  variant_of_key:     z.string().nullable().optional(),
  company_group_slug: z.string().nullable().optional(),
});

const createScreenConfigSchema = screenConfigFieldsSchema.extend({
  key: z.string().min(1),
});

const updateScreenConfigSchema = screenConfigFieldsSchema.partial();

const itemFieldsSchema = z.object({
  label:               z.string().nullable().optional(),
  display_order:       z.coerce.number().int().optional(),
  highlight:           z.coerce.boolean().optional(),
  expandable:          z.coerce.boolean().optional(),
  decimal_places:      z.coerce.number().int().min(0).nullable().optional(),
  company_group_slug:  z.string().nullable().optional(),
  series_type:         z.enum(['line', 'bar']).optional(),
});

const createItemSchema = itemFieldsSchema.extend({
  kpi_abbr: z.string().min(1),
});

const updateItemSchema = itemFieldsSchema.partial();

// GET /admin/screen-configs?search= — list config sections (e.g. "financials.pnl.annual")
router.get('/', validate(listQuerySchema, 'query'), ctrl.listScreenConfigs);

// POST /admin/screen-configs — create a new config section
router.post('/', validate(createScreenConfigSchema, 'body'), ctrl.createScreenConfig);

router.get('/:key', ctrl.getScreenConfig);

// PUT /admin/screen-configs/:key — edit label/endpoint/periods_shown/decimal_places
router.put('/:key', validate(updateScreenConfigSchema, 'body'), ctrl.updateScreenConfig);

router.delete('/:key', ctrl.deleteScreenConfig);

// Items — which Kpi rows/series/columns belong to this section, in what order
router.post(  '/:key/items', validate(createItemSchema, 'body'), ctrl.addItem);
router.put(   '/:key/items/:itemId', validate(updateItemSchema, 'body'), ctrl.updateItem);
router.delete('/:key/items/:itemId', ctrl.removeItem);

module.exports = router;
