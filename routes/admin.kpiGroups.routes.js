'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../middleware/validate');
const ctrl     = require('../controllers/admin.kpiGroups.controller');

const listQuerySchema = z.object({
  search:    z.string().optional(),
  parent_id: z.string().optional(), // pass '' to fetch root nodes only
});

const kpiGroupFieldsSchema = z.object({
  label:               z.string().min(1),
  parent_id:           z.string().nullable().optional(),
  // Set = this node represents one specific Kpi (a leaf). Omit/null = pure container.
  kpi_abbr:            z.string().nullable().optional(),
  // Optional: this node/branch only applies to companies in this group.
  company_group_slug:  z.string().nullable().optional(),
  display_order:       z.coerce.number().int().optional(),
});

const createKpiGroupSchema = kpiGroupFieldsSchema.extend({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case').optional(),
});

const updateKpiGroupSchema = kpiGroupFieldsSchema.partial();

// GET /admin/kpi-groups?search=&parent_id= — flat list (pass parent_id='' for roots)
router.get('/', validate(listQuerySchema, 'query'), ctrl.listKpiGroups);

// GET /admin/kpi-groups/tree — full nested tree, for rendering screener table/chart sections
router.get('/tree', ctrl.getKpiGroupTree);

router.get('/:slug', ctrl.getKpiGroup);

// POST /admin/kpi-groups — create a container node or a leaf (kpi_abbr set)
router.post('/', validate(createKpiGroupSchema, 'body'), ctrl.createKpiGroup);

// PUT /admin/kpi-groups/:slug — edit label/kpi_abbr/display_order, or reparent (cycle-checked)
router.put('/:slug', validate(updateKpiGroupSchema, 'body'), ctrl.updateKpiGroup);

// DELETE — cascades to descendants (onDelete: Cascade on the self-relation)
router.delete('/:slug', ctrl.deleteKpiGroup);

module.exports = router;
