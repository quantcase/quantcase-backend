require('dotenv').config();
const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const Anthropic = require('@anthropic-ai/sdk');
const { quarterlyEarningsPrompt } = require('./utils/prompts/quarterly_earnings');
const { upsertNewKpis } = require('./db-utils/upsertKpis');

const MAX_TOKENS = 16000;

const prisma    = new PrismaClient();
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const connection = new Redis({
  host:                 process.env.REDIS_HOST || 'localhost',
  port:                 process.env.REDIS_PORT || 6379,
  password:             process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch KPIs relevant to a QE extraction:
 *   - All KPIs with source = 'QE'
 *   - All KPIs whose industry array includes the call's basic_industry
 */
async function getQeKpisForPrompt(basicIndustry) {
  const where = { OR: [{ source: 'QE' }] };
  if (basicIndustry) where.OR.push({ industry: { has: basicIndustry } });

  const kpis = await prisma.kpi.findMany({
    where,
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
 * Build Claude document content block for the PDF.
 * Tries URL source first; downloads and sends as base64 if the API rejects it.
 */
async function buildPdfBlock(url) {
  return { type: 'document', source: { type: 'url', url } };
}

async function buildPdfBlockBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF download failed: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
}

// ─── Main job processor ───────────────────────────────────────────────────────

async function processQeJob(job) {
  const { callId, type } = job.data;
  console.log(`Processing QE job ${job.id} (callId: ${callId})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: type || 'qe_extraction', status: 'processing', bullmqId: job.id }
    });
    await job.updateProgress(10);

    // ── Fetch call record ──
    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) throw new Error(`Earnings call ${callId} not found`);

    const qeUrl = call.quarterly_result_url?.trim();
    if (!qeUrl) throw new Error(`No quarterly_result_url for call ${callId}`);

    await job.updateProgress(20);

    // ── Fetch relevant KPIs ──
    const kpis = await getQeKpisForPrompt(call.basic_industry);
    console.log(`Loaded ${kpis.length} KPIs (industry: ${call.basic_industry})`);
    await job.updateProgress(35);

    // ── Build prompt ──
    const prompt = quarterlyEarningsPrompt(
      kpis,
      call.quarter      || '',
      call.fiscal_year  || '',
      call.call_date    || ''
    );

    // ── Call Claude (URL first, base64 fallback) ──
    console.log('Calling Claude API with PDF URL...');
    let completion;
    try {
      const pdfBlock = await buildPdfBlock(qeUrl);
      const stream   = anthropic.messages.stream({
        model:      'claude-sonnet-4-5-20250929',
        max_tokens: MAX_TOKENS,
        messages:   [{ role: 'user', content: [pdfBlock, { type: 'text', text: prompt }] }]
      });
      completion = await stream.finalMessage();
    } catch (urlErr) {
      console.warn(`URL source rejected, falling back to base64: ${urlErr.message}`);
      const pdfBlock = await buildPdfBlockBase64(qeUrl);
      const stream   = anthropic.messages.stream({
        model:      'claude-sonnet-4-5-20250929',
        max_tokens: MAX_TOKENS,
        messages:   [{ role: 'user', content: [pdfBlock, { type: 'text', text: prompt }] }]
      });
      completion = await stream.finalMessage();
    }

    await job.updateProgress(75);

    // ── Parse response ──
    const responseText = completion?.content?.[0]?.text;
    if (!responseText) throw new Error('Empty response from Claude');

    console.log('Claude response received, parsing...');
    const cleaned       = responseText.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ?? responseText.trim();
    const extractedData = JSON.parse(cleaned);

    // ── Upsert KPIs (industry update for old, insert for new) ──
    console.log(`Processing KPIs — total: ${extractedData.kpis?.length ?? 0}, new: ${extractedData.new_kpis?.length ?? 0}`);
    const kpiResult = await upsertNewKpis(extractedData, call.basic_industry, 'QE');
    console.log('KPI upsert results:', kpiResult);
    if (kpiResult.failed.length > 0) console.warn('KPI upsert failures:', kpiResult.failed);

    await job.updateProgress(90);

    // ── Upsert Summary with extracted KPI values ──
    await prisma.summary.upsert({
      where:  { callId },
      update: { kpis: extractedData.kpis || [] },
      create: { callId, kpis: extractedData.kpis || [] }
    });

    // ── Mark job completed ──
    await prisma.job.update({
      where: { bullmqId: job.id },
      data: {
        status: 'completed',
        result: { callId, kpisExtracted: extractedData.kpis?.length ?? 0, newKpisFound: extractedData.new_kpis?.length ?? 0 }
      }
    });

    await job.updateProgress(100);
    console.log(`QE job ${job.id} completed — ${extractedData.kpis?.length ?? 0} KPI values extracted`);
    return extractedData;

  } catch (error) {
    console.error(`QE job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where:  { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId, type: type || 'qe_extraction', status: 'failed', bullmqId: job.id, error: error.message }
      });
    } catch (dbErr) {
      console.error(`Failed to update QE job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker setup ─────────────────────────────────────────────────────────────

const qeWorker = new Worker('qe_extraction', processQeJob, {
  connection,
  concurrency: 3,
  limiter: { max: 5, duration: 1000 }
});

qeWorker.on('completed', job  => console.log(`QE job ${job.id} completed`));
qeWorker.on('failed',    (job, err) => console.error(`QE job ${job.id} failed:`, err.message));
qeWorker.on('error',     err  => console.error('QE worker error:', err));

console.log('QE extraction worker started...');

const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down QE worker...`);
  await qeWorker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
