const { Worker } = require('bullmq');
const fs   = require('fs');
const path = require('path');
const { connection, prisma, llmStream, parseJson } = require('../lib/workerSetup');
const { oFactorAnalysisPrompt }                    = require('../prompts/ofactor_analysis');
const { upsertOFactorResult }                      = require('../db-utils/upsertOFactor');
const { FinHelper }                                = require('../utils/finHelper');

const TEMP_DIR   = path.join(__dirname, '..', 'tmp');
const MAX_TOKENS = 16000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getSubjectSummaries(companyPrefix) {
  const rows = await prisma.summary.findMany({
    where:   { callId: { startsWith: companyPrefix } },
    orderBy: { createdAt: 'desc' },
    take:    2
  });
  return rows.reverse();
}

/**
 * Auto-discover up to 2 peer companies in the same industry.
 * Uses earnings_calls.basic_industry for reliable matching, then fetches
 * the latest summary per peer ticker.
 */
async function getAutoPeerSummaries(subjectTicker, industry) {
  if (!industry || industry === 'Unknown Industry') return [];

  // Find other earnings calls in the same industry
  const peerCalls = await prisma.earnings_calls.findMany({
    where: {
      basic_industry: industry,
      NOT: { id: { startsWith: subjectTicker } }
    },
    select:  { id: true },
    orderBy: { id: 'desc' }
  });

  // Extract up to 2 unique peer tickers
  const seen       = new Set();
  const peerTickers = [];
  for (const c of peerCalls) {
    const ticker = c.id.split('_')[0];
    if (!seen.has(ticker)) {
      seen.add(ticker);
      peerTickers.push(ticker);
      if (peerTickers.length >= 2) break;
    }
  }

  console.log(`[OFactor] Auto-discovered peer tickers for "${industry}": ${peerTickers.join(', ') || 'none'}`);
  if (peerTickers.length === 0) return [];

  // Fetch 1 latest summary per peer ticker
  const summaries = await Promise.all(
    peerTickers.map(ticker =>
      prisma.summary.findFirst({
        where:   { callId: { startsWith: ticker } },
        orderBy: { createdAt: 'desc' }
      })
    )
  );

  return summaries.filter(Boolean);
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processOFactorJob(job) {
  const { callId, subjectTicker, type } = job.data;
  console.log(`Processing OFactor job ${job.id} (callId: ${callId}, subject: ${subjectTicker})`);

  try {
    await prisma.job.upsert({
      where:  { bullmqId: job.id },
      update: { status: 'processing' },
      create: { callId, type: type || 'ofactor_analysis', status: 'processing', bullmqId: job.id }
    });
    await job.updateProgress(5);

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) throw new Error(`Earnings call ${callId} not found`);

    const subjectCompanyName = call.company_name || call.company || subjectTicker;
    const fallbackIndustry   = call.basic_industry || 'Unknown Industry';
    await job.updateProgress(10);

    // ── Get subject summaries first to resolve industry from transcript data ───
    const subjectSummaries = await getSubjectSummaries(subjectTicker);
    const latestSummary    = subjectSummaries[subjectSummaries.length - 1];
    const industry = latestSummary?.industryAnalysis?.industry || fallbackIndustry;
    console.log(`[OFactor] Resolved industry: "${industry}"`);
    await job.updateProgress(20);

    // ── Auto-discover peer companies from same industry ────────────────────────
    const peerSummaries         = await getAutoPeerSummaries(subjectTicker, fallbackIndustry);
    const autoDiscoveredTickers = [...new Set(peerSummaries.map(s => s.callId.split('_')[0]))];
    console.log(`Subject summaries: ${subjectSummaries.length}, Peer summaries: ${peerSummaries.length} (peers: ${autoDiscoveredTickers.join(', ') || 'none'})`);
    await job.updateProgress(30);

    // ── Pre-compute stock + industry metrics from DB ──────────────────────────
    const helper = new FinHelper(prisma);
    const [stockEps, stockPe, industryEps, industryPe, industryOpmResult] = await Promise.all([
      helper.stockEpsCagr(subjectTicker),
      helper.stockPeCagr(subjectTicker),
      fallbackIndustry !== 'Unknown Industry' ? helper.industryEpsCagr(fallbackIndustry) : Promise.resolve(null),
      fallbackIndustry !== 'Unknown Industry' ? helper.industryPeCagr(fallbackIndustry)  : Promise.resolve(null),
      fallbackIndustry !== 'Unknown Industry' ? helper.industryOpm(fallbackIndustry)     : Promise.resolve(null),
    ]);
    console.log(`[OFactor] stockEps:`, stockEps, '| stockPe:', stockPe);
    console.log(`[OFactor] industryEps:`, industryEps, '| industryPe:', industryPe, '| industryOpm:', industryOpmResult);
    await job.updateProgress(45);

    const computedMetrics = { stockEps, stockPe, industryEps, industryPe, industryOpm: industryOpmResult };
    const prompt = oFactorAnalysisPrompt(subjectTicker, subjectCompanyName, industry, subjectSummaries, peerSummaries, computedMetrics);
    console.log(`OFactor prompt length: ${prompt.length} chars`);

    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const safeCallId = callId.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.writeFileSync(path.join(TEMP_DIR, `ofactor_prompt_${safeCallId}.txt`), prompt, 'utf8');
    await job.updateProgress(60);

    console.log('Calling LLM API for OFactor analysis...');
    const responseText = await llmStream({ model: 'anthropic/claude-sonnet-4-6', max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] });
    await job.updateProgress(85);

    if (!responseText) throw new Error('Empty response from LLM');

    fs.writeFileSync(path.join(TEMP_DIR, `ofactor_response_${safeCallId}.txt`), responseText, 'utf8');

    console.log('Claude OFactor response received, parsing...');
    const ofactorResult = parseJson(responseText);
    await job.updateProgress(92);

    await upsertOFactorResult(callId, subjectTicker, autoDiscoveredTickers, ofactorResult, prisma);
    console.log(`OFactor analysis saved for callId: ${callId}`);

    await prisma.job.update({
      where: { bullmqId: job.id },
      data:  { status: 'completed', result: { callId, sectionsGenerated: Object.keys(ofactorResult) } }
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
        create: { callId, type: type || 'ofactor_analysis', status: 'failed', bullmqId: job.id, error: error.message }
      });
    } catch (dbErr) {
      console.error(`Failed to update OFactor job ${job.id} in DB:`, dbErr);
    }
    throw error;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const worker = new Worker('ofactor_analysis', processOFactorJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 }
});

worker.on('completed', job      => console.log(`[ofactor] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[ofactor] Job ${job.id} failed:`, err.message));
worker.on('error',     err      => console.error('[ofactor] Worker error:', err));

console.log('OFactor analysis worker ready');

module.exports = worker;
