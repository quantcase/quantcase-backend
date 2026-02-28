const { Worker } = require('bullmq');
const { connection, prisma, openRouter, parseJson } = require('../lib/workerSetup');
const { quarterlyEarningsPrompt } = require('../prompts/quarterly_earnings');
const { upsertNewKpis } = require('../db-utils/upsertKpis');

const MAX_TOKENS = 16000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function buildPdfBlock(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF download failed: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { type: 'file', file: { filename: 'quarterly_report.pdf', file_data: `data:application/pdf;base64,${base64}` } };
}

// ─── Processor ───────────────────────────────────────────────────────────────

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

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) throw new Error(`Earnings call ${callId} not found`);

    const qeUrl = call.quarterly_result_url?.trim();
    if (!qeUrl) throw new Error(`No quarterly_result_url for call ${callId}`);
    await job.updateProgress(20);

    const kpis = await getQeKpisForPrompt(call.basic_industry);
    console.log(`Loaded ${kpis.length} KPIs (industry: ${call.basic_industry})`);
    await job.updateProgress(35);

    const prompt = quarterlyEarningsPrompt(
      kpis,
      call.quarter     || '',
      call.fiscal_year || '',
      call.call_date   || ''
    );

    console.log(`QE prompt length: ${prompt.length} chars`);
    console.log('Downloading PDF...');
    const pdfBlock = await buildPdfBlock(qeUrl);
    console.log('Calling LLM API with PDF...');

    const stream = await openRouter.chat.completions.create({
      model:    'anthropic/claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      provider: { order: ['Anthropic'], allow_fallbacks: false },
      messages: [{ role: 'user', content: [pdfBlock, { type: 'text', text: prompt }] }],
      stream:   true,
    });
    let responseText = '';
    for await (const chunk of stream) responseText += chunk.choices[0]?.delta?.content ?? '';
    await job.updateProgress(75);

    if (!responseText) throw new Error('Empty response from LLM');

    console.log('Claude response received, parsing...');
    const extractedData = parseJson(responseText);

    console.log(`Processing KPIs — total: ${extractedData.kpis?.length ?? 0}, new: ${extractedData.new_kpis?.length ?? 0}`);
    const kpiResult = await upsertNewKpis(extractedData, call.basic_industry, 'QE');
    console.log('KPI upsert results:', kpiResult);
    if (kpiResult.failed.length > 0) console.warn('KPI upsert failures:', kpiResult.failed);
    await job.updateProgress(90);

    await prisma.summary.upsert({
      where:  { callId },
      update: { kpis: extractedData.kpis || [] },
      create: { callId, kpis: extractedData.kpis || [] }
    });

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

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('qe_extraction', processQeJob, {
  connection,
  concurrency: 1,
  limiter: { max: 5, duration: 1000 }
});

worker.on('completed', job      => console.log(`[qe] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[qe] Job ${job.id} failed:`, err.message));
worker.on('error',     err      => console.error('[qe] Worker error:', err));

console.log('QE extraction worker ready');

module.exports = worker;
