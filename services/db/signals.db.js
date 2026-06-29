'use strict';

const prisma = require('../../config/prisma');

/**
 * Bulk-write extracted signals to the Signal Store.
 * Uses skipDuplicates to make writes idempotent — the unique key is
 * (call_id, signal_type, metric, source_hash, prompt_v).
 *
 * @param {string} lineageId  UUID grouping all signals from one extraction run
 * @param {object[]} signals  Array of ExtractedSignal field objects (without id/lineage_id)
 * @returns {Promise<number>}  Count of rows written (0 if all were duplicates)
 */
async function writeSignals(lineageId, signals) {
  if (!signals || signals.length === 0) return 0;
  const data = signals.map(s => ({ ...s, lineage_id: lineageId }));
  const result = await prisma.extractedSignal.createMany({ data, skipDuplicates: true });
  return result.count;
}

/**
 * Check whether valid (non-invalidated) signals already exist for this exact
 * source document version and prompt version. Workers call this before the LLM
 * to skip re-extraction on cache hit.
 *
 * @param {string}   callId
 * @param {string}   sourceHash  SHA-256 of source document content
 * @param {string}   promptV     Skill version string (skillSlug@updatedAt)
 * @param {string[]} signalTypes Signal types to check for (e.g. ['kpi', 'governance'])
 * @returns {Promise<boolean>}
 */
async function cacheHit(callId, sourceHash, promptV, signalTypes) {
  // Require every requested signal type to have at least one valid signal.
  // Avoids a partial-write (e.g. kpi exists but governance missing) being treated as a full hit.
  const counts = await Promise.all(
    signalTypes.map(st =>
      prisma.extractedSignal.count({
        where: { call_id: callId, source_hash: sourceHash, prompt_v: promptV, signal_type: st, is_invalidated: false },
      })
    )
  );
  return counts.every(c => c > 0);
}

/**
 * Query signals from the Signal Store with flexible filtering.
 * Always excludes invalidated signals unless includeInvalidated is set.
 *
 * @param {object} filters
 * @param {string}   [filters.callId]
 * @param {string}   [filters.ticker]
 * @param {string}   [filters.excludeCallId]         Exclude a specific call_id (used for historical queries)
 * @param {string|string[]} [filters.signal_types]  Array of signal_type values (preferred)
 * @param {string[]} [filters.signalTypes]           Alias for signal_types (backward compat)
 * @param {string|string[]} [filters.metric_family]  Single value or array (preferred)
 * @param {string}   [filters.metricFamily]          Alias for metric_family (backward compat)
 * @param {string[]} [filters.sourceTypes]           Filter by source_type enum values
 * @param {string}   [filters.promptV]               Filter by exact prompt version
 * @param {boolean}  [filters.includeInvalidated]    Include is_invalidated=true rows
 * @returns {Promise<object[]>}  Flat array of ExtractedSignal rows
 */
async function querySignals(filters = {}) {
  const where = {};

  if (filters.callId) where.call_id = filters.callId;
  if (filters.ticker) where.ticker  = filters.ticker;
  if (filters.excludeCallId) where.call_id = { not: filters.excludeCallId };
  if (filters.promptV) where.prompt_v = filters.promptV;

  // signal_type filter — accept signal_types array (new) or signalTypes (old)
  const signalTypeArr = filters.signal_types ?? filters.signalTypes;
  if (signalTypeArr && signalTypeArr.length > 0) {
    where.signal_type = { in: signalTypeArr };
  }

  // metric_family filter — accept array (new) or single string (old)
  const mf = filters.metric_family ?? filters.metricFamily;
  if (mf) {
    where.metric_family = Array.isArray(mf) ? { in: mf } : mf;
  }

  if (filters.sourceTypes && filters.sourceTypes.length > 0) {
    where.source_type = { in: filters.sourceTypes };
  }
  if (!filters.includeInvalidated) {
    where.is_invalidated = false;
  }

  return prisma.extractedSignal.findMany({
    where,
    orderBy: [{ call_date: 'desc' }, { created_at: 'desc' }],
  });
}

/**
 * Soft-delete all signals matching a source document hash.
 * Called when a source document (transcript/PPT) is re-uploaded with new content.
 *
 * @param {string} sourceHash
 * @returns {Promise<number>}  Count of rows invalidated
 */
