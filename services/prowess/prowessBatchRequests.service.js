'use strict';

/**
 * Tracks the async SendBatch → GetBatch lifecycle (see prisma model
 * ProwessBatchRequest). SendBatch is submitted once, synchronously, from an
 * admin-triggered action (no auto-retry — it's an expensive call). The
 * returned token is stored here; a scheduler job polls GetBatch for every
 * still-pending row and resolves it here when Prowess returns a result.
 *
 * Pure DB bookkeeping — no HTTP calls to Prowess happen in this file.
 */

const prisma = require('../../config/prisma');

async function createBatchRequest({ token, mode, requestMeta }) {
  return prisma.prowessBatchRequest.create({
    data: { token, mode, requestMeta: requestMeta ?? null },
  });
}

async function getByToken(token) {
  return prisma.prowessBatchRequest.findUnique({ where: { token } });
}

async function listPending() {
  return prisma.prowessBatchRequest.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
}

async function markCompleted(token, result) {
  return prisma.prowessBatchRequest.update({
    where: { token },
    data: { status: 'completed', result, resolvedAt: new Date() },
  });
}

async function markFailed(token, error) {
  return prisma.prowessBatchRequest.update({
    where: { token },
    data: { status: 'failed', error: String(error?.message ?? error), resolvedAt: new Date() },
  });
}

async function markAborted(token) {
  return prisma.prowessBatchRequest.update({
    where: { token },
    data: { status: 'aborted', resolvedAt: new Date() },
  });
}

/** Bulk-marks every currently-pending row aborted — pairs with AbortAll, which cancels all pending batches for the API key at once. */
async function markAllPendingAborted() {
  return prisma.prowessBatchRequest.updateMany({
    where: { status: 'pending' },
    data: { status: 'aborted', resolvedAt: new Date() },
  });
}

module.exports = {
  createBatchRequest, getByToken, listPending,
  markCompleted, markFailed, markAborted, markAllPendingAborted,
};
