'use strict';

const prisma   = require('../config/prisma');
const jobQueue = require('../lib/jobQueue');

// Maps skill.slug → the BullMQ queue that processes it.
// All ofactor sub-skills share the same queue; the `section` field distinguishes them.
const SKILL_TO_QUEUE = {
  'summarization':                        'summarization',
  'qe-extraction':                        'qe_extraction',
  'deal-analysis':                        'deal_analysis',
  'nse-industry':                         'ofactor_analysis',
  'ofactor-industry':                     'ofactor_analysis',
  'ofactor-competition':                  'ofactor_analysis',
  'ofactor-financial-strength-core':      'ofactor_analysis',
  'ofactor-financial-strength-insights':  'ofactor_analysis',
  'ofactor-customer-traction':            'ofactor_analysis',
  'ofactor-final-takeaways':              'ofactor_analysis',
  'wealthos-suggestion':                  'wealthos_suggestion',
  'wealthos-message':                     'wealthos_message',
  'technical-intelligence':               'technicals_analysis',
  'deal-intelligence':                    'deal_intelligence',
  'fundamentals-intelligence':            'fundamentals_analysis',
};

// For ofactor skills, the `section` field tells the worker which sub-prompt to run.
const SKILL_TO_SECTION = {
  'ofactor-industry':                     'industry',
  'ofactor-competition':                  'competition',
  'ofactor-financial-strength-core':      'financial_strength',
  'ofactor-financial-strength-insights':  'financial_strength_insights',
  'ofactor-customer-traction':            'customer_traction',
  'ofactor-final-takeaways':              'final_takeaways',
};

/**
 * Fetch a plugin by name with its ordered skill chain.
 * @param {string} pluginName
 */
async function getPluginWithSkills(pluginSlug) {
  return prisma.plugin.findUnique({
    where:   { slug: pluginSlug },
    include: {
      pluginSkills: {
        orderBy: { order: 'asc' },
        include: { skill: true },
      },
    },
  });
}

/**
 * Enqueue all active skills in a plugin as individual BullMQ jobs.
 *
 * @param {string} pluginName  The plugin to run (e.g. "opportunity")
 * @param {object} jobDataBase Shared job data fields (callId, subjectTicker, etc.)
 * @param {object} [skillJobDataOverrides]  Per-skill overrides keyed by skill.name
 * @returns {Promise<Array<{skillName: string, queue: string, jobId: string}>>}
 */
async function enqueuePlugin(pluginSlug, jobDataBase, skillJobDataOverrides = {}) {
  const plugin = await getPluginWithSkills(pluginSlug);
  if (!plugin) {
    const err = new Error(`Plugin "${pluginSlug}" not found`);
    err.status = 404;
    throw err;
  }
  if (!plugin.isActive) {
    const err = new Error(`Plugin "${pluginSlug}" is inactive`);
    err.status = 400;
    throw err;
  }

  const enqueuedJobs = [];
  for (const ps of plugin.pluginSkills) {
    if (!ps.skill.isActive) continue;

    const skillSlug = ps.skill.slug;
    const queueName = SKILL_TO_QUEUE[skillSlug];
    if (!queueName) throw new Error(`No queue mapping for skill "${ps.skill.name}" (slug: "${skillSlug}")`);

    const section   = SKILL_TO_SECTION[skillSlug];
    const overrides = skillJobDataOverrides[skillSlug] ?? {};
    const jobData   = {
      ...jobDataBase,
      type:      skillSlug,
      skillName: skillSlug,
      ...(section && { section }),
      // nse-industry worker reads subjectTicker; derive it from callId if not already present
      ...(skillSlug === 'nse-industry' && !jobDataBase.subjectTicker && jobDataBase.callId
        ? { subjectTicker: jobDataBase.callId.replace(/_FY\d+_Q\d+$/i, '') }
        : {}),
      ...overrides,
    };

    // Deterministic jobId for ofactor section jobs only (deduplication per callId+section)
    // nse-industry gets no fixed jobId so every trigger creates a fresh job
    const jobOptions = section
      ? { jobId: `ofactor_${jobDataBase.callId}_${section}` }
      : {};

    const job = await jobQueue.addJob(queueName, jobData, jobOptions);
    enqueuedJobs.push({ skillName: skillSlug, queue: queueName, jobId: job.id });
  }

  return enqueuedJobs;
}

/**
 * Enqueue a single plugin skill as a BullMQ job.
 * Used for sequential plugin execution: the worker calls this to chain the next skill
 * after completing the current one.
 *
 * @param {string} pluginSlug   The plugin slug (e.g. "opportunity")
 * @param {object} pluginSkill  A PluginSkill record with { order, skill: { slug, ... } }
 * @param {object} jobDataBase  Shared job data (callId, subjectTicker, etc.)
 * @returns {Promise<object>}   The enqueued BullMQ job
 */
async function enqueueSkillJob(pluginSlug, pluginSkill, jobDataBase) {
  const { skill, order } = pluginSkill;
  const queueName = SKILL_TO_QUEUE[skill.slug];
  if (!queueName) throw new Error(`No queue mapping for skill slug "${skill.slug}"`);

  const section = SKILL_TO_SECTION[skill.slug];
  const jobData = {
    ...jobDataBase,
    type:       skill.slug,
    skillName:  skill.slug,
    pluginSlug,
    skillOrder: order,
    ...(section && { section }),
  };

  // Deterministic jobId for ofactor section jobs (deduplication); nse-industry gets no fixed jobId
  const jobOptions = section
    ? { jobId: `ofactor_${jobDataBase.callId}_${section}` }
    : {};

  return jobQueue.addJob(queueName, jobData, jobOptions);
}

module.exports = { getPluginWithSkills, enqueuePlugin, enqueueSkillJob };
