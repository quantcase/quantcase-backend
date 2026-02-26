require('dotenv').config();
const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { oFactorAnalysisPrompt } = require('./utils/prompts/ofactor_analysis');
const { fetchMultipleTickerFinancials } = require('./utils/fincrux_helper');
const { upsertOFactorResult } = require('./db-utils/upsertOFactor');

const TEMP_DIR = path.join(__dirname, 'tmp');

const MAX_TOKENS = 16000;

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
 * Fetch up to 2 most recent subject-company summaries (oldest → newest).
 */
async function getSubjectSummaries(companyPrefix) {
  const rows = await prisma.summary.findMany({
    where:   { callId: { startsWith: companyPrefix } },
    orderBy: { createdAt: 'desc' },
    take:    2,
  });
  return rows.reverse(); // oldest → newest for chronological context
}

/**
 * Fetch up to 2 most recent summaries per peer ticker (oldest→newest within each).
 * With 3 peers this yields at most 6 rows total.
 */
async function getPeerSummaries(peerTickers) {
  if (!peerTickers || peerTickers.length === 0) return [];

  const perPeer = await Promise.all(
    peerTickers.map(ticker =>
      prisma.summary.findMany({
        where:   { callId: { startsWith: ticker } },
        orderBy: { createdAt: 'desc' },
        take:    2,
      }).then(rows => rows.reverse()) // oldest → newest per peer
    )
  );

  return perPeer.flat();
}

// ─── Main job processor ───────────────────────────────────────────────────────

async function processOFactorJob(job) {
  const { callId, subjectTicker, peerTickers, type } = job.data;
  console.log(`Processing OFactor job ${job.id} (callId: ${callId}, subject: ${subjectTicker})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: type || 'ofactor_analysis', status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(5);

    // ── Fetch earnings call meta ──────────────────────────────────────────────
    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) throw new Error(`Earnings call ${callId} not found`);

    const subjectCompanyName = call.company_name || call.company || subjectTicker;
    const industry           = call.basic_industry || 'Unknown Industry';
    await job.updateProgress(10);

    // ── Fetch financial data for subject + peers in parallel ─────────────────
    const allTickers     = [subjectTicker, ...(peerTickers ?? [])];
    const allFinancialData = await fetchMultipleTickerFinancials(allTickers);
    console.log(`Fetched financials for: ${allTickers.join(', ')}`);
    await job.updateProgress(25);

    // ── Fetch summaries ───────────────────────────────────────────────────────
    const [subjectSummaries, peerSummaries] = await Promise.all([
      getSubjectSummaries(subjectTicker),
      getPeerSummaries(peerTickers ?? []),
    ]);
    console.log(`Subject summaries: ${subjectSummaries.length}, Peer summaries: ${peerSummaries.length}`);
    await job.updateProgress(40);

    // ── Build prompt ──────────────────────────────────────────────────────────
    const prompt = oFactorAnalysisPrompt(
      subjectTicker,
      subjectCompanyName,
      industry,
      allFinancialData,
      subjectSummaries,
      peerSummaries
    );
    console.log(`OFactor prompt length: ${prompt.length} chars`);

    // ── Save prompt to temp file ──────────────────────────────────────────────
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const safeCallId  = callId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const promptFile  = path.join(TEMP_DIR, `ofactor_prompt_${safeCallId}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');
    console.log(`Prompt saved to: ${promptFile}`);

    await job.updateProgress(50);

    // ── Call Claude ───────────────────────────────────────────────────────────
    console.log('Calling Claude API for OFactor analysis...');
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

    // ── Save raw response to temp file ────────────────────────────────────────
    const responseFile = path.join(TEMP_DIR, `ofactor_response_${safeCallId}.txt`);
    fs.writeFileSync(responseFile, responseText, 'utf8');
    console.log(`Response saved to: ${responseFile}`);

    console.log('Claude OFactor response received, parsing...');
    const cleaned = responseText
      .match(/```json\s*([\s\S]*?)\s*```/)?.[1]
      ?? responseText.trim();
    const ofactorResult = JSON.parse(cleaned);

    await job.updateProgress(90);

    // ── Persist result into ofactor_results table ─────────────────────────────
    await upsertOFactorResult(callId, subjectTicker, peerTickers ?? [], ofactorResult);
    console.log(`OFactor analysis saved for callId: ${callId}`);

    // ── Mark job completed ────────────────────────────────────────────────────
    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  {
        status: 'completed',
        result: { callId, sectionsGenerated: Object.keys(ofactorResult) },
      },
    });

    await job.updateProgress(100);
    console.log(`OFactor job ${job.id} completed`);
    return ofactorResult;

  } catch (error) {
    console.error(`OFactor job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: type || 'ofactor_analysis', status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) {
      console.error(`Failed to update OFactor job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker setup ─────────────────────────────────────────────────────────────

const ofactorWorker = new Worker('ofactor_analysis', processOFactorJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 },
});

ofactorWorker.on('completed', job  => console.log(`OFactor job ${job.id} completed`));
ofactorWorker.on('failed',    (job, err) => console.error(`OFactor job ${job.id} failed:`, err.message));
ofactorWorker.on('error',     err  => console.error('OFactor worker error:', err));

console.log('OFactor analysis worker started...');

const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down OFactor worker...`);
  await ofactorWorker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
