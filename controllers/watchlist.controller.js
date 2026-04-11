'use strict';

const prisma = require('../config/prisma');

/**
 * GET /api/watchlists?user_id=xxx
 * List all watchlists for a user (with asset count and asset details).
 */
async function getWatchlists(req, res) {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const watchlists = await prisma.watchlist.findMany({
    where: { user_id },
    include: { assets: { orderBy: { added_on: 'desc' } } },
    orderBy: { created_at: 'desc' },
  });

  res.json({ watchlists });
}

/**
 * GET /api/watchlists/:watchlistId?user_id=xxx
 * Get a single watchlist with all its assets.
 */
async function getWatchlist(req, res) {
  const { watchlistId } = req.params;
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const watchlist = await prisma.watchlist.findFirst({
    where: { id: watchlistId, user_id },
    include: { assets: { orderBy: { added_on: 'desc' } } },
  });

  if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });
  res.json({ watchlist });
}

/**
 * POST /api/watchlists
 * Create a new empty watchlist.
 * Body: { user_id, name }
 */
async function createWatchlist(req, res) {
  const { user_id, name } = req.body;
  if (!user_id || !name) {
    return res.status(400).json({ error: 'user_id and name are required' });
  }

  const watchlist = await prisma.watchlist.create({
    data: { user_id, name, total_assets: 0 },
    include: { assets: true },
  });

  res.status(201).json({ watchlist });
}

/**
 * POST /api/watchlists/add-symbols
 * Add symbols to a watchlist. Creates a new watchlist if watchlist_id is omitted.
 * Body: { user_id, symbols: string[], watchlist_id?: string, watchlist_name?: string }
 *
 * Rules:
 *  - If watchlist_id provided → add to that watchlist (must belong to user).
 *  - If watchlist_id omitted  → create a new watchlist (watchlist_name required).
 *  - Duplicate symbols in the same watchlist are silently skipped (upsert).
 */
async function addSymbols(req, res) {
  const { user_id, symbols, watchlist_id, watchlist_name } = req.body;

  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols must be a non-empty array' });
  }

  const uniqueSymbols = [...new Set(symbols.map(s => String(s).toUpperCase().trim()))].filter(Boolean);

  let watchlist;

  if (watchlist_id) {
    // Validate ownership
    watchlist = await prisma.watchlist.findFirst({
      where: { id: watchlist_id, user_id },
    });
    if (!watchlist) {
      return res.status(404).json({ error: 'Watchlist not found or does not belong to user' });
    }
  } else {
    // Create new watchlist
    if (!watchlist_name) {
      return res.status(400).json({ error: 'watchlist_name is required when watchlist_id is not provided' });
    }
    watchlist = await prisma.watchlist.create({
      data: { user_id, name: watchlist_name, total_assets: 0 },
    });
  }

  // Upsert each symbol (skip if already present)
  await Promise.all(
    uniqueSymbols.map(symbol =>
      prisma.watchlistAsset.upsert({
        where: { watchlist_id_symbol: { watchlist_id: watchlist.id, symbol } },
        update: {},                                  // no-op if already exists
        create: { watchlist_id: watchlist.id, symbol },
      })
    )
  );

  // Recount and sync total_assets
  const assetCount = await prisma.watchlistAsset.count({ where: { watchlist_id: watchlist.id } });
  const updated = await prisma.watchlist.update({
    where: { id: watchlist.id },
    data: { total_assets: assetCount },
    include: { assets: { orderBy: { added_on: 'desc' } } },
  });

  res.status(watchlist_id ? 200 : 201).json({ watchlist: updated });
}

/**
 * DELETE /api/watchlists/:watchlistId/symbols/:symbol?user_id=xxx
 * Remove a single symbol from a watchlist.
 */
async function removeSymbol(req, res) {
  const { watchlistId, symbol } = req.params;
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const watchlist = await prisma.watchlist.findFirst({ where: { id: watchlistId, user_id } });
  if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

  const normalised = String(symbol).toUpperCase().trim();
  const deleted = await prisma.watchlistAsset.deleteMany({
    where: { watchlist_id: watchlistId, symbol: normalised },
  });

  if (deleted.count === 0) {
    return res.status(404).json({ error: `Symbol '${normalised}' not found in watchlist` });
  }

  const assetCount = await prisma.watchlistAsset.count({ where: { watchlist_id: watchlistId } });
  const updated = await prisma.watchlist.update({
    where: { id: watchlistId },
    data: { total_assets: assetCount },
    include: { assets: { orderBy: { added_on: 'desc' } } },
  });

  res.json({ watchlist: updated });
}

/**
 * PATCH /api/watchlists/:watchlistId?user_id=xxx
 * Rename a watchlist.
 * Body: { name }
 */
async function updateWatchlist(req, res) {
  const { watchlistId } = req.params;
  const { user_id } = req.query;
  const { name } = req.body;

  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  if (!name)    return res.status(400).json({ error: 'name is required' });

  const watchlist = await prisma.watchlist.findFirst({ where: { id: watchlistId, user_id } });
  if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

  const updated = await prisma.watchlist.update({
    where: { id: watchlistId },
    data: { name },
    include: { assets: { orderBy: { added_on: 'desc' } } },
  });

  res.json({ watchlist: updated });
}

/**
 * DELETE /api/watchlists/:watchlistId?user_id=xxx
 * Delete an entire watchlist (cascade-deletes all assets).
 */
async function deleteWatchlist(req, res) {
  const { watchlistId } = req.params;
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const watchlist = await prisma.watchlist.findFirst({ where: { id: watchlistId, user_id } });
  if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

  await prisma.watchlist.delete({ where: { id: watchlistId } });
  res.json({ success: true, deleted_id: watchlistId });
}

module.exports = {
  getWatchlists,
  getWatchlist,
  createWatchlist,
  addSymbols,
  removeSymbol,
  updateWatchlist,
  deleteWatchlist,
};
