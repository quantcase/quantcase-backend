'use strict';

const prisma   = require('../config/prisma');
const jobQueue = require('../lib/jobQueue');

// Maps skill.slug → the BullMQ queue that processes it.
// All ofactor sub-skills share the same queue; the `section` field distinguishes them.
const SKILL_TO_QUEUE = {
  'summarization':                'summarization',
  'qe-extraction':                'qe_extraction',
  'deal-analysis':                'deal_analysis',
  'ofactor-industry':             'ofactor_analysis',
  'ofactor-competition':          'ofactor_analysis',
  'ofactor-financial-strength':   'ofactor_analysis',
  'ofactor-customer-traction':    'ofactor_analysis',
  'ofactor-final-takeaways':      'ofactor_analysis',
  'wealthos-suggestion':          'wealthos_suggestion',
  'wealthos-message':             'wealthos_message',
};

// For ofactor skills, the `section` field tells the worker which sub-prompt to run.
const SKILL_TO_SECTION = {
  'ofactor-industry':             'industry',
  'ofactor-competition':          'competition',
  'ofactor-financial-strength':   'financial_strength',
  'ofactor-customer-traction':    'customer_traction',
  'ofactor-final-takeaways':      'final_takeaways',
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
      ...overrides,
    };

    // Use a deterministic jobId for ofactor skills to avoid duplicate section jobs
    const jobOptions = section
      ? { jobId: `ofactor_${jobDataBase.callId}_${section}` }
      : {};

    const job = await jobQueue.addJob(queueName, jobData, jobOptions);
    enqueuedJobs.push({ skillName: ps.skill.name, queue: queueName, jobId: job.id });
  }

  return enqueuedJobs;
}

module.exports = { getPluginWithSkills, enqueuePlugin };
