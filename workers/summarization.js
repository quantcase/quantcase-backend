const { Worker } = require('bullmq');
const connection   = require('../config/redis');
const prisma       = require('../config/prisma');
const { llmStream, parseJson, computePeriodType, applyMultiplier } = require('../utils/workerUtils');
const { transcriptExtractorPrompt } = require('../prompts/transcript_call');
const { upsertNewKpis } = require('../services/db/kpis.db');

const TRANSCRIPT_CHAR_LIMIT = 50000;
const MAX_TOKENS = 16000;
const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31';

const DENOM_UNIT = { rupee: 'Cr', percentage: '%', ratio: 'x', other: '' };

// Transcript KPI paths in priority order (first match wins per kpi_abbr)
const TRANSCRIPT_KPI_PATHS = [
  { path: 'client_traction.customer_growth',     extract: d => d?.client_traction?.customer_growth?.kpis },
  { path: 'client_traction.revenue_streams',     extract: d => d?.client_traction?.revenue_streams?.kpis },
  { path: 'industry_analysis.demand',            extract: d => d?.industry_analysis?.demand?.kpis },
  { path: 'industry_analysis.supply',            extract: d => d?.industry_analysis?.supply?.kpis },
  { path: 'industry_analysis.operating_margins', extract: d => d?.industry_analysis?.operating_margins?.kpis },
];

