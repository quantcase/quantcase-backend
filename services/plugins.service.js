'use strict';

const prisma   = require('../config/prisma');
const jobQueue = require('../lib/jobQueue');

// Maps skill.name → the BullMQ queue that processes it.
// All ofactor sub-skills share the same queue; the `section` field distinguishes them.
const SKILL_TO_QUEUE = {
  summarization:                'summarization',
  qe_extraction:                'qe_extraction',
  deal_analysis:                'deal_analysis',
  ofactor_industry:             'ofactor_analysis',
  ofactor_competition:          'ofactor_analysis',
  ofactor_financial_strength:   'ofactor_analysis',
  ofactor_customer_traction:    'ofactor_analysis',
  ofactor_final_takeaways:      'ofactor_analysis',
  wealthos_suggestion:          'wealthos_suggestion',
  wealthos_message:             'wealthos_message',
};

// For ofactor skills, the `section` field tells the worker which sub-prompt to run.
const SKILL_TO_SECTION = {
  ofactor_industry:             'industry',
  ofactor_competition:          'competition',
  ofactor_financial_strength:   'financial_strength',
  ofactor_customer_traction:    'customer_traction',
  ofactor_final_takeaways:      'final_takeaways',
};

/**
 * Fetch a plugin by name with its ordered skill chain.
 * @param {string} pluginName
 */
async function getPluginWithSkills(pluginName) {
  return prisma.plugin.findUnique({
    where:   { name: pluginName },
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
async function enqueuePlugin(pluginName, jobDataBase, skillJobDataOverrides = {}) {
  const plugin = await getPluginWithSkills(pluginName);
  if (!plugin) {
    const err = new Error(`Plugin "${pluginName}" not found`);
    err.status = 404;
    throw err;
  }
  if (!plugin.isActive) {
    const err = new Error(`Plugin "${pluginName}" is inactive`);
    err.status = 400;
    throw err;
  }

  const enqueuedJobs = [];
  for (const ps of plugin.pluginSkills) {
    if (!ps.skill.isActive) continue;

    const queueName = SKILL_TO_QUEUE[ps.skill.name];
    if (!queueName) throw new Error(`No queue mapping for skill "${ps.skill.name}"`);

    const section   = SKILL_TO_SECTION[ps.skill.name];
    const overrides = skillJobDataOverrides[ps.skill.name] ?? {};
    const jobData   = {
      ...jobDataBase,
      type:      ps.skill.name,
      skillName: ps.skill.name,
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
