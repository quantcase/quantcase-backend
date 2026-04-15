'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const adminController    = require('../controllers/admin.controller');
const skillsController   = require('../controllers/admin.skills.controller');
const pluginsController  = require('../controllers/admin.plugins.controller');

// ─── Existing admin routes ────────────────────────────────────────────────────

router.get(
  '/opportunity/stats',
  validate(z.object({ callId: z.string().min(1, 'callId is required') })),
  adminController.getOpportunityStats
);

// ─── Skills CRUD ──────────────────────────────────────────────────────────────

const createSkillSchema = z.object({
  name:                z.string().min(1),
  promptKey:           z.string().min(1),
  description:         z.string().optional(),
  model:               z.string().optional(),
  maxTokens:           z.number().int().positive().optional(),
  outputSchema:        z.any(),
  promptTemplate:      z.string().nullable().optional(),
  defaultInstructions: z.string().nullable().optional(),
  isActive:            z.boolean().optional(),
  slug:         z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case').optional(),
});

const updateSkillSchema = createSkillSchema.partial();

router.get(   '/skills',     skillsController.listSkills);
router.post(  '/skills',     validate(createSkillSchema, 'body'), skillsController.createSkill);
router.get(   '/skills/:id', skillsController.getSkill);
router.put(   '/skills/:id', validate(updateSkillSchema, 'body'), skillsController.updateSkill);
router.delete('/skills/:id', skillsController.deleteSkill);

// ─── Plugins CRUD ─────────────────────────────────────────────────────────────

const PLUGIN_CATEGORIES = ['management', 'deal', 'opportunity', 'wealthos', 'technicals'];

const createPluginSchema = z.object({
  name:        z.string().min(1),
  slug:        z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case').optional(),
  category:    z.enum(PLUGIN_CATEGORIES),
  description: z.string().optional(),
  isActive:    z.boolean().optional(),
});

const updatePluginSchema = createPluginSchema.partial();

const addSkillSchema = z.object({
  skillId: z.string().uuid(),
  order:   z.number().int().positive(),
});

const reorderSchema = z.object({
  orderedSkillIds: z.array(z.string().uuid()).min(1),
});

router.get(   '/plugins',                      pluginsController.listPlugins);
router.post(  '/plugins',                      validate(createPluginSchema, 'body'), pluginsController.createPlugin);
router.get(   '/plugins/:id',                  pluginsController.getPlugin);
router.put(   '/plugins/:id',                  validate(updatePluginSchema, 'body'), pluginsController.updatePlugin);
router.delete('/plugins/:id',                  pluginsController.deletePlugin);

// Plugin-Skill association management
router.get(   '/plugins/:id/skills',           pluginsController.listPluginSkills);
router.post(  '/plugins/:id/skills',           validate(addSkillSchema, 'body'), pluginsController.addSkillToPlugin);
router.delete('/plugins/:id/skills/:skillId',  pluginsController.removeSkillFromPlugin);
router.put(   '/plugins/:id/skills/order',     validate(reorderSchema, 'body'), pluginsController.reorderPluginSkills);

module.exports = router;
