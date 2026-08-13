'use strict';

const { Worker } = require('bullmq');
const connection = require('../config/redis');
const prisma = require('../config/prisma');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { computeSourceHash } = require('../utils/sourceHash');
const { postHtmlAnalysisPrompt } = require('../prompts/post_html_analysis');
const {
  fetchLensHtmlOutputs,
  buildL3DataBlock,
  buildL4DataBlock,
} = require('../services/postHtmlAnalysis.service');

// ─── Processor ───────────────────────────────────────────────────────────────

async function processPostHtmlAnalysisJob(job) {
  const { ticker, type, layerId, forceRefresh, fiscal_year, quarter } = job.data;
  console.log(`[PostHtmlAnalysis] Job ${job.id} (ticker: ${ticker}, layer: ${layerId}, type: ${type})`);

  try {
    await prisma.job.upsert({
      where: { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId: ticker, type: `post_html_analysis_${layerId}_${type}`, status: 'processing', bullmqId: job.id },
    });
    await job.updateProgress(10);

    // ── 1. Load config ─────────────────────────────────────────────────────
    const config = await prisma.postHtmlAnalysisConfig.findUnique({
      where: { layer_id_type: { layer_id: layerId, type } },
    });
    if (!config) throw new Error(`No PostHtmlAnalysisConfig found for layer_id=${layerId}, type=${type}`);
    if (!config.is_active) throw new Error(`PostHtmlAnalysisConfig ${layerId}/${type} is inactive`);
    await job.updateProgress(25);

    // ── 2. Build data block (source-specific per layer) ───────────────────
    let dataBlock;
    let inputHash;
    if (layerId === 'l3') {
      const lensOutputs = await fetchLensHtmlOutputs(type, ticker, { fiscal_year, quarter });
      const missingLenses = lensOutputs.filter(l => !l.output).map(l => l.slug);
      if (missingLenses.length > 0) {
        throw new Error(`Missing required L2 HTML outputs for ${ticker}/${type}: ${missingLenses.join(', ')} — run the HTML incremental skills first.`);
      }
      dataBlock = buildL3DataBlock(lensOutputs);
      inputHash = computeSourceHash(...lensOutputs.map(l => l.output?.raw_html ?? ''));
    } else if (layerId === 'l4') {
      const { dataBlock: block, sourceRows } = await buildL4DataBlock(ticker);
      if (sourceRows.length === 0) {
        throw new Error(`No L3 analyses found for ${ticker} — run L3 (management/opportunity/deal) first.`);
      }
      dataBlock = block;
      inputHash = computeSourceHash(...sourceRows.map(r => `${r.type}:${r.updated_at.toISOString()}`));
    } else {
      throw new Error(`Unknown layerId: ${layerId}`);
    }
    await job.updateProgress(40);

    // ── 3. Cache check ──────────────────────────────────────────────────────
    if (!forceRefresh) {
      const cached = await prisma.postHtmlAnalysis.findFirst({
        where: { layer_id: layerId, type, ticker, input_hash: inputHash },
      });
      if (cached) {
        console.log(`[PostHtmlAnalysis] Cache hit for ${ticker}/${layerId}/${type} — skipping LLM`);
        await prisma.job.update({
          where: { bullmqId: job.id },
          data: { status: 'completed', result: { ticker, layerId, type, cached: true } },
        });
        await job.updateProgress(100);
        return { cached: true, ticker, layerId, type };
      }
    }
    await job.updateProgress(50);

    // ── 4. Build prompt + call LLM ────────────────────────────────────────
    const prompt = postHtmlAnalysisPrompt(config.prompt, dataBlock);
    const model = config.model || 'anthropic/claude-sonnet-4.5';
    const maxTokens = config.max_tokens || 16000;
    console.log(`[PostHtmlAnalysis] Prompt length: ${prompt.length} chars`);

    const { text: responseText, usage } = await llmStream({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: `post_html_analysis_${layerId}_${type}`, strict: false, schema: config.output_schema },
      },
    });
    logUsage('PostHtmlAnalysis', usage);
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');
    const result = parseJson(responseText);
    await job.updateProgress(90);

    // ── 5. Upsert result ────────────────────────────────────────────────────
    await prisma.postHtmlAnalysis.upsert({
      where: { layer_id_type_ticker: { layer_id: layerId, type, ticker } },
      update: {
        fiscal_year: fiscal_year ?? null,
        quarter: quarter ?? null,
        config_id: config.id,
        input_hash: inputHash,
        result,
        model,
        input_tokens: usage?.prompt_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        cost_usd: usage?.cost ?? null,
      },
      create: {
        layer_id: layerId,
        type,
        ticker,
        fiscal_year: fiscal_year ?? null,
        quarter: quarter ?? null,
        config_id: config.id,
        input_hash: inputHash,
        result,
        model,
        input_tokens: usage?.prompt_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        cost_usd: usage?.cost ?? null,
      },
    });
    console.log(`[PostHtmlAnalysis] post_html_analysis upserted for ${ticker}/${layerId}/${type}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data: { status: 'completed', result: { ticker, layerId, type } },
    });

    await job.updateProgress(100);
    console.log(`[PostHtmlAnalysis] Job ${job.id} completed`);
    return { ticker, layerId, type, result };

  } catch (error) {
    console.error(`[PostHtmlAnalysis] Job ${job.id} failed:`, error);
    try {
      await prisma.job.upsert({
        where: { bullmqId: job.id },
        update: { status: 'failed', error: error.message },
        create: { callId: ticker, type: `post_html_analysis_${layerId}_${type}`, status: 'failed', bullmqId: job.id, error: error.message },
      });
    } catch (dbErr) {
      console.error('[PostHtmlAnalysis] Failed to update job in DB:', dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('post_html_analysis', processPostHtmlAnalysisJob, {
  connection,
  concurrency: 10,
  limiter: { max: 10, duration: 1000 },
});

worker.on('completed', job => console.log(`[post-html-analysis] Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[post-html-analysis] Job ${job.id} failed:`, err.message));
worker.on('error', err => console.error('[post-html-analysis] Worker error:', err));

console.log('Post HTML Analysis worker ready');

module.exports = worker;