async function invalidateBySourceHash(sourceHash) {
  const result = await prisma.extractedSignal.updateMany({
    where: { source_hash: sourceHash, is_invalidated: false },
    data:  { is_invalidated: true },
  });
  return result.count;
}

/**
 * Soft-delete all signals matching a prompt version string.
 * Called when a Skill's promptTemplate is updated in the DB.
 *
 * @param {string} promptV  e.g. "summarization@2026-05-10T10:00:00.000Z"
 * @returns {Promise<number>}
 */
async function invalidateByPromptVersion(promptV) {
  const result = await prisma.extractedSignal.updateMany({
    where: { prompt_v: promptV, is_invalidated: false },
    data:  { is_invalidated: true },
  });
  return result.count;
}

/**
 * Targeted invalidation for a specific call + signal types.
 * Used when selectively re-running one section of the pipeline.
 *
 * @param {string}   callId
 * @param {string[]} signalTypes
 * @returns {Promise<number>}
 */
async function invalidateByCallId(callId, signalTypes) {
  const where = { call_id: callId, is_invalidated: false };
  if (signalTypes && signalTypes.length > 0) {
    where.signal_type = { in: signalTypes };
  }
  const result = await prisma.extractedSignal.updateMany({ where, data: { is_invalidated: true } });
  return result.count;
}

/**
 * Fetch all signals from a single extraction run for audit/debugging.
 *
 * @param {string} lineageId
 * @returns {Promise<object[]>}
 */
async function getSignalLineage(lineageId) {
  return prisma.extractedSignal.findMany({
    where:   { lineage_id: lineageId },
    orderBy: { created_at: 'asc' },
  });
}

// ─── V2 signal query ──────────────────────────────────────────────────────────
// Maps TranscriptSignalV2 rows into the flat shape lensComposer.js expects.
// V2 stores all numeric values inside data.measures[]; we promote the primary
// measure (first whose value is non-null) to top-level value/raw_value/unit.
// metric_family comes from data.details.metric_family (kpi signals) or is
// inferred from the signal_type mapping below.

const V2_TYPE_TO_METRIC_FAMILY = {
  kpi:                   null,         // comes from data.details.metric_family
  guidance:              'growth',
  guidance_revision:     'growth',
  growth_forecast:       'growth',
  milestone:             'milestone',
  ongoing:               'milestone',
  industry_signal:       'industry',
  capital_allocation:    'capital',
  disclosure_quality:    'governance',
  governance_signal:     'governance',
  financial_figure:      'governance',
  m_and_a:               'capital',
  risk_factor:           'governance',
  contingent_liability:  'governance',
  strategic_claim:       'management',
  mgmt_tone:             'management',
  analyst_questions:     'management',
  distribution_customer: 'customer',
  earnings_quality:      'profitability',
  competitive_position:  'industry',
  pricing_power:         'industry',
};

// Primary measure role by signal type — what value to promote to top-level
const V2_PRIMARY_ROLE = {
  guidance:              ['guided', 'growth_rate', 'absolute_target', 'value'],
  guidance_revision:     ['revised', 'value'],
  growth_forecast:       ['growth_rate', 'absolute_target', 'value'],
  kpi:                   ['reported', 'current', 'value'],
  milestone:             ['milestone', 'value'],
  ongoing:               ['value', 'quantum'],
  industry_signal:       ['value'],
  capital_allocation:    ['quantum', 'value'],
  earnings_quality:      ['current', 'value'],
  distribution_customer: ['scale', 'value'],
  competitive_position:  ['value'],
  pricing_power:         ['pass_through', 'value'],
};

function pickPrimaryMeasure(data, signalType) {
  const measures = data?.measures;
  if (!Array.isArray(measures) || measures.length === 0) return null;
  const rolePriority = V2_PRIMARY_ROLE[signalType] ?? ['value'];
  for (const role of rolePriority) {
    const m = measures.find(m => m.role === role && m.value != null);
    if (m) return m;
  }
  // Fall back to any measure with a numeric value
  return measures.find(m => m.value != null) ?? null;
}

