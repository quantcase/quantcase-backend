'use strict';

const prisma = require('../../config/prisma');

// Doc-type-parametrized replacements for the script's hasV2Signals/hasPptSignals/hasArSignals
// and invalidateV2Signals/invalidatePptSignals/invalidateArSignals trios.

async function hasSignals(callId, docType) {
  const count = await prisma.transcriptSignalV2.count({
    where: { call_id: String(callId), is_invalidated: false, source_doc_type: docType },
  });
  return count > 0;
}

async function invalidateSignals(callId, docType) {
  const result = await prisma.transcriptSignalV2.updateMany({
    where: { call_id: String(callId), is_invalidated: false, source_doc_type: docType },
    data:  { is_invalidated: true },
  });
  return result.count;
}

async function fetchActiveCallIds(types, scopeCallIds) {
  const where = { type: { in: types }, status: { in: ['pending', 'processing'] } };
  if (scopeCallIds !== null) where.callId = { in: scopeCallIds };
  const rows = await prisma.job.findMany({ where, select: { callId: true } });
  return new Set(rows.map(r => r.callId));
}

async function fetchDoneCallIds(docType, scopeCallIds) {
  // Unscoped case: no candidate list to correlate against, so there's no way
  // around enumerating every distinct call_id matching this doc type. No
  // current caller actually hits this (they all pass a real array), kept for
  // API completeness.
  if (scopeCallIds === null) {
    const rows = await prisma.transcriptSignalV2.findMany({
      where:    { is_invalidated: false, source_doc_type: docType },
      select:   { call_id: true },
      distinct: ['call_id'],
    });
    return new Set(rows.map(r => r.call_id));
  }

  if (scopeCallIds.length === 0) return new Set();

  // Scoped case: a plain `call_id IN (...)` + DISTINCT forces Postgres to
  // enumerate every matching signal row before deduping — some calls have
  // hundreds of active signal rows (annual_report averages ~400/call), so
  // that blew out to 70-120s+ queries. Rephrasing as a per-id EXISTS lets
  // Postgres run it as a semi-join: one index probe per candidate id,
  // stopping at the first match instead of reading every row. Verified
  // ~45x faster with identical results against the old implementation.
  const rows = await prisma.$queryRaw`
    SELECT c.id AS call_id
    FROM unnest(${scopeCallIds}::text[]) AS c(id)
    WHERE EXISTS (
      SELECT 1 FROM transcript_signals_v2 t
      WHERE t.call_id = c.id AND t.is_invalidated = false AND t.source_doc_type = ${docType}
    )
  `;
  return new Set(rows.map(r => r.call_id));
}

module.exports = { hasSignals, invalidateSignals, fetchActiveCallIds, fetchDoneCallIds };
