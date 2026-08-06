'use strict';

const prisma            = require('../../config/prisma');
const { generateNudge } = require('./journal.nudge');
const { INSIGHT_LENSES } = require('../../lib/insightLenses');

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_TO_MOD = { management: 'M', opportunity: 'O', deal: 'D' };

// Display names for the canonical lens slugs — these are the exact labels the
// MOD sub-factor picker shows, so a sub-factor IS a lens (1:1), not a bespoke
// journal-only vocabulary. Keep in sync with prisma/seedHtmlSkills.js.
const LENS_DISPLAY_NAME = {
  'guidance-credibility':   'Guidance Credibility',
  'disclosure-honesty':     'Disclosure Honesty',
  'capital-allocation':     'Capital Allocation',
  'promoter-activity':      'Promoter Activity',
  'industry-analysis':      'Industry Analysis',
  'competition':            'Competition',
  'financial-strength':     'Financial Strength',
  'customer-distribution':  'Customer Distribution',
  'earnings-forecast':      'Earnings Forecast',
  'earning-quality':        'Earning Quality',
  'pe-rerating-potential':  'PE Rerating Potential',
  'target-price-matrix':    'Target Price Matrix',
};

// M/O/D → valid sub-factor labels, derived from the lens registry so the two
// can never drift apart again.
const VALID_SUB_FACTORS = Object.fromEntries(
  Object.entries(INSIGHT_LENSES).map(([type, slugs]) => [
    TYPE_TO_MOD[type],
    slugs.map(slug => LENS_DISPLAY_NAME[slug]).filter(Boolean),
  ]),
);

const SUB_FACTOR_LENS = Object.fromEntries(
  Object.entries(LENS_DISPLAY_NAME).map(([slug, name]) => [name, slug]),
);

// Labels used by earlier journal entries (and alternate lens-config spellings),
// kept so existing rows still resolve to a lens when their health is evaluated.
// Not offered as valid input — see ALL_SUB_FACTORS in routes/journal.routes.js.
const LEGACY_SUB_FACTOR_LENS = {
  'Guidance Accuracy':          'guidance-credibility',
  'Industry Tailwind':          'industry-analysis',
  'Distribution Strength':      'customer-distribution',
  'Competitive Edge':           'competition',
  'TAM Expansion':              'industry-analysis',
  'Valuation':                  'target-price-matrix',
  'Earnings Growth/Quality':    'earnings-forecast',
  'P/E Re-rating Potential':    'pe-rerating-potential',
  'P/E Re-Rating Potential':    'pe-rerating-potential',
  'Risk-Reward':                'earning-quality',
  'Capital Allocation Quality': 'capital-allocation',
  'Customer & Distribution':    'customer-distribution',
};

// Accepts a display name (case-insensitive), a legacy label, or a raw lens slug.
const SUB_FACTOR_LOOKUP = new Map(
  [
    ...Object.entries(SUB_FACTOR_LENS),
    ...Object.entries(LEGACY_SUB_FACTOR_LENS),
    ...Object.keys(LENS_DISPLAY_NAME).map(slug => [slug, slug]),
  ].map(([label, slug]) => [label.toLowerCase(), slug]),
);

function resolveSubFactorSlug(value) {
  return typeof value === 'string'
    ? (SUB_FACTOR_LOOKUP.get(value.trim().toLowerCase()) ?? null)
    : null;
}

// ─── Lens-score snapshotting ──────────────────────────────────────────────────

async function latestCallIdForTicker(ticker) {
  const row = await prisma.lensScore.findFirst({
    where:   { ticker },
    select:  { call_id: true },
    orderBy: { call_id: 'desc' },
  });
  return row?.call_id ?? null;
}

async function fetchLensScoreMap(ticker) {
  const callId = await latestCallIdForTicker(ticker);
  if (!callId) return {};
  const rows = await prisma.lensScore.findMany({
    where:  { call_id: callId, is_stale: false },
    select: { lens_slug: true, lens_data: true },
  });
  const map = {};
  for (const row of rows) map[row.lens_slug] = row.lens_data?.score ?? null;
  return map;
}