function shapeV2Signal(row) {
  const data        = row.data ?? {};
  const measures    = Array.isArray(data.measures) ? data.measures : [];
  const primary     = pickPrimaryMeasure(data, row.signal_type);
  const metricFamily = row.signal_type === 'kpi'
    ? (data.details?.metric_family ?? null)
    : (V2_TYPE_TO_METRIC_FAMILY[row.signal_type] ?? null);

  // Resolve period dates from the primary measure's period or from guidance details
  const period     = primary?.period ?? data.details?.period ?? {};
  const startDate  = period.start ?? data.details?.start_date ?? null;
  const endDate    = period.end   ?? data.details?.end_date   ?? data.details?.target_date ?? null;
  const periodType = period.type  ?? null;
  const timeHorizon = data.details?.time_horizon ?? data.horizon ?? null;

  return {
    // identity
    id:            row.id,
    call_id:       row.call_id,
    ticker:        row.ticker,
    fiscal_year:   row.fiscal_year,
    quarter:       row.quarter,
    call_date:     row.call_date,
    // signal classification
    signal_type:   row.signal_type,
    metric:        row.metric,
    metric_family: metricFamily,
    impact:        row.impact,
    severity:      row.severity,
    // promoted numeric fields
    value:         primary?.value   ?? null,
    raw_value:     primary?.value_raw ?? (primary?.value != null ? String(primary.value) : null),
    unit:          primary?.unit    ?? null,
    multiplier:    primary?.multiplier ?? 1,
    // provenance (mapped from V2 cols)
    source_type:   row.source_doc_type ?? 'transcript', // "transcript"|"ppt"|"annual_report"
    source_doc_type: row.source_doc_type ?? null,
    source_context:  row.source_context ?? null,
    // date range
    start_date:    startDate,
    end_date:      endDate,
    period_type:   periodType,
    time_horizon:  timeHorizon,
    // text
    statement:     row.statement,
    // scoring defaults (V2 has no w/b/confidence columns — use safe defaults)
    w:             1.0,
    b:             0.0,
    confidence:    0.7,
    // raw V2 payload (kept for debugging / prompt context)
    data:          data,
    measures:      measures,
  };
}

/**
 * Query signals from the V2 Signal Store (TranscriptSignalV2) with flexible filtering.
 * Returns rows shaped to match the flat format that lensComposer.js expects
 * (same fields as ExtractedSignal: value, raw_value, unit, metric_family, source_type, etc.).
 *
 * @param {object} filters
 * @param {string}   [filters.callId]
 * @param {string}   [filters.ticker]
 * @param {string}   [filters.excludeCallId]
 * @param {string[]} [filters.signal_types]   Array of V2 signal_type values
 * @param {string[]} [filters.signalTypes]    Alias for signal_types (backward compat)
 * @param {string|string[]} [filters.metric_family]  Filter by metric_family (derived on read)
 * @param {string[]} [filters.source_doc_types]      Filter by source_doc_type ("transcript"|"ppt"|"annual_report")
 * @param {boolean}  [filters.includeInvalidated]
 * @returns {Promise<object[]>}
 */
async function querySignalsV2(filters = {}) {
  const where = {};

  if (filters.callId)        where.call_id = filters.callId;
  if (filters.ticker)        where.ticker  = filters.ticker;
  if (filters.excludeCallId) where.call_id = { not: filters.excludeCallId };

  const signalTypeArr = filters.signal_types ?? filters.signalTypes;
  if (signalTypeArr && signalTypeArr.length > 0) {
    where.signal_type = { in: signalTypeArr };
  }

  if (filters.source_doc_types && filters.source_doc_types.length > 0) {
    where.source_doc_type = { in: filters.source_doc_types };
  }

  if (!filters.includeInvalidated) {
    where.is_invalidated = false;
  }

  const rows = await prisma.transcriptSignalV2.findMany({
    where,
    orderBy: [{ call_date: 'desc' }, { created_at: 'desc' }],
  });

  const shaped = rows.map(shapeV2Signal);

  return shaped;
}

module.exports = {
  writeSignals,
  cacheHit,
  querySignals,
  querySignalsV2,
  shapeV2Signal,
  invalidateBySourceHash,
  invalidateByPromptVersion,
  invalidateByCallId,
  getSignalLineage,
};
