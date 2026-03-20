const { Worker } = require('bullmq');
const connection   = require('../config/redis');
const prisma       = require('../config/prisma');
const openRouter   = require('../config/llm');
const { parseJson, computePeriodType, applyMultiplier } = require('../utils/workerUtils');
const { quarterlyEarningsPrompt } = require('../prompts/quarterly_earnings');
const { upsertNewKpis } = require('../services/db/kpis.db');

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
// every leaf KPI node into a flat array.
// Each entry: { kpi_abbr, kpi_value, start_date, end_date, multiplier }
function flattenQeResult(data) {
  const out = [];
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if ('abbr' in obj && 'value' in obj) {
      out.push({
        kpi_abbr:   obj.abbr,
        kpi_value:  obj.value,
        start_date: obj.start_date  ?? null,
        end_date:   obj.end_date    ?? null,
        multiplier: obj.multiplier  ?? 1,
      });
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

    // ── Write flattened KPIs to kpi_values ────────────────────────────────────
    // Load denomination map for unit lookup
    const kpiMeta = await prisma.kpi.findMany({ select: { abbr: true, denomination: true } });
    const denomMap = new Map(kpiMeta.map(k => [k.abbr, k.denomination]));
    const DENOM_UNIT = { rupee: 'Cr', percentage: '%', ratio: 'x', other: '' };

    const kpiValueRows = flatKpis
      .filter(k => k.kpi_value != null && !isNaN(parseFloat(k.kpi_value)))
      .map(k => {
        const llmVal    = parseFloat(k.kpi_value);
        const mult      = Math.round(k.multiplier ?? 1);
        const startDate = k.start_date ?? null;
        const endDate   = k.end_date   ?? null;
        return {
          callId,
          company:     call.company,
          fiscal_year: call.fiscal_year ?? null,
          quarter:     call.quarter     ?? null,
          call_date:   call.call_date   ?? null,
          kpi_abbr:    k.kpi_abbr,
          value:       applyMultiplier(llmVal, mult),
          raw_value:   String(llmVal),
          unit:        DENOM_UNIT[denomMap.get(k.kpi_abbr)] ?? null,
          multiplier:  mult,
          start_date:  startDate,
          end_date:    endDate,
          period_type: computePeriodType(startDate, endDate),
          source:      'QE',
          source_path: '',
          statement:   null,
        };
      });

    if (kpiValueRows.length > 0) {
      await prisma.kpiValue.deleteMany({ where: { callId, source: 'QE' } });
      await prisma.kpiValue.createMany({ data: kpiValueRows, skipDuplicates: true });
      console.log(`kpi_values: wrote ${kpiValueRows.length} rows for ${callId}`);
    }

    await prisma.job.update({
      where: { bullmqId: job.id },
      data: {
        status: 'completed',
        result: { callId, kpisExtracted: flatKpis.length }
      }
    });

    await job.updateProgress(100);
    console.log(`QE job ${job.id} completed — ${flatKpis.length} KPI values extracted`);
    return { result: extractedData, prompt };

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
