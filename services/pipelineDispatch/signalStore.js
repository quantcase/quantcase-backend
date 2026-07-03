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
  const where = { is_invalidated: false, source_doc_type: docType };
  if (scopeCallIds !== null) where.call_id = { in: scopeCallIds };
  const rows = await prisma.transcriptSignalV2.findMany({
    where,
    select:   { call_id: true },
    distinct: ['call_id'],
  });
  return new Set(rows.map(r => r.call_id));
}

module.exports = { hasSignals, invalidateSignals, fetchActiveCallIds, fetchDoneCallIds };
