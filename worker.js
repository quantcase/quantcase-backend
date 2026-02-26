require('dotenv').config();
const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const Anthropic = require('@anthropic-ai/sdk');
const { transcriptExtractorPrompt } = require('./utils/prompts/transcript_call');
const { summarySchema } = require('./utils/outputSchemas');
const { upsertNewKpis } = require('./db-utils/upsertKpis');

const TRANSCRIPT_CHAR_LIMIT = 50000;
const MAX_TOKENS = 16000;
const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31'; // Indian FY default

const prisma = new PrismaClient();
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const LLMClient = anthropic.messages;

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch all KPIs from DB and format them for the prompt.
 */
async function getExistingKpisForPrompt() {
  const kpis = await prisma.kpi.findMany({
    include: {
      numerator:   { select: { abbr: true } },
      denominator: { select: { abbr: true } }
    }
  });

  return kpis.map(k => ({
    id:               k.id,
    abbr:             k.abbr,
    full_form:        k.full_form,
    type:             k.type,
    denomination:     k.denomination    ?? undefined,
    numerator_abbr:   k.numerator?.abbr ?? undefined,
    denominator_abbr: k.denominator?.abbr ?? undefined
  }));
}

/**
 * Fetch call_date and basic_industry for the given call.
 */
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

// ─── Main job processor ──────────────────────────────────────────────────────

async function processSummarizationJob(job) {
  const { callId, transcriptText, pptText, type } = job.data;
  console.log(`Processing job ${job.id} (callId: ${callId}, type: ${type})`);

  try {
    // ── Combine transcript + PPT text ──
    const combinedText = [transcriptText || '', pptText || '']
      .filter(t => t.trim().length > 0)
      .join('\n\n');

    if (!combinedText.trim()) {
      throw new Error(`No transcript or PPT text available for call ${callId}`);
    }

    await job.updateProgress(10);

    // ── Fetch context needed for prompt ──
    const [existingKpis, { callDate, basicIndustry }] = await Promise.all([
      getExistingKpisForPrompt(),
      getCallInfo(callId)
    ]);
    console.log(`Loaded ${existingKpis.length} KPIs from DB. Call date: ${callDate}, industry: ${basicIndustry}`);
    await job.updateProgress(25);

    // ── Build prompt ──
    const truncatedText = combinedText.substring(0, TRANSCRIPT_CHAR_LIMIT);
    const prompt = transcriptExtractorPrompt(truncatedText, existingKpis, callDate, FISCAL_YEAR_END);
    console.log(`Prompt length: ${prompt.length} chars`);
    await job.updateProgress(40);

    // ── Call Claude ──
    console.log('Calling Claude API...');
    const stream = LLMClient.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      //output_config: { format: summarySchema }
    });

    const completion = await stream.finalMessage();
    await job.updateProgress(70);

    // ── Parse response ──
    const responseText = completion?.content?.[0]?.text;
    if (!responseText) throw new Error('Empty response from Claude');

    console.log('Claude response received, parsing...');

    const cleaned = responseText.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ?? responseText.trim();
    const extractedData = JSON.parse(cleaned);

    // ── Persist new KPIs first (before summary, so abbrs resolve correctly) ──
    if (extractedData.new_kpis?.length > 0 || extractedData.kpis?.length > 0) {
      console.log(`Processing KPIs — existing: ${extractedData.kpis?.length ?? 0}, new: ${extractedData.new_kpis?.length ?? 0}`);
      const kpiResult = await upsertNewKpis(extractedData, basicIndustry, 'transcript');
      console.log('KPI upsert results:', kpiResult);
      if (kpiResult.failed.length > 0) {
        console.warn('KPI upsert failures:', kpiResult.failed);
      }
    }
    await job.updateProgress(85);

    // ── Upsert summary ──
    const summaryPayload = {
      entities:         extractedData.entities          ?? null,
      milestones:       extractedData.milestones         ?? null,
      riskDisclosures:  extractedData.risk_disclosures   ?? null,
      governanceSignals:extractedData.governance_signals ?? null,
      industryAnalysis: extractedData.industry_analysis
      ? { ...extractedData.industry_analysis, industry: basicIndustry }
      : (basicIndustry ? { industry: basicIndustry } : null),
      tone:             extractedData.tone               ?? null,
      confidence:       extractedData.confidence         ?? null
    };

    const summaryRecord = await prisma.summary.upsert({
      where:  { callId },
      update: summaryPayload,
      create: { callId, ...summaryPayload }
    });
    console.log(`Summary updated: ${summaryRecord.id}`);
    await job.updateProgress(100);

    console.log(`Job ${job.id} completed successfully`);
    return { summaryId: summaryRecord.id, extractedData };

  } catch (error) {
    console.error(`Job ${job.id} failed:`, error);
    throw error;
  }
}

// ─── Worker setup ────────────────────────────────────────────────────────────

const summarizationWorker = new Worker('summarization', processSummarizationJob, {
  connection,
  concurrency: 1,
  limiter: { max: 10, duration: 1000 }
});

summarizationWorker.on('completed', (job) => console.log(`Job ${job.id} completed`));
summarizationWorker.on('failed',    (job, err) => console.error(`Job ${job.id} failed:`, err.message));
summarizationWorker.on('error',     (err) => console.error('Worker error:', err));

console.log('Summarization worker started...');

const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down...`);
  await summarizationWorker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));