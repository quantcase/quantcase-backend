'use strict';

/**
 * Technical analysis daily batch handler.
 * Runs the technical-intelligence skill on all stocks (excluding indices)
 * fetched in the latest daily Prowess batch.
 */

const prisma = require('../../config/prisma');
const { bulkEnqueueTechnicals } = require('../../services/admin.technicals.service');

async function resolveLatestDailyBatch(batchToken) {
  if (batchToken) {
    return prisma.prowessBatchRequest.findUnique({
      where: { token: String(batchToken) },
    });
  }

  // Find the latest completed daily batch request
  return prisma.prowessBatchRequest.findFirst({
    where: {
      mode: 'daily',
      status: 'completed',
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Fallback to resolve stock symbols if result.stockSymbols was not populated
 * (e.g. legacy batches). Finds distinct symbols from nse_equity_new updated
 * on the batch's resolved/created date, filtering out indices.
 */
async function fallbackResolveStockSymbols(batchRequest) {
  const batchDate = batchRequest.resolvedAt || batchRequest.createdAt;
  const startOfDay = new Date(batchDate);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(batchDate);
  endOfDay.setUTCHours(23, 59, 59, 999);

  const rows = await prisma.nseEquityNew.findMany({
    where: {
      updated_at: { gte: startOfDay, lte: endOfDay },
    },
    select: { symbol: true },
    distinct: ['symbol'],
  });

  return rows
    .map((r) => r.symbol)
    .filter((s) => s && !s.includes(' ') && s === s.toUpperCase());
}

async function run(config = {}) {
  const force = config.force ?? true;
  const batchRequest = await resolveLatestDailyBatch(config.batch_token);

  if (!batchRequest) {
    console.log('[technicals-daily-batch] No completed daily Prowess batch found.');
    return { records_processed: 0, status: 'skipped', reason: 'no_batch_found' };
  }

  let stockSymbols = batchRequest.result?.stockSymbols;

  if (!Array.isArray(stockSymbols) || stockSymbols.length === 0) {
    console.log(`[technicals-daily-batch] Batch ${batchRequest.token} has no result.stockSymbols, falling back to nse_equity_new...`);
    stockSymbols = await fallbackResolveStockSymbols(batchRequest);
  }

  if (!stockSymbols || stockSymbols.length === 0) {
    console.log(`[technicals-daily-batch] No stocks found for batch ${batchRequest.token}.`);
    return { records_processed: 0, token: batchRequest.token, status: 'skipped', reason: 'no_stocks_found' };
  }

  console.log(`[technicals-daily-batch] Enqueuing ${stockSymbols.length} stocks for technicals analysis from batch ${batchRequest.token} (force=${force})...`);

  // Enqueue via bulkEnqueueTechnicals with skipLimit: true
  const result = await bulkEnqueueTechnicals({
    tickers: stockSymbols,
    force,
    skipLimit: true,
  });

  const enqueuedCount = result.counts?.queued ?? 0;
  const existsCount = result.counts?.exists ?? 0;
  const errorCount = result.counts?.error ?? 0;

  console.log(`[technicals-daily-batch] Completed enqueueing: requested=${result.requested}, queued=${enqueuedCount}, exists=${existsCount}, error=${errorCount}`);

  return {
    records_processed: enqueuedCount,
    token: batchRequest.token,
    total_stocks: stockSymbols.length,
    counts: result.counts,
  };
}

module.exports = { run };