function buildSnapshot(subFactors, lensMap) {
  const snap = {};
  for (const sf of subFactors) {
    const slug = resolveSubFactorSlug(sf);
    snap[sf] = slug ? (lensMap[slug] ?? null) : null;
  }
  return snap;
}

function extractModScores(insightRows) {
  const result = { M: null, O: null, D: null };
  for (const row of insightRows) {
    const letter = TYPE_TO_MOD[row.type];
    if (letter) result[letter] = row.insight?.score ?? null;
  }
  return result;
}

const SLUG_PILLAR = { management: 'mgmt', opportunity: 'opp', deal: 'deal' };

function pillarForSlug(slug) {
  for (const [type, slugs] of Object.entries(INSIGHT_LENSES)) {
    if (slugs.includes(slug)) return SLUG_PILLAR[type];
  }
  return 'deal';
}

// ─── Health evaluation ────────────────────────────────────────────────────────

/**
 * Evaluate the thesis health of a single JournalEntry (thesis-typed only).
 * Recomputes the current lens snapshot, measures the biggest drop against the
 * snapshot taken at entry creation, classifies intact|partial|broken, and
 * (on partial/broken) generates an AI nudge. Upserts JournalEntryHealth.
 *
 * @param {string} entryId
 * @returns {Promise<{ thesisHealth: string, aiNudge: string|null, evaluatedAt: Date }>}
 */
async function evaluateHealth(entryId) {
  const entry = await prisma.journalEntry.findUnique({
    where:   { id: entryId },
    include: { health: true, journal_ticker: true },
  });
  if (!entry) {
    const e = new Error('Journal entry not found');
    e.status = 404;
    e.code   = 'ENTRY_NOT_FOUND';
    throw e;
  }

  // Only thesis-typed entries carry a dimension; plain notes have no health.
  if (!entry.dimension) return { thesisHealth: 'none', aiNudge: null, evaluatedAt: null };

  const ticker     = entry.journal_ticker.ticker;
  const subFactors = Array.isArray(entry.sub_factors) ? entry.sub_factors : [];
  const snapshot   = entry.scores_snapshot ?? {};

  const lensMap     = await fetchLensScoreMap(ticker);
  const currentSnap = buildSnapshot(subFactors, lensMap);

  const insightRows = await prisma.aiInsight.findMany({
    where: { ticker, type: { in: ['management', 'opportunity', 'deal'] } },
  });
  const modScores = extractModScores(insightRows);

  let maxDrop = 0, worstFactor = null, worstPrev = null, worstCurr = null;
  for (const sf of subFactors) {
    const prev = snapshot[sf];
    const curr = currentSnap[sf];
    if (prev == null || curr == null) continue;
    const drop = prev - curr;
    if (drop > maxDrop) {
      maxDrop = drop; worstFactor = sf; worstPrev = prev; worstCurr = curr;
    }
  }

  const thesisHealth = maxDrop > 15 ? 'broken' : maxDrop > 5 ? 'partial' : 'intact';

  let aiNudge = null;
  if ((thesisHealth === 'partial' || thesisHealth === 'broken') && worstFactor) {
    try {
      aiNudge = await generateNudge({
        thesis: entry.thesis, dimension: entry.dimension, subFactors,
        changedFactor: worstFactor,
        prevScore: Math.round(worstPrev), currScore: Math.round(worstCurr),
        modScores,
      });
    } catch (err) {
      console.error('[evaluateHealth] nudge generation failed:', err.message);
    }
  }

  const evaluatedAt = new Date();
  await prisma.journalEntryHealth.upsert({
    where:  { entry_id: entryId },
    update: { thesis_health: thesisHealth, ai_nudge: aiNudge, evaluated_at: evaluatedAt },
    create: { entry_id: entryId, thesis_health: thesisHealth, ai_nudge: aiNudge, evaluated_at: evaluatedAt },
  });

  return { thesisHealth, aiNudge, evaluatedAt };
}

module.exports = {
  VALID_SUB_FACTORS,
  SUB_FACTOR_LENS,
  LENS_DISPLAY_NAME,
  resolveSubFactorSlug,
  TYPE_TO_MOD,
  latestCallIdForTicker,
  fetchLensScoreMap,
  buildSnapshot,
  extractModScores,
  pillarForSlug,
  evaluateHealth,
};
