require('dotenv').config();
const { Worker }      = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const Redis           = require('ioredis');
const Anthropic       = require('@anthropic-ai/sdk');
const fs              = require('fs');
const path            = require('path');
const { dealAnalysisPrompt }  = require('./utils/prompts/deal_analysis');
const { fetchTickerFinancials } = require('./utils/fincrux_helper');
const { upsertDealResult }    = require('./db-utils/upsertDealResult');

const TEMP_DIR   = path.join(__dirname, 'tmp');
const MAX_TOKENS = 8000;

const prisma    = new PrismaClient();
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const connection = new Redis({
  host:                 process.env.REDIS_HOST || 'localhost',
  port:                 process.env.REDIS_PORT || 6379,
  password:             process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch up to 3 most recent summaries for a company (oldest → newest).
 */
async function getRecentSummaries(ticker) {
  const rows = await prisma.summary.findMany({
    where:   { callId: { startsWith: ticker + '_' } },
    orderBy: { createdAt: 'desc' },
    take:    3,
    select:  { callId: true, governanceSignals: true, tone: true, confidence: true },
  });
  return rows.reverse();
}

/**
 * Extract CMP (Current Market Price) from fincrux top_ratios.
 */
function extractCmp(fincruxData) {
  const price = fincruxData?.data?.top_ratios?.['Current Price'];
  if (!price) return null;
  const num = parseFloat(String(price).replace(/[₹,\s]/g, ''));
  return isNaN(num) ? null : num;
}

// ─── Main job processor ───────────────────────────────────────────────────────

async function processDealJob(job) {
  const { callId, ticker, industry, companyName, stockEps, stockPe, industryEps, industryPe } = job.data;
  console.log(`Processing Deal job ${job.id} (callId: ${callId}, ticker: ${ticker})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: 'deal_analysis', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(5);

    // ── Fetch CMP from Fincrux ────────────────────────────────────────────────
    let cmp = null;
    try {
      const fincruxResult = await fetchTickerFinancials(ticker);
      cmp = extractCmp(fincruxResult);
      console.log(`[Deal] CMP for ${ticker}: ₹${cmp}`);
    } catch (err) {
      console.warn(`[Deal] Could not fetch CMP from Fincrux for ${ticker}: ${err.message}`);
    }
    await job.updateProgress(20);

    // ── Fetch recent summaries for management context ─────────────────────────
    const recentSummaries = await getRecentSummaries(ticker);
    console.log(`[Deal] Recent summaries for ${ticker}: ${recentSummaries.length}`);
    await job.updateProgress(35);

    // ── Build prompt ──────────────────────────────────────────────────────────
    const prompt = dealAnalysisPrompt(
      ticker,
      companyName,
      industry,
      cmp,
      stockEps,
      stockPe,
      industryEps,
      industryPe,
      recentSummaries
    );
    console.log(`[Deal] Prompt length: ${prompt.length} chars`);

    // Save prompt to temp file for debugging
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const safeId      = callId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const promptFile  = path.join(TEMP_DIR, `deal_prompt_${safeId}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');
    console.log(`[Deal] Prompt saved to: ${promptFile}`);
    await job.updateProgress(45);

    // ── Call Claude ───────────────────────────────────────────────────────────
    console.log('[Deal] Calling Claude API...');
    const stream = anthropic.messages.stream({
      model:      'claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    });

    const completion = await stream.finalMessage();
    await job.updateProgress(80);

    // ── Parse response ────────────────────────────────────────────────────────
    const responseText = completion?.content?.[0]?.text;
    if (!responseText) throw new Error('Empty response from Claude');

    const responseFile = path.join(TEMP_DIR, `deal_response_${safeId}.txt`);
    fs.writeFileSync(responseFile, responseText, 'utf8');
    console.log(`[Deal] Raw response saved to: ${responseFile}`);

    // Strip optional ```json … ``` fences
    const cleaned = responseText
      .match(/```json\s*([\s\S]*?)\s*```/)?.[1]
      ?? responseText.trim();
    const dealResult = JSON.parse(cleaned);
    await job.updateProgress(90);

    // ── Persist result ────────────────────────────────────────────────────────
    const inputs = { cmp, stockEps, stockPe, industryEps, industryPe };
    await upsertDealResult(callId, ticker, dealResult, inputs, prisma);
    console.log(`[Deal] Result saved for callId: ${callId}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  {
        status: 'completed',
        result: { callId, scenariosGenerated: Object.keys(dealResult) },
      },
    });

    await job.updateProgress(100);
    console.log(`[Deal] Job ${job.id} completed`);
    return dealResult;

  } catch (error) {
    console.error(`[Deal] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: 'deal_analysis', status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) {
      console.error(`[Deal] Failed to update job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker setup ─────────────────────────────────────────────────────────────

const dealWorker = new Worker('deal_analysis', processDealJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 },
});

dealWorker.on('completed', job      => console.log(`[Deal] Job ${job.id} completed`));
dealWorker.on('failed',    (job, err) => console.error(`[Deal] Job ${job.id} failed:`, err.message));
dealWorker.on('error',     err      => console.error('[Deal] Worker error:', err));

console.log('Deal analysis worker started...');

const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down Deal worker...`);
  await dealWorker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
