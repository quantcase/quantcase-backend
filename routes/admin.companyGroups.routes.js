'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const companyGroupsController = require('../controllers/admin.companyGroups.controller');

const companyGroupSchema = z.object({
  name:          z.string().min(1),
  slug:          z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case').optional(),
  description:   z.string().optional(),
  // 'kpi_filter' groups are resolved from a precomputed CompanyGroupMember
  // cache (see /:slug/recompute) instead of live filter_config scanning —
  // filter_config is unused for this type; attach filters via /:slug/filters.
  filter_type:   z.enum(['manual', 'dynamic', 'kpi_filter']),
  filter_config: z.record(z.string(), z.any()),
  // Which HtmlIncrementalSkillConfig.key every ticker in this group should
  // run with (see resolveConfigKeyForTicker) — null clears the mapping.
  config_key:    z.string().nullable().optional(),
});

const updateCompanyGroupSchema = companyGroupSchema.partial();

const attachFilterSchema = z.object({
  kpi_filter_id:   z.string().optional(),
  kpi_filter_slug: z.string().optional(),
}).refine(d => d.kpi_filter_id || d.kpi_filter_slug, { message: 'kpi_filter_id or kpi_filter_slug is required' });

router.get(   '/',              companyGroupsController.listGroups);
router.post(  '/',              validate(companyGroupSchema, 'body'), companyGroupsController.createGroup);
router.get(   '/:slug',         companyGroupsController.getGroup);
router.put(   '/:slug',         validate(updateCompanyGroupSchema, 'body'), companyGroupsController.updateGroup);
router.delete('/:slug',         companyGroupsController.deleteGroup);
router.get(   '/:slug/resolve', companyGroupsController.resolveGroupEndpoint);

// KpiFilter attachment (filter_type: 'kpi_filter' groups only) — filters are
// AND-combined; recompute must be re-run after attach/detach for the change
// to take effect (membership is cached, not live).
router.get(   '/:slug/filters',           companyGroupsController.listFilters);
router.post(  '/:slug/filters',           validate(attachFilterSchema, 'body'), companyGroupsController.attachFilter);
router.delete('/:slug/filters/:id',       companyGroupsController.detachFilter);
router.post(  '/:slug/recompute',         companyGroupsController.recomputeGroup);

module.exports = router;