const MILESTONE_CATEGORIES = ['future_goals', 'success_disclosures', 'failure_disclosures'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getExistingKpisForPrompt(basicIndustry) {
  // QE KPIs: include all regardless of industry
  const qeKpis = await prisma.kpi.findMany({ where: { source: 'QE' } });

  // Transcript KPIs: only same industry
  const transcriptWhere = basicIndustry
    ? { source: 'transcript', industry: { has: basicIndustry } }
    : { source: 'transcript' };
  const transcriptKpis = await prisma.kpi.findMany({ where: transcriptWhere });

  return [...qeKpis, ...transcriptKpis].map(k => ({
    id:          k.id,
    abbr:        k.abbr,
    full_form:   k.full_form,
    kpi_type:    k.kpi_type    ?? undefined,
    denomination: k.denomination ?? undefined,
    source:      k.source
  }));
}

async function getCallInfo(callId) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { call_date: true, basic_industry: true }
  });
  let callDate = null;
  if (call?.call_date) {
    const d = new Date(call.call_date);
    callDate = !isNaN(d) ? d.toISOString().slice(0, 10) : call.call_date.slice(0, 10);
  }
  return { callDate, basicIndustry: call?.basic_industry ?? null };
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processSummarizationJob(job) {
  const { callId, transcriptText, pptText, type } = job.data;
  console.log(`Processing summarization job ${job.id} (callId: ${callId}, type: ${type})`);

  try {
    const combinedText = [transcriptText || '', pptText || '']
      .filter(t => t.trim().length > 0)
      .join('\n\n');

    if (!combinedText.trim()) {
      throw new Error(`No transcript or PPT text available for call ${callId}`);
    }
    await job.updateProgress(10);

    const { callDate, basicIndustry } = await getCallInfo(callId);
    const existingKpis = await getExistingKpisForPrompt(basicIndustry);
    console.log(`Loaded ${existingKpis.length} KPIs. Call date: ${callDate}, industry: ${basicIndustry}`);
    await job.updateProgress(25);

    const truncatedText = combinedText.substring(0, TRANSCRIPT_CHAR_LIMIT);
    const prompt = transcriptExtractorPrompt(truncatedText, existingKpis, callDate, FISCAL_YEAR_END);
    console.log(`Prompt length: ${prompt.length} chars`);
    await job.updateProgress(40);

    console.log('Calling LLM API...');
    const responseText = await llmStream({ model: 'anthropic/claude-sonnet-4-6', max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] });
    await job.updateProgress(70);

    if (!responseText) throw new Error('Empty response from LLM');

    console.log('Claude response received, parsing...');
    const extractedData = parseJson(responseText);

    if (extractedData.new_kpis?.length > 0 || extractedData.kpis?.length > 0) {
      console.log(`Processing KPIs — existing: ${extractedData.kpis?.length ?? 0}, new: ${extractedData.new_kpis?.length ?? 0}`);
      const kpiResult = await upsertNewKpis(extractedData, basicIndustry, 'transcript');
      console.log('KPI upsert results:', kpiResult);
      if (kpiResult.failed.length > 0) console.warn('KPI upsert failures:', kpiResult.failed);
    }
    await job.updateProgress(85);

    const summaryPayload = {
      entities:          extractedData.entities           ?? null,
      milestones:        extractedData.milestones          ?? null,
      riskDisclosures:   extractedData.disclosures ?? extractedData.risk_disclosures ?? null,
      governanceSignals: extractedData.governance_signals  ?? null,
      industryAnalysis:  extractedData.industry_analysis
        ? { ...extractedData.industry_analysis, industry: basicIndustry }
        : (basicIndustry ? { industry: basicIndustry } : null),
      financialStrength: extractedData.financial_strength  ?? null,
      clientTraction:    extractedData.client_traction     ?? null,
      tone:              extractedData.tone                ?? null,
      confidence:        extractedData.confidence          ?? null
    };

    const summaryRecord = await prisma.summaryNew.upsert({
      where:  { callId },
      update: summaryPayload,
      create: { callId, ...summaryPayload }
    });
    console.log(`Summary updated: ${summaryRecord.id}`);

    // ── Write transcript KPIs to kpi_values ──────────────────────────────────
    const callMeta = await prisma.earnings_calls.findUnique({
      where:  { id: callId },
      select: { company: true, fiscal_year: true, quarter: true, call_date: true }
    });

    if (callMeta) {
      const kpiMeta = await prisma.kpi.findMany({ select: { abbr: true, denomination: true } });
      const denomMap = new Map(kpiMeta.map(k => [k.abbr, k.denomination]));

      const written = new Set();
      const kpiValueRows = [];

      // Priority-ordered transcript KPI paths (first match per kpi_abbr wins)
      for (const { path, extract } of TRANSCRIPT_KPI_PATHS) {
        const kpisArr = extract(extractedData);
        if (!Array.isArray(kpisArr)) continue;
        for (const k of kpisArr) {
          if (!k?.kpi_abbr || written.has(k.kpi_abbr)) continue;
          const llmVal    = parseFloat(k.value);
          if (isNaN(llmVal)) continue;
          const mult      = Math.round(k.multiplier ?? 1);
          const startDate = k.start_date ?? null;
          const endDate   = k.end_date   ?? null;
          written.add(k.kpi_abbr);
          kpiValueRows.push({
            callId,
            company:     callMeta.company,
            fiscal_year: callMeta.fiscal_year ?? null,
            quarter:     callMeta.quarter     ?? null,
            call_date:   callMeta.call_date   ?? null,
            kpi_abbr:    k.kpi_abbr,
            value:       applyMultiplier(llmVal, mult),
            raw_value:   String(llmVal),
            unit:        DENOM_UNIT[denomMap.get(k.kpi_abbr)] ?? null,
            multiplier:  mult,
            start_date:  startDate,
            end_date:    endDate,
            period_type: computePeriodType(startDate, endDate),
            source:      'transcript',
            source_path: path,
            statement:   k.statement ?? null,
          });
        }
      }

      // Milestones: current_value only, if not already covered by transcript paths
      const milestones = extractedData.milestones ?? {};
      for (const category of MILESTONE_CATEGORIES) {
        const targets = milestones[category]?.financial_targets;
        if (!Array.isArray(targets)) continue;
        for (const t of targets) {
          if (!t?.kpi_abbr || written.has(t.kpi_abbr)) continue;
          const llmVal = parseFloat(t.current_value);
          if (isNaN(llmVal)) continue;
          const mult = Math.round(t.multiplier ?? 1);
          written.add(t.kpi_abbr);
          kpiValueRows.push({
            callId,
            company:     callMeta.company,
            fiscal_year: callMeta.fiscal_year ?? null,
            quarter:     callMeta.quarter     ?? null,
            call_date:   callMeta.call_date   ?? null,
            kpi_abbr:    t.kpi_abbr,
            value:       applyMultiplier(llmVal, mult),
            raw_value:   String(llmVal),
            unit:        DENOM_UNIT[denomMap.get(t.kpi_abbr)] ?? null,
            multiplier:  mult,
            start_date:  null,
            end_date:    null,
            period_type: 'snapshot',
            source:      'transcript',
            source_path: `milestones.${category}`,
            statement:   t.statement ?? null,
          });
        }
      }

      // Delete existing transcript rows, then write.
      // skipDuplicates means QE rows (already written by qe worker) take priority.
      await prisma.kpiValue.deleteMany({ where: { callId, source: 'transcript' } });
      if (kpiValueRows.length > 0) {
        await prisma.kpiValue.createMany({ data: kpiValueRows, skipDuplicates: true });
        console.log(`kpi_values: wrote ${kpiValueRows.length} transcript rows for ${callId}`);
      }

      // ── Write milestone_kpi_targets (full fidelity, separate table) ──────────
      const milestoneRows = [];
      for (const category of MILESTONE_CATEGORIES) {
        const targets = milestones[category]?.financial_targets;
        if (!Array.isArray(targets)) continue;
        for (const t of targets) {
          if (!t?.kpi_abbr) continue;
          const mult        = Math.round(t.multiplier ?? 1);
          const currentVal  = parseFloat(t.current_value);
          const targetedVal = parseFloat(t.targeted_value);
          milestoneRows.push({
            callId,
            company:        callMeta.company,
            fiscal_year:    callMeta.fiscal_year ?? null,
            quarter:        callMeta.quarter     ?? null,
            call_date:      callMeta.call_date   ?? null,
            category,
            kpi_abbr:       t.kpi_abbr,
            statement:      t.statement    ?? null,
            current_value:  isNaN(currentVal)  ? null : applyMultiplier(currentVal,  mult),
            targeted_value: isNaN(targetedVal) ? null : applyMultiplier(targetedVal, mult),
            multiplier:     mult,
            currency:       t.currency     ?? null,
            initial_time:        t.initial_time      ?? null,
            target_time:         t.target_time       ?? null,
            cumulative_period:   Number.isFinite(t.cumulative_period) ? Math.round(t.cumulative_period) : null,
          });
        }
      }

      if (milestoneRows.length > 0) {
        await prisma.milestoneKpiTarget.deleteMany({ where: { callId } });
        await prisma.milestoneKpiTarget.createMany({ data: milestoneRows });
        console.log(`milestone_kpi_targets: wrote ${milestoneRows.length} rows for ${callId}`);
      }
    }

    await job.updateProgress(100);

    console.log(`Summarization job ${job.id} completed`);
    return { summaryId: summaryRecord.id, extractedData, prompt };

  } catch (error) {
    console.error(`Summarization job ${job.id} failed:`, error);
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('summarization', processSummarizationJob, {
  connection,
  concurrency: 1,
  limiter: { max: 10, duration: 1000 }
});

worker.on('completed', job      => console.log(`[summarization] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[summarization] Job ${job.id} failed:`, err.message));
worker.on('error',     err      => console.error('[summarization] Worker error:', err));

console.log('Summarization worker ready');

module.exports = worker;
