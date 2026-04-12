'use strict';

const router = require('express').Router();
const wl = require('../controllers/watchlist.controller');

// GET  /api/watchlists?user_id=xxx             — list all watchlists for a user
router.get('/', wl.getWatchlists);

// GET  /api/watchlists/:watchlistId?user_id=xxx — get single watchlist with assets
router.get('/:watchlistId', wl.getWatchlist);

// POST /api/watchlists/add-symbols              — add symbols (creates watchlist if no ID given)
// NOTE: must be declared before POST / to prevent any ambiguity
router.post('/add-symbols', wl.addSymbols);

// POST /api/watchlists                          — create a new empty watchlist
router.post('/', wl.createWatchlist);

// PATCH /api/watchlists/:watchlistId?user_id=xx — rename a watchlist
router.patch('/:watchlistId', wl.updateWatchlist);

// DELETE /api/watchlists/:watchlistId?user_id=xx — delete entire watchlist
router.delete('/:watchlistId', wl.deleteWatchlist);

// DELETE /api/watchlists/:watchlistId/symbols/:symbol?user_id=xx — remove one symbol
router.delete('/:watchlistId/symbols/:symbol', wl.removeSymbol);

module.exports = router;
