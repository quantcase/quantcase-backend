'use strict';

const prisma = require('../../config/prisma');
const { resolveGroupBySlug } = require('../companyGroups');
const { dispatchEndpoint } = require('./apiDispatchClient');
const { paginateTickers, chunk } = require('./paginate');
const { TtlCache, cacheKey } = require('./cache');

const cache = new TtlCache();
const PREVIEW_CACHE_TTL_MS = 60_000;
const CSV_CACHE_TTL_MS     = 180_000;
const AVAILABILITY_TICKER_BATCH_SIZE = 150;

async function resolveTickers(options) {
  let tickers;
  if (options.groupSlug) {
    tickers = await resolveGroupBySlug(options.groupSlug);
  } else if (options.all) {
    const [callRows, reportRows] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
    ]);
    tickers = [...new Set([...callRows.map(r => r.company), ...reportRows.map(r => r.company)])]
      .filter(Boolean).sort();
  } else {
    tickers = options.tickers?.length ? options.tickers : [];
  }

  if (options.startFrom) {
    const startFrom = options.startFrom.toUpperCase();
    tickers = tickers.filter(t => t.toUpperCase() >= startFrom);
  }
  return tickers;
}

// Build map of ticker -> hasBaseL2 for a given compressed skill
async function buildL2AvailabilityMap(tickers, baseL2SkillId, historic) {
  const byTicker = new Map(tickers.map(t => [t, false]));
  
  for (const batch of chunk(tickers, AVAILABILITY_TICKER_BATCH_SIZE)) {
    const rows = await prisma.htmlIncrementalSkillOutput.findMany({
      where: {
        skill_id: baseL2SkillId,
        ticker: { in: batch },
        is_historic: historic,
        extracted_json: { not: null }
      },
      select: { ticker: true },
      distinct: ['ticker'],
    });
    for (const r of rows) {
      byTicker.set(r.ticker, true);
    }
  }
  return byTicker;
}

async function previewL2CompressedMultiDispatch(slug, options = {}) {
  const historic = options.historic === true;
  return cache.wrap(cacheKey('l2-compressed-preview', { slug, historic, ...options }), PREVIEW_CACHE_TTL_MS, async () => {
    const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug }, select: { base_l2_skill_id: true } });
    if (!skill) throw new Error(`HtmlCompressedSkill not found: ${slug}`);

    const allTickers = await resolveTickers(options);
    const { pageTickers: tickers, page, pageSize, totalPages } = paginateTickers(allTickers, options);
    
    const availByTicker = await buildL2AvailabilityMap(tickers, skill.base_l2_skill_id, historic);
    
    const perTicker = tickers.map(ticker => {
      const ready = availByTicker.get(ticker) ?? false;
      return { ticker, ready, missing: !ready ? [skill.base_l2_skill_id] : [] };
    });

    return { slug, historic, tickerCount: allTickers.length, page, pageSize, totalPages, perTicker };
  });
}

function escapeCsv(v) {
  return v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
}

async function previewL2CompressedMultiDispatchCsv(slug, options = {}, res) {
  const historic = options.historic === true;
  const perTicker = await cache.wrap(cacheKey('l2-compressed-csv', { slug, historic, ...options }), CSV_CACHE_TTL_MS, async () => {
    const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug }, select: { base_l2_skill_id: true } });
    if (!skill) throw new Error(`HtmlCompressedSkill not found: ${slug}`);

    const tickers = await resolveTickers(options);
    const availByTicker = await buildL2AvailabilityMap(tickers, skill.base_l2_skill_id, historic);
    
    return tickers.map(ticker => {
      const ready = availByTicker.get(ticker) ?? false;
      return { ticker, ready, missing: !ready ? [skill.base_l2_skill_id] : [] };
    });
  });

  res.write(['ticker', 'ready', 'missing'].join(',') + '\n');
  for (const row of perTicker) {
    res.write([row.ticker, row.ready, row.missing.join(';')].map(escapeCsv).join(',') + '\n');
  }
  res.end();
}

async function runL2CompressedMultiDispatch(slug, options = {}) {
  const force = options.force === true;
  const historic = options.historic === true;
  
  const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug }, select: { base_l2_skill_id: true } });
  if (!skill) throw new Error(`HtmlCompressedSkill not found: ${slug}`);

  const tickers = await resolveTickers(options);
  console.log(`[l2-compressed-multi-dispatch] slug=${slug} tickers=${tickers.length} force=${force} historic=${historic}`);

  const availByTicker = await buildL2AvailabilityMap(tickers, skill.base_l2_skill_id, historic);

  const totals = { queued: 0, failed: 0, skipped: 0 };
  const perTicker = [];

  for (const ticker of tickers) {
    const ready = availByTicker.get(ticker) ?? false;
    
    if (!ready) {
      totals.skipped++;
      perTicker.push({ ticker, status: 'skipped', error: 'Missing base L2 extracted JSON' });
      continue;
    }

    try {
      // Need a callId. But the route only requires callId if it's new. Wait, run route requires callId.
      // We must fetch the callId from the base output.
      const baseOutput = await prisma.htmlIncrementalSkillOutput.findFirst({
        where: {
          skill_id: skill.base_l2_skill_id,
          ticker,
          is_historic: historic,
          extracted_json: { not: null }
        },
        orderBy: { created_at: 'desc' },
        select: { call_id: true, fiscal_year: true, quarter: true }
      });
      
      const callId = baseOutput?.call_id ?? 'unknown';

      const result = await dispatchEndpoint(`/api/html-compressed-skills/${slug}/run`, {
        body: { ticker, callId, force, historic, configKey: options.configKey },
      });
      totals.queued++;
      perTicker.push({ ticker, status: 'queued', job: result.job });
    } catch (err) {
      console.error(`[l2-compressed-multi-dispatch] ${ticker}: ${err.message}`);
      totals.failed++;
      perTicker.push({ ticker, status: 'failed', error: err.message });
    }
  }

  console.log(`[l2-compressed-multi-dispatch] done — queued=${totals.queued} failed=${totals.failed} skipped=${totals.skipped}`);
  return { records_processed: totals.queued, ...totals, tickerCount: tickers.length, slug, perTicker };
}

module.exports = {
  previewL2CompressedMultiDispatch,
  previewL2CompressedMultiDispatchCsv,
  runL2CompressedMultiDispatch,
  resolveTickers,
};
