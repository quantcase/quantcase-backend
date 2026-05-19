'use strict';

const prisma   = require('../config/prisma');
const { enqueueAiInsightSynthesisJob } = require('./aiInsightSynthesis.service');
const { INSIGHT_LENSES, sortLensesByConfig } = require('../lib/insightLenses');

/**
 * Extract ticker from callId (format: TICKER_FYYYY_QX).
 */
function tickerFromCallId(callId) {
  const idx = callId.indexOf('_FY');
  return idx > 0 ? callId.slice(0, idx) : callId;
}

/**
 * Fetch AiInsight objects for the given types and enrich each with
 * the constituent LensScore objects (lens_data, score, status, takeaway, etc.).
 *
 * @param {string}   callId
 * @param {string[]} types  e.g. ['management', 'opportunity']
 * @returns {Promise<object>}
 */
async function getAnalysis(callId, types) {
  const ticker = tickerFromCallId(callId);

  // Fetch all requested AiInsight rows in one query
  const insights = await prisma.aiInsight.findMany({
    where: { ticker, type: { in: types } },
    orderBy: { type: 'asc' },
  });

  // Collect all relevant lens slugs across all requested types
  const allLensSlugs = [...new Set(types.flatMap(t => INSIGHT_LENSES[t] ?? []))];

  // Fetch all relevant LensScores for this call in one query
  const lensScores = await prisma.lensScore.findMany({
    where: { call_id: callId, lens_slug: { in: allLensSlugs }, is_stale: false },
    orderBy: { lens_slug: 'asc' },
  });
  const lensMap = new Map(lensScores.map(ls => [ls.lens_slug, ls]));

  // Fetch LensConfig names for display
  const lensConfigs = await prisma.lensConfig.findMany({
    where:  { slug: { in: allLensSlugs } },
    select: { slug: true, name: true },
  });
  const lensNameMap = new Map(lensConfigs.map(lc => [lc.slug, lc.name]));

  // Build the standard response per insight type
  const insightMap = new Map(insights.map(i => [i.type, i]));

  const result = types.map(insightType => {
    const record = insightMap.get(insightType);
    const ins    = record?.insight ?? null;
    const slugs  = INSIGHT_LENSES[insightType] ?? [];

    const lenses = slugs
      .map(slug => {
        const ls = lensMap.get(slug);
        if (!ls) return null;
        const ld = ls.lens_data ?? {};
        return {
          slug,
          name:        lensNameMap.get(slug) ?? slug,
          score:       ld.score  ?? null,
          status:      ld.status ?? null,
          takeaway:    ld.takeaway ?? null,
          key_metrics: ld.key_metrics ?? {},
          highlights:  ld.highlights  ?? [],
          risks:       ld.risks       ?? [],
          top_signals: ld.top_signals ?? [],
          z_score:     ls.z_score,
          signal_count:ls.signal_count,
          computed_at: ls.computed_at,
        };
      })
      .filter(Boolean);

    return {
      type:         insightType,
      available:    !!record,
      // Top-level scorecard fields
      score:        ins?.score        ?? null,
      verdict:      ins?.verdict      ?? null,
      verdict_band: ins?.verdict_band ?? null,
      headline:     ins?.headline     ?? null,
      subtitle:     ins?.subtitle     ?? null,
      description:  ins?.description  ?? null,
      key_signals:  ins?.key_signals  ?? [],
      // Lens breakdown (prefer the L3-synthesised lenses array; fall back to live lensScores)
      // Normalize L3 lens scores: LLM returns score 0-100, but max_score is the allocated weight.
      // Scale so score is out of max_score (e.g. score=73, max_score=22 → score=16).
      lenses:       sortLensesByConfig(
        ins?.lenses?.length > 0
          ? ins.lenses.map(l => ({
              ...l,
              score: (l.score != null && l.max_score != null)
                ? Math.round((l.score / 100) * l.max_score)
                : l.score,
            }))
          : lenses,
        insightType
      ),
      // Signal map for the signal grid
      signal_map:   ins?.signal_map   ?? [],
      // Thesis / evidence section
      thesis:       ins?.thesis       ?? null,
      evidence:     ins?.evidence     ?? [],
      watch_outs:   ins?.watch_outs   ?? [],
      analyzed_at:  record?.updated_at ?? null,
    };
  });

  return { ticker, callId, insights: result };
}

/**
 * Enqueue aiInsightSynthesis jobs for each requested type.
 *
 * @param {string}   callId
 * @param {string[]} types
 * @param {object}   opts   e.g. { forceRefresh: true }
 * @returns {Promise<object[]>}  Array of { type, jobId }
 */
async function enqueueAnalysis(callId, types, opts = {}) {
  const jobs = await Promise.all(
    types.map(async insightType => {
      const { jobId } = await enqueueAiInsightSynthesisJob(callId, insightType, opts);
      return { type: insightType, jobId };
    })
  );
  return jobs;
}

module.exports = { getAnalysis, enqueueAnalysis, INSIGHT_LENSES };
