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

module.exports = {
  writeSignals,
  cacheHit,
  querySignals,
  invalidateBySourceHash,
  invalidateByPromptVersion,
  invalidateByCallId,
  getSignalLineage,
};
