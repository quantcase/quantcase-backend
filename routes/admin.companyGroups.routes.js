'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const companyGroupsController = require('../controllers/admin.companyGroups.controller');

const companyGroupSchema = z.object({
  name:          z.string().min(1),
  slug:          z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case').optional(),
  description:   z.string().optional(),
  filter_type:   z.enum(['manual', 'dynamic']),
  filter_config: z.record(z.string(), z.any()),
  // Which HtmlIncrementalSkillConfig.key every ticker in this group should
  // run with (see resolveConfigKeyForTicker) — null clears the mapping.
  config_key:    z.string().nullable().optional(),
});

const updateCompanyGroupSchema = companyGroupSchema.partial();

router.get(   '/',              companyGroupsController.listGroups);
router.post(  '/',              validate(companyGroupSchema, 'body'), companyGroupsController.createGroup);
router.get(   '/:slug',         companyGroupsController.getGroup);
router.put(   '/:slug',         validate(updateCompanyGroupSchema, 'body'), companyGroupsController.updateGroup);
router.delete('/:slug',         companyGroupsController.deleteGroup);
router.get(   '/:slug/resolve', companyGroupsController.resolveGroupEndpoint);

module.exports = router;
