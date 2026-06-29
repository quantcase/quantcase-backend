'use strict';

const prisma             = require('../../config/prisma');
const { enrichHoldings } = require('../portfolio/market-data.service');
const { generateNudge }  = require('./journal.nudge');

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

const DEFAULT_PROMPTS = [
  'Buying for long-term value creation...',
  'Strong fundamentals with improving outlook...',
  'Valuation provides margin of safety...',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notFound(msg, code) {
  const e = new Error(msg);
  e.status = 404;
  e.code   = code;
  return e;
}

function badRequest(msg, code) {
  const e = new Error(msg);
  e.status = 400;
  e.code   = code;
  return e;
}

function assertPortfolioType(pt) {
  if (pt !== 'user' && pt !== 'shadow') {
    throw badRequest('portfolioType must be "user" or "shadow"', 'INVALID_PORTFOLIO_TYPE');
  }
}

/**
 * Fetch holdings from both portfolios for a user.
 * Returns { user: Holding[], shadow: Holding[] }
 */
async function fetchAllHoldings(userId) {
  const [userPort, shadowPort] = await Promise.all([
    prisma.userPortfolio.findUnique({
      where:   { user_id: userId },
      include: { holdings: true },
    }),
    prisma.shadowPortfolio.findUnique({
      where:   { user_id: userId },
      include: { holdings: true },
    }),
  ]);
  return {
    user:   userPort?.holdings   ?? [],
    shadow: shadowPort?.holdings ?? [],
  };
}

/**
 * Verify a ticker exists in the specified portfolio type for a user.
 */
async function assertHoldingInPortfolio(userId, ticker, portfolioType) {
  const upper = ticker.toUpperCase();
  if (portfolioType === 'user') {
    const port = await prisma.userPortfolio.findUnique({
      where:   { user_id: userId },
      include: { holdings: { where: { ticker: upper } } },
    });
    if (!port || port.holdings.length === 0) {
      throw notFound(`${ticker} is not in your portfolio`, 'HOLDING_NOT_FOUND');
    }
  } else {
    const port = await prisma.shadowPortfolio.findUnique({
      where:   { user_id: userId },
      include: { holdings: { where: { ticker: upper } } },
    });
    if (!port || port.holdings.length === 0) {
      throw notFound(`${ticker} is not in your shadow portfolio`, 'HOLDING_NOT_FOUND');
    }
  }
}

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

function buildAiContext(insightRows) {
  const ctx = { M: null, O: null, D: null };
  for (const row of insightRows) {
    const letter = TYPE_TO_MOD[row.type];
    if (letter) ctx[letter] = row.insight?.description ?? row.insight?.thesis ?? null;
  }
  return ctx;
}

function buildSignals(insightRows) {
  const signals = [];
  for (const row of insightRows) {
    for (const s of (row.insight?.key_signals ?? [])) {
      if (s.label) {
        signals.push({
          label: s.label,
          type:  s.sentiment === 'positive' ? 'green'
                 : s.sentiment === 'negative' ? 'red'
                 : s.sentiment === 'cautious' ? 'amber'
                 : 'neutral',
        });
      }
    }
  }
  return signals;
}

function buildPrompts(insightRows) {
  const phrases = [];
  for (const row of insightRows) {
    const ins = row.insight ?? {};
    if (ins.thesis && phrases.length < 3) phrases.push(ins.thesis + '...');
    for (const ev of (ins.evidence ?? [])) {
      if (phrases.length >= 3) break;
      if (typeof ev === 'string') phrases.push(ev);
    }
  }
  while (phrases.length < 3) phrases.push(DEFAULT_PROMPTS[phrases.length]);
  return phrases.slice(0, 3);
}

function pillarForSlug(slug) {
  if (slug.includes('guidance') || slug.includes('capital') || slug.includes('disclosure')) return 'mgmt';
  if (slug.includes('industry') || slug.includes('competition') || slug.includes('distribution') || slug.includes('customer')) return 'opp';
  return 'deal';
}

// ─── Health evaluation ────────────────────────────────────────────────────────

async function evaluateHealth(journalId) {
  const entry = await prisma.investmentJournal.findUnique({
    where:   { id: journalId },
    include: { health: true },
  });
  if (!entry) throw notFound('Journal entry not found', 'ENTRY_NOT_FOUND');

  const subFactors = Array.isArray(entry.sub_factors) ? entry.sub_factors : [];
  const snapshot   = entry.scores_snapshot ?? {};

  const lensMap     = await fetchLensScoreMap(entry.ticker);
  const currentSnap = buildSnapshot(subFactors, lensMap);

  const insightRows = await prisma.aiInsight.findMany({
    where: { ticker: entry.ticker, type: { in: ['management', 'opportunity', 'deal'] } },
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
  await prisma.investmentJournalHealth.upsert({
    where:  { journal_id: journalId },
    update: { thesis_health: thesisHealth, ai_nudge: aiNudge, evaluated_at: evaluatedAt },
    create: { journal_id: journalId, thesis_health: thesisHealth, ai_nudge: aiNudge, evaluated_at: evaluatedAt },
  });

  return { thesisHealth, aiNudge, evaluatedAt };
}

// ─── Journal key helper (composite unique lookup) ─────────────────────────────

function journalKey(ticker, portfolioType) {
  return `${ticker.toUpperCase()}::${portfolioType}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * GET /api/journal/pending
 * Returns holdings from BOTH portfolios that have no thesis yet.
 * Each holding carries a portfolioType field so the UI knows which portfolio it belongs to.
 */
async function getPendingHoldings(userId) {
  const [holdings, journals] = await Promise.all([
    fetchAllHoldings(userId),
    prisma.investmentJournal.findMany({
      where:  { user_id: userId },
      select: { ticker: true, portfolio_type: true },
    }),
  ]);

  const journalKeys = new Set(journals.map(j => journalKey(j.ticker, j.portfolio_type)));

  // Tag each holding with its source, then filter out already-journaled ones
  const tagged = [
    ...holdings.user.map(h => ({ ...h, portfolioType: 'user' })),
    ...holdings.shadow.map(h => ({ ...h, portfolioType: 'shadow' })),
  ];

  const totalHoldings = tagged.length;
  const withThesis    = tagged.filter(h => journalKeys.has(journalKey(h.ticker, h.portfolioType))).length;
  const pending       = tagged.filter(h => !journalKeys.has(journalKey(h.ticker, h.portfolioType)));

  if (!pending.length) return { holdings: [], totalHoldings, withThesis, pending: 0 };

  const tickers = [...new Set(pending.map(h => h.ticker.toUpperCase()))];
  const [marketData, insightRows] = await Promise.all([
    enrichHoldings(tickers),
    prisma.aiInsight.findMany({
      where: { ticker: { in: tickers }, type: { in: ['management', 'opportunity', 'deal'] } },
    }),
  ]);

  const insightsByTicker = {};
  for (const row of insightRows) {
    const t = row.ticker.toUpperCase();
    if (!insightsByTicker[t]) insightsByTicker[t] = [];
    insightsByTicker[t].push(row);
  }

  const result = pending.map(h => {
    const sym      = h.ticker.toUpperCase();
    const md       = marketData[sym] ?? {};
    const insights = insightsByTicker[sym] ?? [];
    return {
      symbol:         sym,
      portfolioType:  h.portfolioType,
      name:           sym,
      sector:         null,
      capType:        null,
      price:          md.ltp ?? null,
      priceChange:    md.change ?? null,
      priceChangeDir: md.change != null ? (md.change >= 0 ? 'pos' : 'neg') : null,
      mod:            extractModScores(insights),
      aiContext:      buildAiContext(insights),
      signals:        buildSignals(insights),
      subFactors:     VALID_SUB_FACTORS,
      prompts:        buildPrompts(insights),
    };
  });

  return { holdings: result, totalHoldings, withThesis, pending: pending.length };
}

/**
 * GET /api/journal/entries
 * Returns all holdings from both portfolios merged with journal + health data.
 */
async function getAllEntries(userId) {
  const [holdings, journals] = await Promise.all([
    fetchAllHoldings(userId),
    prisma.investmentJournal.findMany({
      where:   { user_id: userId },
      include: { health: true },
    }),
  ]);

  // Map: "TICKER::portfolioType" -> journal row
  const journalMap = new Map(journals.map(j => [journalKey(j.ticker, j.portfolio_type), j]));

  const tagged = [
    ...holdings.user.map(h => ({ ...h, portfolioType: 'user' })),
    ...holdings.shadow.map(h => ({ ...h, portfolioType: 'shadow' })),
  ];

  const allTickers = [...new Set(tagged.map(h => h.ticker.toUpperCase()))];

  const [marketData, insightRows] = await Promise.all([
    allTickers.length ? enrichHoldings(allTickers) : Promise.resolve({}),
    allTickers.length ? prisma.aiInsight.findMany({
      where: { ticker: { in: allTickers }, type: { in: ['management', 'opportunity', 'deal'] } },
    }) : Promise.resolve([]),
  ]);

  const insightsByTicker = {};
  for (const row of insightRows) {
    const t = row.ticker.toUpperCase();
    if (!insightsByTicker[t]) insightsByTicker[t] = [];
    insightsByTicker[t].push(row);
  }

  // Lens scores for journaled tickers only
  const journaledTickers = [...new Set(journals.map(j => j.ticker.toUpperCase()))];
  const callIdResults = await Promise.all(
    journaledTickers.map(t => latestCallIdForTicker(t).then(id => ({ ticker: t, callId: id })))
  );
  const lensScoresByTicker = {};
  await Promise.all(callIdResults.map(async ({ ticker, callId }) => {
    if (!callId) return;
    const rows = await prisma.lensScore.findMany({
      where:  { call_id: callId, is_stale: false },
      select: { lens_slug: true, lens_data: true },
    });
    lensScoresByTicker[ticker] = rows;
  }));

  const summary = { intact: 0, partial: 0, broken: 0, none: 0, total: tagged.length };

  const entries = tagged.map(h => {
    const sym      = h.ticker.toUpperCase();
    const key      = journalKey(sym, h.portfolioType);
    const md       = marketData[sym] ?? {};
    const journal  = journalMap.get(key) ?? null;
    const insights = insightsByTicker[sym] ?? [];
    const modSc    = extractModScores(insights);
    const health   = journal?.health?.thesis_health ?? 'none';

    if      (health === 'intact')  summary.intact++;
    else if (health === 'partial') summary.partial++;
    else if (health === 'broken')  summary.broken++;
    else                           summary.none++;

    const lensRows  = lensScoresByTicker[sym] ?? [];
    const subScores = lensRows
      .filter(r => r.lens_data?.score != null)
      .map(r => ({
        label:  r.lens_data?.name ?? r.lens_slug,
        pillar: pillarForSlug(r.lens_slug),
        score:  Math.round(r.lens_data.score),
      }));

    const bestScore = modSc.M ?? modSc.O ?? modSc.D ?? null;
    const modScore  = bestScore != null ? Math.round(bestScore) : null;
    const modRating = modScore != null
      ? (modScore >= 80 ? 'STRONG' : modScore >= 60 ? 'FAIR' : 'STRETCHED')
      : null;

    return {
      symbol:        sym,
      portfolioType: h.portfolioType,
      name:          sym,
      sector:        null,
      capType:       null,
      modScore,
      modRating,
      trendDir:      null,
      pnl:           md.change ?? null,
      pnlPct:        md.change_percent ?? null,
      thesisHealth:  health,
      alert:         (health === 'broken' || health === 'partial') && journal?.health?.ai_nudge
                       ? journal.health.ai_nudge.slice(0, 80) + '...'
                       : null,
      subScores,
      journal: journal ? {
        entryId:    journal.id,
        dimension:  journal.dimension,
        subFactors: Array.isArray(journal.sub_factors) ? journal.sub_factors : [],
        thesis:     journal.thesis,
        conviction: journal.conviction,
        aiNudge:    journal.health?.ai_nudge ?? null,
        updatedAt:  journal.updated_at,
      } : null,
    };
  });

  return { summary, entries };
}

/**
 * POST /api/journal/entries
 * portfolioType is required in the request body.
 */
async function createEntry(userId, { symbol, portfolioType, dimension, subFactors, thesis, conviction }) {
  assertPortfolioType(portfolioType);
  await assertHoldingInPortfolio(userId, symbol, portfolioType);

  const ticker = symbol.toUpperCase();
  const lensMap = await fetchLensScoreMap(ticker);
  const scoresSnapshot = buildSnapshot(subFactors, lensMap);

  const journal = await prisma.investmentJournal.create({
    data: {
      user_id: userId, ticker, portfolio_type: portfolioType,
      dimension, sub_factors: subFactors, thesis, conviction, scores_snapshot: scoresSnapshot,
    },
  });

  const health = await evaluateHealth(journal.id);

  return {
    entryId:       journal.id,
    holdingId:     ticker,
    portfolioType,
    thesisHealth:  health.thesisHealth,
    aiNudge:       health.aiNudge,
    createdAt:     journal.created_at,
  };
}

async function updateEntry(entryId, userId, fields) {
  const existing = await prisma.investmentJournal.findUnique({ where: { id: entryId } });
  if (!existing || existing.user_id !== userId) throw notFound('Journal entry not found', 'ENTRY_NOT_FOUND');

  await prisma.investmentJournal.update({
    where: { id: entryId },
    data: {
      ...(fields.dimension  != null && { dimension:   fields.dimension }),
      ...(fields.subFactors != null && { sub_factors: fields.subFactors }),
      ...(fields.thesis     != null && { thesis:      fields.thesis }),
      ...(fields.conviction != null && { conviction:  fields.conviction }),
    },
  });

  const health = await evaluateHealth(entryId);

  return {
    entryId,
    holdingId:     existing.ticker,
    portfolioType: existing.portfolio_type,
    thesisHealth:  health.thesisHealth,
    aiNudge:       health.aiNudge,
    evaluatedAt:   health.evaluatedAt,
  };
}

async function deleteEntry(entryId, userId) {
  const existing = await prisma.investmentJournal.findUnique({ where: { id: entryId } });
  if (!existing || existing.user_id !== userId) throw notFound('Journal entry not found', 'ENTRY_NOT_FOUND');
  await prisma.investmentJournal.delete({ where: { id: entryId } });
}

/**
 * GET /api/journal/entries/:symbol?portfolioType=user|shadow
 */
async function getEntry(symbol, userId, portfolioType) {
  assertPortfolioType(portfolioType);
  const ticker  = symbol.toUpperCase();
  const journal = await prisma.investmentJournal.findUnique({
    where:   { user_id_ticker_portfolio_type: { user_id: userId, ticker, portfolio_type: portfolioType } },
    include: { health: true },
  });
  if (!journal) throw notFound(`No journal entry for ${symbol} in ${portfolioType} portfolio`, 'ENTRY_NOT_FOUND');

  const [marketData, insightRows] = await Promise.all([
    enrichHoldings([ticker]),
    prisma.aiInsight.findMany({ where: { ticker, type: { in: ['management', 'opportunity', 'deal'] } } }),
  ]);

  const md       = marketData[ticker] ?? {};
  const modSc    = extractModScores(insightRows);
  const bestSc   = modSc.M ?? modSc.O ?? modSc.D ?? null;
  const modScore = bestSc != null ? Math.round(bestSc) : null;

  return {
    symbol,
    portfolioType,
    name:         symbol,
    sector:       null,
    capType:      null,
    modScore,
    modRating:    modScore != null ? (modScore >= 80 ? 'STRONG' : modScore >= 60 ? 'FAIR' : 'STRETCHED') : null,
    trendDir:     null,
    pnl:          md.change ?? null,
    pnlPct:       md.change_percent ?? null,
    thesisHealth: journal.health?.thesis_health ?? 'none',
    alert:        null,
    subScores:    [],
    journal: {
      entryId:    journal.id,
      dimension:  journal.dimension,
      subFactors: Array.isArray(journal.sub_factors) ? journal.sub_factors : [],
      thesis:     journal.thesis,
      conviction: journal.conviction,
      aiNudge:    journal.health?.ai_nudge ?? null,
      updatedAt:  journal.updated_at,
    },
  };
}

async function triggerEvaluate(entryId, userId) {
  const existing = await prisma.investmentJournal.findUnique({ where: { id: entryId } });
  if (!existing || existing.user_id !== userId) throw notFound('Journal entry not found', 'ENTRY_NOT_FOUND');
  return evaluateHealth(entryId);
}

module.exports = {
  getPendingHoldings,
  getAllEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  getEntry,
  triggerEvaluate,
  VALID_SUB_FACTORS,
};
