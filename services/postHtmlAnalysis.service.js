'use strict';

const prisma = require('../config/prisma');
const jobQueue = require('../lib/jobQueue');
const { stripHtmlToText } = require('../utils/stripHtml');
const { INSIGHT_LENSES } = require('../lib/insightLenses');
const { transcriptPeriodRank } = require('./htmlIncrementalSkill.service');
const { postHtmlAnalysisPrompt } = require('../prompts/post_html_analysis');
const identity = require('./dashboard/identity');

const L3_TYPES = Object.keys(INSIGHT_LENSES); // management | opportunity | deal
const L4_TYPE  = 'summary';

/**
 * Fetch, for each of the 4 lens skills backing an L3 type, the most recent
 * HtmlIncrementalSkillOutput for the ticker (optionally pinned to an exact
 * fiscal_year/quarter). No is_historic filtering — either mode counts, we
 * just want whatever is most recent for that ticker.
 *
 * @param {string} type          "management" | "opportunity" | "deal"
 * @param {string} ticker
 * @param {object} [period]      { fiscal_year, quarter } — optional exact pin
 * @returns {Promise<{ slug: string, output: object|null }[]>}
 */
async function fetchLensHtmlOutputs(type, ticker, period = {}) {
  const slugs = INSIGHT_LENSES[type];
  if (!slugs) throw Object.assign(new Error(`Unknown L3 type: ${type}`), { status: 400 });

  const skills = await prisma.htmlIncrementalSkill.findMany({ where: { slug: { in: slugs } } });
  const skillBySlug = new Map(skills.map(s => [s.slug, s]));

  return Promise.all(slugs.map(async slug => {
    const skill = skillBySlug.get(slug);
    if (!skill) return { slug, output: null };

    if (period.fiscal_year) {
      const output = await prisma.htmlIncrementalSkillOutput.findFirst({
        where: {
          skill_id: skill.id,
          ticker,
          fiscal_year: period.fiscal_year,
          quarter: period.quarter ?? null,
        },
      });
      return { slug, output };
    }

    const candidates = await prisma.htmlIncrementalSkillOutput.findMany({
      where: { skill_id: skill.id, ticker },
      select: { id: true, raw_html: true, fiscal_year: true, quarter: true, updated_at: true },
    });
    if (candidates.length === 0) return { slug, output: null };

    const latest = candidates.reduce((best, cur) => {
      const curRank  = transcriptPeriodRank(cur.fiscal_year, cur.quarter) ?? -Infinity;
      const bestRank = transcriptPeriodRank(best.fiscal_year, best.quarter) ?? -Infinity;
      return curRank > bestRank ? cur : best;
    });
    return { slug, output: latest };
  }));
}

/**
 * Build the stripped, labeled data block for an L3 prompt from the 4 lens
 * HTML outputs (missing lenses are noted, not fatal).
 *
 * @param {{ slug: string, output: object|null }[]} lensOutputs
 * @returns {string}
 */
function buildL3DataBlock(lensOutputs) {
  const sections = lensOutputs.map(({ slug, output }) => {
    if (!output) return `### ${slug}\n(no data available)`;
    const text = stripHtmlToText(output.raw_html);
    return `### ${slug}\n${text}`;
  });
  return sections.join('\n\n');
}

/**
 * Build the L4 data block from the 3 L3 PostHtmlAnalysis results for a ticker.
 *
 * @param {string} ticker
 * @returns {Promise<{ dataBlock: string, sourceRows: object[] }>}
 */
async function buildL4DataBlock(ticker) {
  const rows = await prisma.postHtmlAnalysis.findMany({
    where: { layer_id: 'l3', type: { in: L3_TYPES }, ticker },
  });
  const rowByType = Object.fromEntries(rows.map(r => [r.type, r]));

  const sections = L3_TYPES.map(type => {
    const row = rowByType[type];
    if (!row) return `### ${type}\n(no L3 analysis available — run L3 for this type first)`;
    return `### ${type}\n${JSON.stringify(row.result, null, 2)}`;
  });

  return { dataBlock: sections.join('\n\n'), sourceRows: rows };
}

/**
 * Enqueue post-HTML-analysis jobs for the given ticker.
 *
 * @param {string}   ticker
 * @param {string[]} types        L3: subset of management/opportunity/deal. L4: ['summary']
 * @param {string}   layerId      "l3" | "l4"
 * @param {object}   [opts]
 * @param {boolean}  [opts.forceRefresh]
 * @param {string}   [opts.fiscal_year]
 * @param {string}   [opts.quarter]
 * @returns {Promise<object[]>}  Array of { type, jobId }
 */
