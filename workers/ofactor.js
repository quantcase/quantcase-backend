'use strict';

const { Worker }     = require('bullmq');
const { randomUUID } = require('crypto');
const connection     = require('../config/redis');
const prisma         = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { upsertOFactorSection } = require('../services/db/ofactor.db');
const { isBFSI }               = require('../utils/industryClassifier');
const { loadSkillConfig }      = require('../utils/skillConfig');
const { deepMerge }            = require('../utils/finExtras');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');
const { writeSignals }         = require('../services/db/signals.db');

const ENABLE_SIGNAL_STORE = process.env.ENABLE_SIGNAL_STORE === 'true';
const { nseIndustryPrompt, selectCompanies, loadCompanyData } = require('../prompts/of-prompts/nse-industry-prompt');

const {
  VALID_SECTIONS, SECTION_TO_SKILL, resolveIndustrySkill,
  updateAllSteps, enqueueNextPluginSkill,
  getSubjectSummaries, getAutoPeerSummaries,
} = require('./ofactor.helpers');

const {
  buildIndustrySection, buildCompetitionSection,
  buildFinancialStrengthSection, buildFinancialStrengthInsightsSection,
  buildCustomerTractionSection, buildFinalTakeawaysSection,
} = require('./ofactor.sections');

// ─── NSE Industry processor ───────────────────────────────────────────────────

