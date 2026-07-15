'use strict';

const prisma            = require('../../config/prisma');
const { generateNudge } = require('./journal.nudge');

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_SUB_FACTORS = {
  M: ['Guidance Accuracy', 'Capital Allocation', 'Disclosure Honesty'],
  O: ['Industry Tailwind', 'Distribution Strength', 'Competitive Edge', 'TAM Expansion'],
  D: ['Valuation', 'Earnings Growth/Quality', 'P/E Re-rating Potential', 'Risk-Reward'],
};

const SUB_FACTOR_LENS = {
  'Guidance Accuracy':        'guidance-credibility',
  'Capital Allocation':       'capital-allocation',
  'Disclosure Honesty':       'disclosure-honesty',
  'Industry Tailwind':        'industry-analysis',
  'Distribution Strength':    'customer-distribution',
  'Competitive Edge':         'competition',
  'TAM Expansion':            'industry-analysis',
  'Valuation':                'target-price-matrix',
  'Earnings Growth/Quality':  'earnings-forecast',
  'P/E Re-rating Potential':  'pe-rerating-potential',
  'Risk-Reward':              'earning-quality',
};

const TYPE_TO_MOD = { management: 'M', opportunity: 'O', deal: 'D' };

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
    const slug = SUB_FACTOR_LENS[sf];
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

function pillarForSlug(slug) {
  if (slug.includes('guidance') || slug.includes('capital') || slug.includes('disclosure')) return 'mgmt';
  if (slug.includes('industry') || slug.includes('competition') || slug.includes('distribution') || slug.includes('customer')) return 'opp';
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
  TYPE_TO_MOD,
  latestCallIdForTicker,
  fetchLensScoreMap,
  buildSnapshot,
  extractModScores,
  pillarForSlug,
  evaluateHealth,
};
