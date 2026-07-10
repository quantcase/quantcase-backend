'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const adminController     = require('../controllers/admin.controller');
const skillsController    = require('../controllers/admin.skills.controller');
const pluginsController   = require('../controllers/admin.plugins.controller');
const schedulerController = require('../controllers/admin.scheduler.controller');
const pipelineDispatchRouter = require('./admin.pipelineDispatch.routes');
const companyGroupsRouter    = require('./admin.companyGroups.routes');
const bseDiscoveryRouter     = require('./admin.bseDiscovery.routes');
const kpiDedupRouter         = require('./admin.kpiDedup.routes');
const documentUploadRouter   = require('./admin.documentUpload.routes');
const pipelineJobsRouter     = require('./admin.pipelineJobs.routes');

// ─── Existing admin routes ────────────────────────────────────────────────────

router.get(
  '/opportunity/stats',
  validate(z.object({ callId: z.string().min(1, 'callId is required') })),
  adminController.getOpportunityStats
);

// ─── Formula registry / indicator provenance ──────────────────────────────────

// Catalogue of all computed metrics — used to populate search bar on admin page.
router.get('/indicators', adminController.listIndicators);

// Full provenance for one metric + ticker: formula, inputs, actual values used.
router.get('/indicators/:ticker/:metricId', adminController.getIndicatorProvenance);

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

// ─── Scheduler Jobs CRUD ─────────────────────────────────────────────────────

router.get(   '/scheduler-jobs',               schedulerController.listJobs);
router.post(  '/scheduler-jobs',               schedulerController.createJob);
router.get(   '/scheduler-jobs/:slug',         schedulerController.getJob);
router.put(   '/scheduler-jobs/:slug',         schedulerController.updateJob);
router.delete('/scheduler-jobs/:slug',         schedulerController.deleteJob);
router.get(   '/scheduler-jobs/:slug/runs',    schedulerController.getJobRuns);
router.post(  '/scheduler-jobs/:slug/run',     schedulerController.triggerJob);

// ─── Pipeline Dispatch (manual, admin-triggered) ────────────────────────────
// L1 today; L2/L3 siblings to follow the same pattern under this namespace.

router.use('/pipeline-dispatch', pipelineDispatchRouter);

// ─── Company Groups (reusable ticker sets, selectable across L1/L2/L3) ──────

router.use('/company-groups', companyGroupsRouter);

// ─── BSE Discovery (manual trigger on Server 2, admin approval on Server 1) ─

router.use('/bse-discovery', bseDiscoveryRouter);

// ─── KPI Dedup (manual, admin-triggered) ────────────────────────────────────
// Phase 6 (per-industry KPI cap) only, exposed from scripts/dedup_kpis.js.

router.use('/kpi-dedup', kpiDedupRouter);

// ─── Document Upload (manual PDF upload for companies with no crawlable URL) ─

router.use('/documents', documentUploadRouter);

// ─── Pipeline Jobs (admin retry/split of failed summarization-v2 chunks) ────
// Redis-only (no Postgres table) — reads/writes BullMQ's own `failed` set.

router.use('/pipeline-jobs', pipelineJobsRouter);

module.exports = router;
