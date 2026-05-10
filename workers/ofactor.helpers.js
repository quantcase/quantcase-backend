'use strict';

const prisma           = require('../config/prisma');
const { enqueueSkillJob } = require('../services/plugins.service');

const VALID_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'financial_strength_insights', 'customer_traction', 'final_takeaways']);

const SECTION_TO_SKILL = {
  competition:                  'ofactor-competition',
  financial_strength:           'ofactor-financial-strength-core',
  financial_strength_insights:  'ofactor-financial-strength-insights',
  customer_traction:            'ofactor-customer-traction',
  final_takeaways:              'ofactor-final-takeaways',
};

function resolveIndustrySkill(bfsi) {
  return bfsi ? 'ofactor-industry-bfsi' : 'ofactor-industry';
}

/**
 * Update the `all_steps` array on the root job's DB record.
 */
async function updateAllSteps(rootJobBullmqId, currentSlug, currentStatus, nextSlug) {
  if (!rootJobBullmqId) return;
  try {
    const rootJob = await prisma.job.findUnique({ where: { bullmqId: rootJobBullmqId } });
    if (!rootJob?.result?.all_steps) return;

    const all_steps = rootJob.result.all_steps.map(step => {
      if (step.analysis_type === currentSlug) return { ...step, status: currentStatus };
      if (nextSlug && step.analysis_type === nextSlug) return { ...step, status: 'processing' };
      return step;
    });

    await prisma.job.update({
      where: { bullmqId: rootJobBullmqId },
      data:  { result: { ...rootJob.result, all_steps } },
    });
  } catch (err) {
    console.error('[Chain] Failed to update all_steps:', err.message);
  }
}

/**
 * After a skill completes, look up the next active skill in the plugin chain and enqueue it.
 */
async function enqueueNextPluginSkill(jobData, selfJobId) {
  const { pluginSlug, skillOrder, callId, subjectTicker, type: currentSlug, all_steps } = jobData;
  const rootJobBullmqId = jobData.rootJobBullmqId ?? selfJobId ?? null;
  if (!pluginSlug || skillOrder == null) return;

  const nextPs = await prisma.pluginSkill.findFirst({
    where: {
      plugin: { slug: pluginSlug },
      order:  { gt: skillOrder },
      skill:  { isActive: true },
    },
    orderBy: { order: 'asc' },
    include: { skill: true },
  });

  if (!nextPs) {
    await updateAllSteps(rootJobBullmqId, currentSlug, 'completed', null);
    return;
  }

  const nextSlug = nextPs.skill.slug;
  console.log(`[Chain] ${pluginSlug}: queuing next skill "${nextSlug}" (order=${nextPs.order})`);
  await updateAllSteps(rootJobBullmqId, currentSlug, 'completed', nextSlug);
  await enqueueSkillJob(pluginSlug, nextPs, { callId, subjectTicker, rootJobBullmqId, all_steps });
}

async function getSubjectSummaries(companyPrefix) {
  const rows = await prisma.summaryNew.findMany({
    where:   { callId: { startsWith: companyPrefix } },
    orderBy: { callId: 'desc' },
    take:    2,
  });
  return rows.reverse();
}

/**
 * Auto-discover up to 2 peer companies in the same industry.
 */
async function getAutoPeerSummaries(subjectTicker, industry) {
  if (!industry || industry === 'Unknown Industry') return [];

  const peerCalls = await prisma.earnings_calls.findMany({
    where:   { basic_industry: industry, NOT: { company: subjectTicker } },
    select:  { company: true, id: true },
    orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
  });

  const latestCallByTicker = new Map();
  for (const c of peerCalls) {
    if (!latestCallByTicker.has(c.company)) latestCallByTicker.set(c.company, c.id);
  }

  if (latestCallByTicker.size === 0) return [];

  const allLatestCallIds = [...latestCallByTicker.values()];
  const available = await prisma.summaryNew.findMany({
    where:  { callId: { in: allLatestCallIds } },
    select: { callId: true },
  });

  const availableCallIds = new Set(available.map(s => s.callId));
  const pickedCallIds = allLatestCallIds.filter(id => availableCallIds.has(id)).slice(0, 2);
  if (pickedCallIds.length === 0) return [];

  const peerTickers = pickedCallIds.map(id => id.split('_FY')[0]);
  console.log(`[OFactor] Auto-discovered peer tickers for "${industry}": ${peerTickers.join(', ')}`);

  return prisma.summaryNew.findMany({ where: { callId: { in: pickedCallIds } } });
}

module.exports = {
  VALID_SECTIONS,
  SECTION_TO_SKILL,
  resolveIndustrySkill,
  updateAllSteps,
  enqueueNextPluginSkill,
  getSubjectSummaries,
  getAutoPeerSummaries,
};
