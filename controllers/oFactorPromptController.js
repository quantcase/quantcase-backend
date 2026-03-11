'use strict';

const prisma    = require('../lib/prisma');
const jobQueue  = require('../lib/jobQueue');
const { isBFSI } = require('../utils/industryClassifier');

const { DEFAULT_INSTRUCTIONS: INDUSTRY_INSTRUCTIONS, METRICS: INDUSTRY_METRICS }                       = require('../prompts/of-prompts/industry-prompt');
const { DEFAULT_INSTRUCTIONS: COMPETITION_INSTRUCTIONS, METRICS: COMPETITION_METRICS }                 = require('../prompts/of-prompts/competition-prompt');
const { DEFAULT_INSTRUCTIONS_NONBFSI, DEFAULT_INSTRUCTIONS_BFSI, METRICS: FINANCIAL_STRENGTH_METRICS } = require('../prompts/of-prompts/financial-strength-prompt');
const { DEFAULT_INSTRUCTIONS: CUSTOMER_TRACTION_INSTRUCTIONS, METRICS: CUSTOMER_TRACTION_METRICS }     = require('../prompts/of-prompts/customer-traction-prompt');

const VALID_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'customer_traction']);

const SECTION_META = {
  industry: {
    instructions:      INDUSTRY_INSTRUCTIONS,
    metrics:           INDUSTRY_METRICS,
  },
  competition: {
    instructions:      COMPETITION_INSTRUCTIONS,
    metrics:           COMPETITION_METRICS,
  },
  financial_strength: {
    instructions:      DEFAULT_INSTRUCTIONS_NONBFSI,
    instructions_bfsi: DEFAULT_INSTRUCTIONS_BFSI,
    metrics:           FINANCIAL_STRENGTH_METRICS,
  },
  customer_traction: {
    instructions:      CUSTOMER_TRACTION_INSTRUCTIONS,
    metrics:           CUSTOMER_TRACTION_METRICS,
  },
};

/**
 * Resolve whether a callId belongs to a BFSI company.
 * Returns false if callId is not provided or the call is not found.
 */
async function resolveBfsi(callId) {
  if (!callId) return false;
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { basic_industry: true },
  });
  return isBFSI(call?.basic_industry);
}

/**
 * GET /api/opportunity/prompt?section=<section>&callId=<callId>
 *
 * Returns the analysis instructions and metric names (not values) for the
 * requested ofactor section. BFSI vs non-BFSI is auto-detected from the
 * call's basic_industry via industryClassifier.
 */
async function getOFactorPrompt(req, res) {
  const { section, callId } = req.query;

  if (!section) {
    return res.status(400).json({ success: false, error: 'section query param is required' });
  }
  if (!VALID_SECTIONS.has(section)) {
    return res.status(400).json({
      success: false,
      error: `Invalid section "${section}". Must be one of: ${[...VALID_SECTIONS].join(', ')}`,
    });
  }

  const bfsi = await resolveBfsi(callId);
  const meta = SECTION_META[section];

  const instructions = (section === 'financial_strength' && bfsi)
    ? meta.instructions_bfsi
    : meta.instructions;

  return res.json({
    success: true,
    data: {
      section,
      bfsi,
      instructions,
      metrics: meta.metrics,
    },
  });
}

/**
 * POST /api/calls/:callId/opportunity/analysis/custom
 *
 * Body: { section, customInstructions }
 *
 * Queues an ofactor analysis job with user-supplied analysis instructions.
 * Results are stored ONLY in the Job record (retrievable via GET /api/jobs/:jobId)
 * and do NOT overwrite the main oFactorResult record for the call.
 */
async function enqueueCustomOFactorAnalysis(req, res) {
  try {
    const { callId } = req.params;
    const { section, customInstructions } = req.body ?? {};

    if (!section) {
      return res.status(400).json({ success: false, error: 'section is required in request body' });
    }
    if (!VALID_SECTIONS.has(section)) {
      return res.status(400).json({
        success: false,
        error: `Invalid section "${section}". Must be one of: ${[...VALID_SECTIONS].join(', ')}`,
      });
    }
    if (!customInstructions || typeof customInstructions !== 'string' || !customInstructions.trim()) {
      return res.status(400).json({ success: false, error: 'customInstructions must be a non-empty string' });
    }

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }

    // Distinct jobId so custom runs never collide with standard runs
    const job = await jobQueue.addJob('ofactor_analysis', {
      callId,
      type:               'ofactor_analysis',
      subjectTicker:      call.company,
      section,
      customInstructions: customInstructions.trim(),
      // Flag tells the worker NOT to write to oFactorResult
      customRun:          true,
    }, { jobId: `ofactor_custom_${callId}_${section}_${Date.now()}` });

    return res.json({
      success: true,
      message: `Custom OFactor "${section}" analysis job queued`,
      job: {
        id:        job.id,
        callId,
        type:      'ofactor_analysis',
        section,
        status:    'pending',
        createdAt: new Date(job.timestamp).toISOString(),
      },
    });
  } catch (error) {
    console.error('Error creating custom OFactor analysis job:', error);
    return res.status(500).json({ success: false, error: 'Failed to create custom OFactor analysis job', message: error.message });
  }
}

module.exports = { getOFactorPrompt, enqueueCustomOFactorAnalysis };
