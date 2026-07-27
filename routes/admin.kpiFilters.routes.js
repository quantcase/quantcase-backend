'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../middleware/validate');
const ctrl     = require('../controllers/admin.kpiFilters.controller');
const { OPERATORS } = require('../services/admin.kpiFilters.service');

const listQuerySchema = z.object({
  search:   z.string().optional(),
  kpi_abbr: z.string().optional(),
});

const FREQUENCIES = ['annual', 'quarterly', 'daily'];

const kpiFilterFieldsSchema = z.object({
  label:      z.string().min(1),
  kpi_abbr:   z.string().min(1),
  operator:   z.enum(OPERATORS),
  value:      z.coerce.number(),
  value_max:  z.coerce.number().nullable().optional(), // required when operator === 'between', checked server-side
  // Nullable/optional here only so the .partial() update schema below can
  // omit it on a PUT that doesn't touch frequency — createKpiFilterSchema
  // overrides this to required. The resolver has no per-Kpi default/pin to
  // fall back on anymore (see financial.js's top docblock), so a filter with
  // no frequency would just silently evaluate every company as non-matching
  // (resolveMetric returns null, not a crash) — required at create time so
  // that's never the default, not a subtle admin mistake.
  frequency:  z.enum(FREQUENCIES).nullable().optional(),
});

const createKpiFilterSchema = kpiFilterFieldsSchema.extend({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case').optional(),
  frequency: z.enum(FREQUENCIES),
});

const updateKpiFilterSchema = kpiFilterFieldsSchema.partial();

// GET /admin/kpi-filters?search=&kpi_abbr= — browse/reuse existing filters before creating a new one
router.get('/', validate(listQuerySchema, 'query'), ctrl.listKpiFilters);

router.post('/', validate(createKpiFilterSchema, 'body'), ctrl.createKpiFilter);

router.get('/:slug', ctrl.getKpiFilter);

router.put('/:slug', validate(updateKpiFilterSchema, 'body'), ctrl.updateKpiFilter);

// Deleting also detaches this filter from any CompanyGroup it was attached to (cascade).
router.delete('/:slug', ctrl.deleteKpiFilter);

module.exports = router;
