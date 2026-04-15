'use strict';

const { Worker }   = require('bullmq');
const connection   = require('../config/redis');
const prisma       = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { managementAnalysisPrompt } = require('../prompts/management_analysis');
const { loadSkillConfig }          = require('../utils/skillConfig');

// KPI abbreviations from prowess_values_new relevant to management analysis
// (Revenue, Capex, Operating Margin and supporting metrics)
const PROWESS_ABBRS = new Set([
  'REV_OP', 'TOTAL_INCOME',                         // Revenue
  'ASSET_LAND_GRS', 'ASSET_PM_GRS', 'ASSET_PPE',    // Capex / fixed assets
  'ASSET_CWIP',                                      // Capital work in progress
  'EBITDA', 'EBIT', 'PAT', 'PBT',                   // Profitability
  'CFF', 'CFO', 'CFI',                               // Cash flows
  'DEBT_LT', 'DEBT_ST', 'CASH_EQUIV',               // Balance sheet
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract ticker from callId format: TICKER_FYYYY_QX */
function tickerFromCallId(callId) {
  const idx = callId.indexOf('_FY');
  return idx > 0 ? callId.slice(0, idx) : callId;
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processManagementJob(job) {
  const { callId, type } = job.data;
  const ticker = tickerFromCallId(callId);
  console.log(`[Management] Job ${job.id} (callId: ${callId}, ticker: ${ticker})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: type || 'management_analysis', status: 'processing', bullmqId: job.id }
    });
    await job.updateProgress(10);

    // ── 1. All summary_new rows for this ticker (oldest → newest) ──────────
    const summaries = await prisma.summaryNew.findMany({
      where:   { callId: { startsWith: ticker + '_' } },
      orderBy: { callId: 'asc' },
      select: {
        callId:           true,
        tone:             true,
        confidence:       true,
        entities:         true,
        milestones:       true,
        governanceSignals:true,
        riskDisclosures:  true,
        industryAnalysis: true,
      },
    });
    console.log(`[Management] summaries found: ${summaries.length}`);
    await job.updateProgress(20);

    // ── 2. kpi_values for the specific callId (transcript source only) ─────
    const kpiValues = await prisma.kpiValue.findMany({
      where:  { callId, source: 'transcript' },
      select: { callId: true, kpi_abbr: true, value: true, unit: true, start_date: true, end_date: true },
      orderBy: { kpi_abbr: 'asc' },
    });
    console.log(`[Management] transcript kpi_values: ${kpiValues.length}`);
    await job.updateProgress(30);

    // ── 3. prowess_values_new for this company (revenue, capex, op margin) ─
    const call = await prisma.earnings_calls.findUnique({
      where:  { id: callId },
      select: { company: true },
    });
    if (!call) throw new Error(`Earnings call ${callId} not found`);

    const prowessValues = await prisma.prowessValueNew.findMany({
      where: {
        company:  call.company,
        kpi_abbr: { in: [...PROWESS_ABBRS] },
      },
      select:  { fiscal_year: true, quarter: true, kpi_abbr: true, value: true, unit: true },
      orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }, { kpi_abbr: 'asc' }],
    });
    console.log(`[Management] prowess values: ${prowessValues.length}`);
    await job.updateProgress(40);

    // ── 4. Load skill config + build prompt ───────────────────────────────
    const { model, maxTokens, promptTemplate } = await loadSkillConfig('management-analysis');
    const prompt = managementAnalysisPrompt(ticker, summaries, kpiValues, prowessValues, promptTemplate);
    console.log(`[Management] Prompt length: ${prompt.length} chars`);
    await job.updateProgress(50);

    // ── 5. LLM call ───────────────────────────────────────────────────────
    console.log('[Management] Calling LLM...');
    const responseText = await llmStream({
      model,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    });
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    const result = parseJson(responseText);
    await job.updateProgress(90);

    // ── 6. Upsert into ai_insights ────────────────────────────────────────
    await prisma.aiInsight.upsert({
      where:  { ticker_type: { ticker, type: 'management' } },
      update: { insight: result },
      create: { ticker, type: 'management', insight: result },
    });
    console.log(`[Management] ai_insights upserted for ticker: ${ticker}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { callId, ticker } },
    });

    await job.updateProgress(100);
    console.log(`[Management] Job ${job.id} completed`);
    return { ticker, result };

  } catch (error) {
    console.error(`[Management] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: type || 'management_analysis', status: 'failed', bullmqId: job.id, error: error.message }
      });
    } catch (dbErr) {
      console.error(`[Management] Failed to update job in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('management_analysis', processManagementJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job       => console.log(`[management] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[management] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error('[management] Worker error:', err));

console.log('Management analysis worker ready');

module.exports = worker;
