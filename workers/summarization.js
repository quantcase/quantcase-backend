const { Worker } = require('bullmq');
const { connection, prisma, llmStream, parseJson } = require('../lib/workerSetup');
const { transcriptExtractorPrompt } = require('../prompts/transcript_call');
const { upsertNewKpis } = require('../db-utils/upsertKpis');

const TRANSCRIPT_CHAR_LIMIT = 50000;
const MAX_TOKENS = 16000;
const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31';

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
      riskDisclosures:   extractedData.risk_disclosures    ?? null,
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
    await job.updateProgress(100);

    console.log(`Summarization job ${job.id} completed`);
    return { summaryId: summaryRecord.id, extractedData };

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