async function processNseIndustryJob(job) {
  const { subjectTicker, type } = job.data;
  console.log(`[NseIndustry] Job ${job.id} (subjectTicker: ${subjectTicker})`);

  try {
    const existingNseJob = await prisma.job.findUnique({ where: { bullmqId: job.id } });
    const preserveResult = existingNseJob?.result ? { result: existingNseJob.result } : {};
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing', ...preserveResult },
      create: { callId: subjectTicker, type: 'nse_industry', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(10);

    const existingInsight = await prisma.aiInsight.findUnique({
      where: { ticker_type: { ticker: subjectTicker, type: 'nse_industry' } },
    });
    if (existingInsight) {
      console.log(`[NseIndustry] Cache hit — skipping LLM for ${subjectTicker}`);
      const cachedCall = await prisma.earnings_calls.findFirst({
        where:  { company: subjectTicker },
        select: { basic_industry: true },
      });
      const cachedIndustry = cachedCall?.basic_industry ?? 'Unknown Industry';
      await enqueueNextPluginSkill(job.data, job.id);
      const cachedRootJob = await prisma.job.findUnique({ where: { bullmqId: job.id } });
      await prisma.job.update({
        where: { bullmqId: job.id },
        data:  { status: 'completed', result: { ...(cachedRootJob?.result ?? {}), subjectTicker, industry: cachedIndustry, cached: true } },
      });
      await job.updateProgress(100);
      return { subjectTicker, industry: cachedIndustry, cached: true };
    }

    const call = await prisma.earnings_calls.findFirst({
      where:  { company: subjectTicker },
      select: { basic_industry: true },
    });
    if (!call) throw new Error(`No earnings call found for ticker ${subjectTicker}`);
    const industry = call.basic_industry;
    if (!industry) throw new Error(`No basic_industry mapped for ticker ${subjectTicker}`);
    console.log(`[NseIndustry] industry: ${industry}`);
    await job.updateProgress(20);

    const companies = await selectCompanies(prisma, subjectTicker, industry, 5);
    console.log(`[NseIndustry] companies: ${companies.map(c => c.ticker).join(', ')}`);
    await job.updateProgress(30);

    const companyData = await loadCompanyData(prisma, companies);
    await job.updateProgress(50);

    const { model, maxTokens, promptTemplate } = await loadSkillConfig('nse-industry');
    const prompt = nseIndustryPrompt(industry, companyData, false, promptTemplate);
    console.log(`[NseIndustry] Prompt length: ${prompt.length} chars`);
    await job.updateProgress(55);

    console.log('[NseIndustry] Calling LLM...');
    const responseText = await llmStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');
    const result = parseJson(responseText);
    await job.updateProgress(90);

    await prisma.aiInsight.upsert({
      where:  { ticker_type: { ticker: subjectTicker, type: 'nse_industry' } },
      update: { insight: result },
      create: { ticker: subjectTicker, type: 'nse_industry', insight: result },
    });

    await enqueueNextPluginSkill(job.data, job.id);
    const nseRootJob = await prisma.job.findUnique({ where: { bullmqId: job.id } });
    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { ...(nseRootJob?.result ?? {}), subjectTicker, industry } },
    });
    await job.updateProgress(100);
    return { subjectTicker, industry, result };

  } catch (error) {
    console.error(`[NseIndustry] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId: subjectTicker, type: 'nse_industry', status: 'failed', bullmqId: job.id, error: error.message },
      });
      await updateAllSteps(job.data.rootJobBullmqId, job.data.type, 'failed', null);
    } catch (dbErr) { console.error('[NseIndustry] Failed to update job in DB:', dbErr); }
    throw error;
  }
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processOFactorJob(job) {
  const { callId, subjectTicker, section, type, customInstructions, customRun } = job.data;

  if (type === 'nse-industry' || type === 'industry') return processNseIndustryJob(job);

  console.log(`Processing OFactor job ${job.id} (callId: ${callId}, subject: ${subjectTicker}, section: ${section})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: type || 'ofactor_analysis', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(5);

    if (!VALID_SECTIONS.has(section)) {
      throw new Error(`Invalid section: "${section}". Must be one of: ${[...VALID_SECTIONS].join(', ')}`);
    }

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) throw new Error(`Earnings call ${callId} not found`);

    const fallbackIndustry = call.basic_industry || 'Unknown Industry';
    const bfsiFlag         = isBFSI(call.basic_industry);
    await job.updateProgress(10);

    const skillSlug = section === 'industry' ? resolveIndustrySkill(bfsiFlag) : SECTION_TO_SKILL[section];
    const { model, maxTokens, outputSchema, promptTemplate: dbTemplate, defaultInstructions: dbInstructions } = await loadSkillConfig(skillSlug);

    let promptText, sectionKey, insightsExtras, insightsBfsi;

    if (section === 'final_takeaways') {
      ({ prompt: promptText, sectionKey } = await buildFinalTakeawaysSection(callId, dbTemplate));
      await job.updateProgress(55);
    } else {
      const subjectSummaries = await getSubjectSummaries(subjectTicker);
      const latestSummary    = subjectSummaries[subjectSummaries.length - 1];
      const industry = latestSummary?.industryAnalysis?.industry || fallbackIndustry;
      console.log(`[OFactor] Resolved industry: "${industry}"`);
      await job.updateProgress(20);

      const needsPeers = section === 'industry' || section === 'competition';
      const peerSummaries = needsPeers ? await getAutoPeerSummaries(subjectTicker, industry) : [];
      console.log(`Subject summaries: ${subjectSummaries.length}, Peer summaries: ${peerSummaries.length}`);
      await job.updateProgress(30);

      if (section === 'industry') {
        ({ prompt: promptText, sectionKey } = await buildIndustrySection(subjectTicker, industry, subjectSummaries, peerSummaries, prisma, customInstructions, dbTemplate, dbInstructions));
      } else if (section === 'competition') {
        ({ prompt: promptText, sectionKey } = await buildCompetitionSection(subjectTicker, industry, subjectSummaries, peerSummaries, prisma, customInstructions, dbTemplate, dbInstructions));
      } else if (section === 'financial_strength') {
        ({ prompt: promptText, sectionKey } = await buildFinancialStrengthSection(subjectTicker, industry, subjectSummaries, prisma, customInstructions, dbTemplate, dbInstructions));
      } else if (section === 'financial_strength_insights') {
        ({ prompt: promptText, sectionKey, localExtras: insightsExtras, bfsi: insightsBfsi } = await buildFinancialStrengthInsightsSection(subjectTicker, industry, prisma, dbTemplate));
      } else {
        ({ prompt: promptText, sectionKey } = await buildCustomerTractionSection(subjectTicker, subjectSummaries, prisma, customInstructions, dbTemplate, dbInstructions));
      }
    }

    console.log(`[OFactor] Section "${section}" prompt length: ${promptText.length} chars`);
    await job.updateProgress(55);

    const responseText = await llmStream({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: promptText }],
      ...(outputSchema && { response_format: outputSchema }),
    });
    await job.updateProgress(85);

    if (!responseText || !responseText.trim()) throw new Error('Empty response from LLM');

    const parsed = parseJson(responseText);
    let sectionResult;
    if (sectionKey in parsed) {
      sectionResult = parsed[sectionKey];
    } else {
      sectionResult = parsed;
      console.log(`[OFactor] Section "${section}": LLM returned flat object — using directly.`);
    }

    if (!sectionResult || (typeof sectionResult === 'object' && Object.keys(sectionResult).length === 0)) {
      throw new Error(`[OFactor] Section "${section}" result is empty. Raw: ${responseText.slice(0, 500)}`);
    }

    if (section === 'financial_strength_insights' && insightsExtras) {
      const ins = sectionResult;
      const ol = insightsExtras.operating_leverage;
      if (ol && ins.operating_leverage) {
        if (ol.verdict)           ol.verdict.description         = ins.operating_leverage.verdict_description    ?? null;
        if (ol.total_fixed_costs) ol.total_fixed_costs.note      = ins.operating_leverage.total_fixed_costs_note ?? null;
        if (ol.fixed_cost_lines && ins.operating_leverage.fixed_cost_notes) {
          ol.fixed_cost_lines = ol.fixed_cost_lines.map((l, i) => ({ ...l, note: ins.operating_leverage.fixed_cost_notes[i] ?? null }));
        }
      }
      const fcfE = insightsExtras.free_cash_flow;
      if (fcfE && ins.free_cash_flow) {
        if (fcfE.growth_trajectory) {
          fcfE.growth_trajectory.insight_headline = ins.free_cash_flow.insight_headline ?? null;
          fcfE.growth_trajectory.insight_body     = ins.free_cash_flow.insight_body     ?? null;
        }
        if (fcfE.ocf_to_fcf) fcfE.ocf_to_fcf.drag_description         = ins.free_cash_flow.drag_description        ?? null;
        if (fcfE.fcf_yield)  fcfE.fcf_yield.compression_explanation    = ins.free_cash_flow.compression_explanation ?? null;
      }
      if (!insightsBfsi && insightsExtras.working_capital && ins.working_capital) {
        insightsExtras.working_capital.insight = ins.working_capital.insight ?? null;
      }
      const csE = insightsExtras.capital_structure;
      if (csE && ins.capital_structure) {
        if (csE.balance_sheet)     csE.balance_sheet.insight                = ins.capital_structure.balance_sheet_insight   ?? null;
        if (csE.debt_trajectory)   csE.debt_trajectory.insight              = ins.capital_structure.debt_trajectory_insight ?? null;
        if (csE.equity_allocation) {
          csE.equity_allocation.roe_sublabel    = ins.capital_structure.equity_roe_sublabel    ?? null;
          csE.equity_allocation.payout_sublabel = ins.capital_structure.equity_payout_sublabel ?? null;
          csE.equity_allocation.insight         = ins.capital_structure.equity_insight         ?? null;
        }
        if (csE.capex_intensity) {
          if (ins.capital_structure.capex_notes) {
            csE.capex_intensity.metrics = csE.capex_intensity.metrics.map((m, i) => ({ ...m, note: ins.capital_structure.capex_notes[i] ?? null }));
          }
          csE.capex_intensity.note = ins.capital_structure.capex_note ?? null;
        }
      }

      const existing = await prisma.oFactorResult.findUnique({ where: { callId } });
      const existingFs = existing?.result?.financial_strength ?? {};
      sectionResult = { ...existingFs, extras: insightsExtras };
    }

    await job.updateProgress(90);

    if (customRun) {
      await prisma.job.update({
        where: { bullmqId: job.id },
        data:  { status: 'completed', result: { callId, section, sectionKey } },
      });
    } else {
      await upsertOFactorSection(callId, subjectTicker, section, sectionResult, prisma);

      // ── Write ofactor section score to Signal Store (L1 output) ─────────
      if (ENABLE_SIGNAL_STORE) {
        const scoringSections = ['industry', 'competition', 'financial_strength', 'customer_traction'];
        if (scoringSections.includes(section)) {
          const score = sectionResult?.final_scoring?.score;
          if (score != null && !isNaN(parseFloat(score))) {
            const metricMap = {
              industry:          'industry_overview_score',
              competition:       'competition_score',
              financial_strength:'financial_strength_score',
              customer_traction: 'customer_traction_score',
            };
            const call = await prisma.earnings_calls.findUnique({
              where:  { id: callId },
              select: { company: true, fiscal_year: true, quarter: true, call_date: true },
            });
            const lineageId  = randomUUID();
            const sourceHash = computeSourceHash(promptText);
            const promptV    = computePromptVersion(skillSlug, (await loadSkillConfig(skillSlug)).updatedAt);
            const signals = [
              {
                call_id:         callId,
                ticker:          subjectTicker,
                company:         call?.company ?? subjectTicker,
                fiscal_year:     call?.fiscal_year ?? null,
                quarter:         call?.quarter     ?? null,
                call_date:       call?.call_date   ?? null,
                source_type:     'ofactor',
                signal_type:     'ofactor_section',
                metric:          metricMap[section],
                value:           parseFloat(score),
                raw_value:       String(score),
                metric_family:   'ofactor',
                source_hash:     sourceHash,
                prompt_v:        promptV,
                schema_v:        '1.0.0',
                extractor_model: model,
                w:               0.25,
                b:               0.0,
                confidence:      null,
              },
            ];
            const written = await writeSignals(lineageId, signals);
            console.log(`[signal-store] Wrote ${written} ofactor signal for ${callId} section=${section}`);
          }
        }
      }

      await prisma.job.update({
        where: { bullmqId: job.id },
        data:  { status: 'completed', result: { callId, section, sectionKey, sectionResult } },
      });
    }

    await job.updateProgress(100);
    console.log(`[OFactor] Job ${job.id} completed (section: ${section})`);

    await enqueueNextPluginSkill(job.data, job.id);
    return { section, sectionKey, sectionResult, prompt: promptText };

  } catch (error) {
    console.error(`[OFactor] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: type || 'ofactor_analysis', status: 'failed', bullmqId: job.id, error: error.message },
      });
      await updateAllSteps(job.data.rootJobBullmqId, job.data.type, 'failed', null);
    } catch (dbErr) {
      console.error(`[OFactor] Failed to update job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('ofactor_analysis', processOFactorJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job       => console.log(`[ofactor] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[ofactor] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[ofactor] Worker error:', err));

module.exports = worker;