async function enqueuePostHtmlAnalysis(ticker, types, layerId, opts = {}) {
  const jobs = await Promise.all(
    types.map(async type => {
      // Deterministic jobId collapses accidental duplicate enqueues (e.g. a
      // double-click) into one job — but BullMQ treats an existing jobId
      // (even a *completed* one still retained under removeOnComplete, see
      // lib/jobQueue.js) as a no-op: it returns the old job without ever
      // re-invoking the worker, silently discarding the new payload. That
      // would swallow forceRefresh entirely, so a forced re-run needs a
      // fresh jobId instead of colliding with whatever ran before.
      const jobId = opts.forceRefresh
        ? `post_html_analysis_${layerId}_${type}_${ticker}_force_${Date.now()}`
        : `post_html_analysis_${layerId}_${type}_${ticker}`;
      const bullmqJob = await jobQueue.addJob(
        'post_html_analysis',
        { ticker, type, layerId, ...opts },
        { jobId },
      );
      return { type, jobId, bullmqId: bullmqJob?.id ?? jobId };
    })
  );
  return jobs;
}

/**
 * Fetch stored PostHtmlAnalysis results for a ticker.
 *
 * @param {string}   ticker
 * @param {string}   layerId
 * @param {string[]} types
 * @returns {Promise<object[]>}
 */
async function getPostHtmlAnalysis(ticker, layerId, types) {
  return prisma.postHtmlAnalysis.findMany({
    where: { ticker, layer_id: layerId, type: { in: types } },
    orderBy: { type: 'asc' },
  });
}

/**
 * Dry-run: assemble the exact prompt that would be sent to the LLM for a
 * given layer/type/ticker, using the current DB config, without calling it.
 *
 * @param {string} layerId       "l3" | "l4"
 * @param {string} type          e.g. "management" | "summary"
 * @param {string} ticker
 * @param {object} [period]      { fiscal_year, quarter } — L3 only
 * @returns {Promise<object>}
 */
async function buildPreviewPrompt(layerId, type, ticker, period = {}) {
  const config = await prisma.postHtmlAnalysisConfig.findUnique({
    where: { layer_id_type: { layer_id: layerId, type } },
  });
  if (!config) throw Object.assign(new Error(`No config found for layer_id=${layerId}, type=${type}`), { status: 404 });

  let dataBlock;
  let sourceMeta;
  if (layerId === 'l3') {
    const lensOutputs = await fetchLensHtmlOutputs(type, ticker, period);
    dataBlock = buildL3DataBlock(lensOutputs);
    sourceMeta = {
      lenses: lensOutputs.map(l => ({
        slug: l.slug,
        available: !!l.output,
        fiscal_year: l.output?.fiscal_year ?? null,
        quarter: l.output?.quarter ?? null,
      })),
    };
  } else if (layerId === 'l4') {
    const { dataBlock: block, sourceRows } = await buildL4DataBlock(ticker);
    dataBlock = block;
    sourceMeta = { sourceTypes: sourceRows.map(r => r.type) };
  } else {
    throw Object.assign(new Error(`Unknown layerId: ${layerId}`), { status: 400 });
  }

  const prompt = postHtmlAnalysisPrompt(config.prompt, dataBlock);
  return {
    config: { id: config.id, name: config.name, model: config.model, max_tokens: config.max_tokens, updated_at: config.updated_at },
    dataBlock,
    prompt,
    sourceMeta,
  };
}

/**
 * Fetches L3 and L4 scores for a list of tickers.
 * Returns a mapping: { [ticker]: { s, m, o, d, w } }
 */
async function getBulkScores(tickers) {
  let rows;
  if (!tickers || tickers.length === 0) {
    rows = await prisma.postHtmlAnalysis.findMany({
      where: { layer_id: { in: ['l3', 'l4'] } },
    });
  } else {
    rows = await prisma.postHtmlAnalysis.findMany({
      where: { ticker: { in: tickers }, layer_id: { in: ['l3', 'l4'] } },
    });
  }

  const scoresByTicker = {};

  for (const row of rows) {
    if (!scoresByTicker[row.ticker]) {
      scoresByTicker[row.ticker] = { s: 0, m: 0, o: 0, d: 0, w: '', m_txt: '', o_txt: '', d_txt: '', n: identity.lookup(row.ticker)?.companyName || row.ticker };
    }
    const result = row.result || {};
    const score = typeof result.score === 'number' ? result.score : 0;
    const thesisHeadline = result.thesis?.headline || result.verdict?.headline || '';
    
    if (row.layer_id === 'l4') {
      scoresByTicker[row.ticker].s = score;
      scoresByTicker[row.ticker].w = result.headline || '';
    } else if (row.layer_id === 'l3') {
      if (row.type === 'management') { scoresByTicker[row.ticker].m = score; scoresByTicker[row.ticker].m_txt = thesisHeadline; }
      if (row.type === 'opportunity') { scoresByTicker[row.ticker].o = score; scoresByTicker[row.ticker].o_txt = thesisHeadline; }
      if (row.type === 'deal') { scoresByTicker[row.ticker].d = score; scoresByTicker[row.ticker].d_txt = thesisHeadline; }
    }
  }

  return scoresByTicker;
}

module.exports = {
  L3_TYPES,
  L4_TYPE,
  fetchLensHtmlOutputs,
  buildL3DataBlock,
  buildL4DataBlock,
  enqueuePostHtmlAnalysis,
  getPostHtmlAnalysis,
  buildPreviewPrompt,
  getBulkScores,
};
