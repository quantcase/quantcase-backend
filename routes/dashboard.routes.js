'use strict';

/**
 * Investor-dashboard routes that don't live under /api/portfolio.
 * Exposes three mini-routers (discover / research-library / market) so each
 * mounts at its own base path in routes/index.js. All require authentication.
 */

const express      = require('express');
const authenticate = require('../middleware/authenticate');
const ctrl         = require('../controllers/dashboard.controller');

const discover = express.Router();
discover.use(authenticate);
discover.get('/screens', ctrl.getDiscoverScreens);

const researchLibrary = express.Router();
researchLibrary.use(authenticate);
researchLibrary.get('/summary', ctrl.getResearchLibrarySummary);

const market = express.Router();
market.use(authenticate);
market.get('/indices', ctrl.getMarketIndices);

module.exports = { discover, researchLibrary, market };
