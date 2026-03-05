const { Worker } = require('bullmq');
const { connection, prisma, openRouter, parseJson } = require('../lib/workerSetup');
const { quarterlyEarningsPrompt } = require('../prompts/quarterly_earnings');
const { upsertNewKpis } = require('../db-utils/upsertKpis');

const MAX_TOKENS = 16000;

const QE_KPI_CONFIG = require('../lib/qe_kpi_config.json');
const { isBFSI } = require('../utils/industryClassifier');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getKpiConfigForPrompt(basicIndustry) {
  const industryKey = isBFSI(basicIndustry) ? 'bfsi' : 'non_bfsi';
  const config = QE_KPI_CONFIG[industryKey];

  const kpis = [];

  function extractKpis(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== 'object') continue;
      if (value.label && Array.isArray(value.aliases)) {
        kpis.push({ abbr: key, label: value.label, aliases: value.aliases });
      } else {
        extractKpis(value);
      }
    }
  }

  // Exclude ratios — only traverse balance_sheet, pnl, cashflow
  [config.balance_sheet, config.pnl, config.cashflow].forEach(section => {
    if (section) extractKpis(section);
  });

  return kpis;
}

// Walks the nested QE result (balance_sheet, pnl, cashflow) and collects
// every leaf { abbr, value } node into a flat array of { kpi_abbr, kpi_value }.
function flattenQeResult(data) {
  const out = [];
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if ('abbr' in obj && 'value' in obj) {
      out.push({ kpi_abbr: obj.abbr, kpi_value: obj.value });
      return;
    }
    for (const v of Object.values(obj)) walk(v);
  }
  walk(data.balance_sheet);
  walk(data.pnl);
  walk(data.cashflow);
  return out;
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

    const kpis = getKpiConfigForPrompt(call.basic_industry);
    console.log(`Loaded ${kpis.length} KPIs from config (industry: ${call.basic_industry})`);
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
      model:      'anthropic/claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      provider:   { order: ['Anthropic'], allow_fallbacks: false },
      messages:   [{ role: 'user', content: [pdfBlock, { type: 'text', text: prompt }] }],
      stream:     true,
    });
    let responseText = '';
    for await (const chunk of stream) responseText += chunk.choices[0]?.delta?.content ?? '';
    await job.updateProgress(75);

    if (!responseText) throw new Error('Empty response from LLM');

    console.log('Claude response received, parsing...');
    const extractedData = parseJson(responseText);
    const flatKpis = flattenQeResult(extractedData);

    console.log(`Processing KPIs — total: ${flatKpis.length}`);
    const kpiResult = await upsertNewKpis({ kpis: flatKpis, new_kpis: [] }, call.basic_industry, 'QE');
    console.log('KPI upsert results:', kpiResult);
    if (kpiResult.failed.length > 0) console.warn('KPI upsert failures:', kpiResult.failed);
    await job.updateProgress(90);

    await prisma.summaryNew.upsert({
      where:  { callId },
      update: { kpis: flatKpis },
      create: { callId, kpis: flatKpis }
    });

    await prisma.job.update({
      where: { bullmqId: job.id },
      data: {
        status: 'completed',
        result: { callId, kpisExtracted: flatKpis.length }
      }
    });

    await job.updateProgress(100);
    console.log(`QE job ${job.id} completed — ${flatKpis.length} KPI values extracted`);
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
