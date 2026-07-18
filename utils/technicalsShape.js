'use strict';

/**
 * Expand the compact LLM output into the shape the frontend consumes.
 *
 * The output schema sent to the model is deliberately flat: nested objects are flattened
 * into scalars, repeated shapes are collapsed into a single array item definition, and
 * indicator name/tab are replaced by a short `id`. That keeps the compiled grammar small
 * enough for the provider to accept — a nested version was rejected with
 * "The compiled grammar is too large".
 *
 * Everything removed from the grammar is reconstructed here, so the persisted insight keeps
 * the full documented shape (decisionIntelligence.indicators[].name/tab, currentRegime{},
 * idealForScores{}, levelsToWatch{}, ruleEngine.tabSummaries{}, and the three
 * actionableInsight* siblings).
 */

/** id -> { name, tab } for the eight indicator buckets. */
const INDICATOR_META = {
  market_structure:      { name: 'Market Structure',      tab: 'Structure' },
  capital_participation: { name: 'Capital Participation', tab: 'Structure' },
  price_architecture:    { name: 'Price Architecture',    tab: 'Structure' },
  trend_direction:       { name: 'Trend Direction',       tab: 'Trend' },
  trend_quality:         { name: 'Trend Quality',         tab: 'Trend' },
  momentum:              { name: 'Momentum',              tab: 'Timing' },
  volatility:            { name: 'Volatility',            tab: 'Timing' },
  relative_strength:     { name: 'Relative Strength',     tab: 'Relative Strength' },
};

const LEVEL_LABELS = {
  immediate:  'Short term support',
  structural: 'Key support',
  regime:     'Long term average',
};

/**
 * @param {object} raw       parsed LLM JSON (compact shape)
 * @param {object} taResult  full technicalAnalysis.analyze() result
 * @param {number|null} previousScore
 * @returns {object} insight in the documented shape
 */
function expandTechnicalsInsight(raw, taResult, previousScore = null) {
  const di = { ...(raw?.decisionIntelligence ?? {}) };

  // indicators: derive name + tab from id
  if (Array.isArray(di.indicators)) {
    di.indicators = di.indicators.map((ind) => {
      const meta = INDICATOR_META[ind?.id] ?? {};
      return {
        id:             ind?.id ?? null,
        name:           meta.name ?? ind?.name ?? null,
        tab:            meta.tab  ?? ind?.tab  ?? null,
        tag:            ind?.tag ?? null,
        sentiment:      ind?.sentiment ?? null,
        explanation:    ind?.explanation ?? null,
        growthWatchout: ind?.growthWatchout ?? null,
        valueWatchout:  ind?.valueWatchout ?? null,
      };
    });
  }

  // levelsToWatch: array -> keyed object (keep the array too; both are cheap)
  if (Array.isArray(di.levelsToWatch)) {
    const byType = {};
    di.levelsToWatch.forEach((l) => {
      if (!l?.type) return;
      byType[l.type] = { price: l.price ?? null, label: l.label ?? LEVEL_LABELS[l.type] ?? null };
    });
    di.levelsToWatch = {
      immediate:   byType.immediate  ?? { price: null, label: LEVEL_LABELS.immediate },
      structural:  byType.structural ?? { price: null, label: LEVEL_LABELS.structural },
      regime:      byType.regime     ?? { price: null, label: LEVEL_LABELS.regime },
      horizonNote: di.horizonNote ?? null,
    };
  }
  delete di.horizonNote;

  // actionableInsights[] -> the three documented sibling objects
  if (Array.isArray(di.actionableInsights)) {
    const pick = (h) => {
      const m = di.actionableInsights.find((a) => a?.horizon === h);
      return m
        ? { new_position: m.new_position ?? null, existing_position: m.existing_position ?? null, watch_for: m.watch_for ?? null }
        : null;
    };
    di.actionableInsight            = pick('swing');
    di.actionableInsight_positional = pick('positional');
    di.actionableInsight_investor   = pick('investor');
    delete di.actionableInsights;
  }

  // Re-nest the flattened scalars
  di.currentRegime = {
    label:       di.currentRegimeLabel ?? null,
    description: di.currentRegimeDescription ?? null,
  };
  delete di.currentRegimeLabel;
  delete di.currentRegimeDescription;

  di.idealForScores = {
    swing:      di.swingScore ?? null,
    positional: di.positionalScore ?? null,
    investor:   di.investorScore ?? null,
  };
  delete di.swingScore;
  delete di.positionalScore;
  delete di.investorScore;

  di.ruleEngine = {
    tabSummaries: {
      structure:        di.structureSummary ?? null,
      trend:            di.trendSummary ?? null,
      timing:           di.timingSummary ?? null,
      relativeStrength: di.relativeStrengthSummary ?? null,
    },
  };
  delete di.structureSummary;
  delete di.trendSummary;
  delete di.timingSummary;
  delete di.relativeStrengthSummary;

  di.breakoutQuality = di.breakoutQuality ?? null;
  di.directionFlag   = di.directionFlag ?? null;
  di.previousScore   = di.previousScore ?? previousScore ?? null;

  return {
    decisionIntelligence: di,
    // Sourced from the TA result rather than the model: these are verbatim echoes of
    // inputs already computed upstream, so asking the model to retype them cost grammar
    // budget and risked transcription drift.
    ruleEngine: taResult?.ruleEngine ?? null,
    scores: raw?.scores ?? null,
    stockClassification: raw?.stockClassification ?? null,
  };
}

module.exports = { expandTechnicalsInsight, INDICATOR_META };
