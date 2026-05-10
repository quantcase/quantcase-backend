'use strict';

const prisma = require('../config/prisma');
const { getOFactorResult, getLatestOFactorResultByTicker } = require('./db/ofactor.db');
const { isBFSI } = require('../utils/industryClassifier');
const { getPeerDataForCall } = require('./opportunity.peers.service');

const { METRICS: INDUSTRY_METRICS }                  = require('../prompts/of-prompts/industry-prompt');
const { METRICS: COMPETITION_METRICS }               = require('../prompts/of-prompts/competition-prompt');
const { METRICS: FINANCIAL_STRENGTH_METRICS }        = require('../prompts/of-prompts/financial-strength-prompt');
const { METRICS: CUSTOMER_TRACTION_METRICS }         = require('../prompts/of-prompts/customer-traction-prompt');

const VALID_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'customer_traction']);

const SECTION_META = {
  industry:           { metrics: INDUSTRY_METRICS },
  competition:        { metrics: COMPETITION_METRICS },
  financial_strength: { metrics: FINANCIAL_STRENGTH_METRICS },
  customer_traction:  { metrics: CUSTOMER_TRACTION_METRICS },
};

/**
 * Resolve whether a callId belongs to a BFSI company.
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
 * Normalize the financial_strength section from the new schema shape
 * { core, final_scoring, extras } → flat shape { text, metrics, operating_leverage, ... }
 * that the rest of the codebase expects. No-ops if already in flat shape.
 */
function normalizeFinancialStrength(fs) {
  if (!fs || typeof fs !== 'object') return fs;
  // Already flat (old shape) — has text/metrics at top level
  if (fs.text || fs.metrics) return fs;
  // New shape — flatten core + extras + final_scoring
  const { core = {}, extras = {}, final_scoring, ...rest } = fs;
  return {
    ...rest,
    ...(core.text    ? { text: core.text }       : {}),
    ...(core.metrics ? { metrics: core.metrics }  : {}),
    ...(extras.operating_leverage ? { operating_leverage: extras.operating_leverage } : {}),
    ...(extras.free_cash_flow     ? { free_cash_flow:     extras.free_cash_flow }     : {}),
    ...(extras.working_capital    ? { working_capital:    extras.working_capital }    : {}),
    ...(extras.capital_structure  ? { capital_structure:  extras.capital_structure }  : {}),
    ...(final_scoring             ? { final_scoring }                                 : {}),
  };
}

/**
 * Remove cards from the OFactor result that don't apply to BFSI or non-BFSI companies.
 */
function filterOFactorForIndustry(result, bfsi) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };

  if (out.financial_strength) {
    out.financial_strength = normalizeFinancialStrength(out.financial_strength);
  }

  if (bfsi) {
    if (out.financial_strength) {
      const fs = { ...out.financial_strength };
      delete fs.working_capital;
      delete fs.free_cash_flow;
      delete fs.operating_leverage;
      if (fs.text) {
        const text = { ...fs.text };
        delete text.opm_trend;
        fs.text = text;
      }
      out.financial_strength = fs;
    }
    if (out.industry_overview?.text) {
      const io = { ...out.industry_overview };
      io.text = { ...io.text };
      delete io.text.opm_trend;
      out.industry_overview = io;
    }
  } else {
    if (out.industry_overview?.metrics) {
      const io = { ...out.industry_overview };
      io.metrics = { ...io.metrics };
      delete io.metrics.industry_aum;
      out.industry_overview = io;
    }
  }

  return out;
}

function computeTotalScore(result) {
  if (!result) return null;
  const SECTIONS = [
    { key: 'industry_overview',  path: result.industry_overview?.final_scoring,           max: 25 },
    { key: 'competition',        path: result.competition?.final_scoring,                  max: 25 },
    { key: 'financial_strength', path: result.financial_strength?.final_scoring,           max: 25 },
    { key: 'customer_traction',  path: result.customer_traction?.analysis?.final_scoring,  max: 25 },
  ];
  const present = SECTIONS.filter(s => s.path?.score != null);
  if (!present.length) return null;
  return {
    total_score: present.reduce((sum, s) => sum + Number(s.path.score), 0),
    max_score:   present.reduce((sum, s) => sum + s.max, 0),
    sections:    present.map(s => ({ section: s.key, score: Number(s.path.score), max_score: s.max })),
  };
}

async function getOFactorForCall(callId) {
  const [record, call] = await Promise.all([
    getOFactorResult(callId),
    prisma.earnings_calls.findUnique({ where: { id: callId }, select: { basic_industry: true } }),
  ]);
  if (!record) return null;
  const filteredResult = filterOFactorForIndustry(record.result, isBFSI(call?.basic_industry));
  return { result: filteredResult, total_score: computeTotalScore(filteredResult) };
}

async function getOFactorByQuery(callId) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, basic_industry: true },
  });
  const ticker   = call?.company ?? callId.replace(/_FY\d+_Q\d+$/i, '');
  const industry = call?.basic_industry ?? null;

  // Fetch industry from ai_insights + remaining sections from oFactorResult in parallel
  let ofactorRecord = await getOFactorResult(callId);
  if (!ofactorRecord) ofactorRecord = await getLatestOFactorResultByTicker(ticker);

  const industryInsight = await prisma.aiInsight.findUnique({
    where: { ticker_type: { ticker, type: 'nse_industry' } },
  });

  if (!ofactorRecord && !industryInsight) return null;

  const base   = ofactorRecord ? filterOFactorForIndustry(ofactorRecord.result, isBFSI(industry)) : {};
  // NSE industry insight is stored as { industry_analysis: { ... } } — expose it at the top level
  const nseIndustry = industryInsight?.insight?.industry_analysis ?? industryInsight?.insight ?? null;
  const result = {
    ...base,
    ...(nseIndustry ? { industry_analysis: nseIndustry } : {}),
  };

  return { result, total_score: computeTotalScore(result) };
}

function getOFactorPromptData(section, bfsi) {
  if (!VALID_SECTIONS.has(section)) {
    const err = new Error(`Invalid section "${section}". Must be one of: ${[...VALID_SECTIONS].join(', ')}`);
    err.status = 400;
    throw err;
  }
  const meta = SECTION_META[section];
  return { section, bfsi, metrics: meta.metrics };
}

module.exports = {
  resolveBfsi,
  filterOFactorForIndustry,
  computeTotalScore,
  getOFactorForCall,
  getOFactorByQuery,
  getOFactorPromptData,
  getPeerDataForCall,
  VALID_SECTIONS,
};
