'use strict';

/**
 * Lens JSON Completeness Validation Service
 *
 * Exact port of validateLens/validate_lenses.py logic for validating
 * whether extracted JSON from L2 incremental skills contains majority
 * of expected information.
 */

const EXPECTED_KEYS = {
  'Capital Allocation': [
    'asset_name', 'overall_rating', 'score_badge', 'headline',
    'pattern_intelligence', 'analysis', 'watchpoints', 'key_message'
  ],
  'Promoter Activity': [
    'asset_name', 'overall_rating', 'score', 'score_badge', 'headline',
    'narrative', 'key_behaviours', 'key_message', 'keymsg', 'timeline'
  ],
  'Guidance Credibility': [
    'asset_name', 'overall_rating', 'score_badge', 'headline',
    'narrative', 'credibility_timeline', 'watchpoints', 'guidance_timeline', 'split'
  ],
  'Disclosure Honesty': [
    'asset_name', 'overall_rating', 'score', 'score_badge', 'headline',
    'communication_analysis', 'qc_intuition', 'watchpoints', 'key_message'
  ],
  'Industry Analysis': [
    'asset_name', 'overall_sentiment', 'score', 'headline', 'dynamics',
    'narrative', 'dimensions', 'positioning', 'outlook', 'synthesis', 'timeline'
  ],
  'Customer Distribution': [
    'asset_name', 'overall_rating', 'score_badge', 'customer_traction',
    'qci', 'ai_summary', 'period'
  ],
  'Competition': [
    'asset_name', 'overall_rating', 'score_badge', 'headline',
    'competitive_landscape', 'narrative', 'key_message', 'watch'
  ],
  'Financial Strength': [
    'asset_name', 'overall_rating', 'score', 'lens_label', 'headline',
    'components', 'factors', 'structural_challenge', 'qci', 'synthesis', 'watch'
  ],
  'Earnings Quality': [
    'asset_name', 'overall_quality', 'score_badge', 'headline',
    'earnings_patterns', 'quality_pillars', 'pe_path', 'scenario_table',
    'probability_fan', 'gatekeepers', 'key_message'
  ],
  'Earnings Forecast': [
    'asset_name', 'score_badge', 'primary_scenario', 'scenarios',
    'margin_chart', 'patterns', 'assumption_table', 'key_message', 'earnings_chart'
  ],
};

const SLUG_TO_NAME = {
  'capital-allocation': 'Capital Allocation',
  'customer-distribution': 'Customer Distribution',
  'competition': 'Competition',
  'disclosure-honesty': 'Disclosure Honesty',
  'guidance-credibility': 'Guidance Credibility',
  'earning-quality': 'Earnings Quality',
  'earnings-forecast': 'Earnings Forecast',
  'financial-strength': 'Financial Strength',
  'promoter-activity': 'Promoter Activity',
  'industry-analysis': 'Industry Analysis',
};

/**
 * Normalizes and parses JSON input if it is a string.
 */
function parseExtractedJson(value) {
  if (value && typeof value === 'object') {
    return Array.isArray(value) ? {} : value;
  }
  if (!value || typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'nan' || trimmed.toLowerCase() === 'null') {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    // Attempt fallback cleanup if string has wrapped quotes
    try {
      if ((trimmed.startsWith('"{') && trimmed.endsWith('}"')) || (trimmed.startsWith("'{") && trimmed.endsWith("'}") )) {
        const unescaped = trimmed.slice(1, -1).replace(/\\"/g, '"');
        const parsed = JSON.parse(unescaped);
        return (parsed && typeof parsed === 'object') ? parsed : {};
      }
    } catch (_) {}
    return {};
  }
}

/**
 * Recursively collects all keys present anywhere inside a JSON object or array.
 */
function collectNestedKeys(obj, keys = new Set()) {
  if (!obj || typeof obj !== 'object') return keys;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectNestedKeys(item, keys);
    }
  } else {
    for (const [k, v] of Object.entries(obj)) {
      keys.add(k);
      collectNestedKeys(v, keys);
    }
  }
  return keys;
}

/**
 * Returns set of normalized variants/aliases for an expected key.
 */
function keyVariants(key) {
  const base = String(key).toLowerCase().replace(/_/g, '').replace(/-/g, '');
  const variants = new Set([base]);

  if (base === 'score' || base === 'scorebadge') {
    variants.add('score');
    variants.add('scorebadge');
  }
  if (base === 'keymsg' || base === 'keymessage') {
    variants.add('keymsg');
    variants.add('keymessage');
    variants.add('key_message');
  }
  if (base === 'overallrating') {
    variants.add('overallrating');
    variants.add('overall_rating');
  }
  if (base === 'headline') {
    variants.add('headline');
    variants.add('headlines');
  }
  if (base === 'narrative') {
    variants.add('narrative');
    variants.add('analysis');
  }

  const normalized = new Set();
  for (const v of variants) {
    normalized.add(v.toLowerCase().replace(/_/g, '').replace(/-/g, ''));
  }
  return normalized;
}

/**
 * Checks if the actual keys contain the expected key (or any recognized alias).
 */
function hasExpectedKey(actualKeys, expectedKey) {
  const normalizedActual = new Set(
    Array.from(actualKeys).map(k => String(k).toLowerCase().replace(/_/g, '').replace(/-/g, ''))
  );
  const expectedNorm = String(expectedKey).toLowerCase().replace(/_/g, '').replace(/-/g, '');
  if (normalizedActual.has(expectedNorm)) {
    return true;
  }
  const aliases = keyVariants(expectedKey);
  for (const alias of aliases) {
    if (normalizedActual.has(alias)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates extracted JSON against the lens's expected keys.
 * Returns { is_complete, missing_keys, completeness_score, expected_keys, actual_keys }
 */
function validateLensJsonCompleteness(skillSlug, jsonValue) {
  const lensName = SLUG_TO_NAME[skillSlug];
  if (!lensName || !EXPECTED_KEYS[lensName]) {
    // If not one of the standard 10 lenses, default to valid if parsed is non-empty object
    const parsed = parseExtractedJson(jsonValue);
    const hasKeys = Object.keys(parsed).length > 0;
    return {
      is_complete: hasKeys,
      missing_keys: [],
      completeness_score: hasKeys ? 1.0 : 0.0,
      expected_keys: [],
      actual_keys: Array.from(collectNestedKeys(parsed)),
    };
  }

  const expectedKeys = EXPECTED_KEYS[lensName];
  const parsed = parseExtractedJson(jsonValue);

  if (!parsed || Object.keys(parsed).length === 0) {
    return {
      is_complete: false,
      missing_keys: [...expectedKeys],
      completeness_score: 0.0,
      expected_keys: expectedKeys,
      actual_keys: [],
    };
  }

  const actualKeysSet = collectNestedKeys(parsed);
  const missingKeys = expectedKeys.filter(key => !hasExpectedKey(actualKeysSet, key));
  const presentCount = expectedKeys.length - missingKeys.length;
  const completenessScore = Number((presentCount / expectedKeys.length).toFixed(4));

  // Exact tolerance from validate_lenses.py: Allow up to 1 missing expected key
  const isComplete = missingKeys.length <= 1;

  return {
    is_complete: isComplete,
    missing_keys: missingKeys,
    completeness_score: completenessScore,
    expected_keys: expectedKeys,
    actual_keys: Array.from(actualKeysSet),
  };
}

module.exports = {
  EXPECTED_KEYS,
  SLUG_TO_NAME,
  parseExtractedJson,
  collectNestedKeys,
  keyVariants,
  hasExpectedKey,
  validateLensJsonCompleteness,
};
