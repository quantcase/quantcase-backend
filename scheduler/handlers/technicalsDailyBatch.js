'use strict';

/**
 * Technical analysis daily batch handler.
 * Runs the technical-intelligence skill on a fixed set of stocks
 * (defined in lib/technicalAnalysisBulkList.csv) after the daily Prowess batch.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../config/prisma');
const { bulkEnqueueTechnicals } = require('../../services/admin.technicals.service');

const DEFAULT_LIST_PATH = path.resolve(__dirname, '../../lib/technicalAnalysisBulkList.csv');

/**
 * Loads the fixed list of stock symbols from CSV.
 * Normalizes by trimming, uppercase, removing comments and blank lines,
 * and deduplicating while preserving order.
 */
function loadBulkStockList(filePath = DEFAULT_LIST_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Technical analysis bulk list not found at: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const tickers = content
    .split(/\r?\n/)
    .map((line) => line.trim().toUpperCase())
    .filter((line) => line && !line.startsWith('#'));

  return [...new Set(tickers)];
}

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

  const rows = await prisma.nse_equity_new.findMany({
    where: {
      updatedAt: { gte: startOfDay, lte: endOfDay },
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

  if (!batchRequest && config.require_batch !== false) {
    console.log('[technicals-daily-batch] No completed daily Prowess batch found.');
    return { records_processed: 0, status: 'skipped', reason: 'no_batch_found' };
  }

  const batchToken = batchRequest?.token || config.batch_token || null;

  let stockSymbols;
  if (Array.isArray(config.tickers) && config.tickers.length > 0) {
    stockSymbols = [...new Set(config.tickers.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  } else if (config.use_batch_symbols) {
    stockSymbols = batchRequest?.result?.stockSymbols;
    if (!Array.isArray(stockSymbols) || stockSymbols.length === 0) {
      console.log(`[technicals-daily-batch] Batch ${batchToken} has no result.stockSymbols, falling back to nse_equity_new...`);
      stockSymbols = batchRequest ? await fallbackResolveStockSymbols(batchRequest) : [];
    }
  } else {
    const listPath = config.list_path || DEFAULT_LIST_PATH;
    stockSymbols = loadBulkStockList(listPath);
  }

  if (!stockSymbols || stockSymbols.length === 0) {
    console.log(`[technicals-daily-batch] No stocks found for technicals batch (batch: ${batchToken}).`);
    return { records_processed: 0, token: batchToken, status: 'skipped', reason: 'no_stocks_found' };
  }

  console.log(`[technicals-daily-batch] Enqueuing ${stockSymbols.length} stocks from bulk list for technicals analysis (batch: ${batchToken}, force=${force})...`);

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
    token: batchToken,
    total_stocks: stockSymbols.length,
    counts: result.counts,
  };
}

module.exports = { run, loadBulkStockList, DEFAULT_LIST_PATH };
