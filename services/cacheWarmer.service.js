'use strict';

const prisma = require('../config/prisma');
const cache  = require('../lib/cache');
const screenerController = require('../controllers/screener.controller');
const prowessController  = require('../controllers/prowess.controller');
const postHtmlAnalysisService = require('./postHtmlAnalysis.service');
const { getLensesByCategory } = require('./lensComposer');

const ALL_DOMAINS = [
  'info',
  'financials',
  'charts',
  'shareholding',
  'peers',
  'technicals',
  'mod',
  'lenses',
  'prices',
];

const L3_TYPES = ['deal', 'management', 'opportunity'];
const L3_TYPES_SORTED = 'deal,management,opportunity';

/**
 * Mock helper to invoke an Express controller with custom params/query.
 */
function invokeController(fn, params = {}, query = {}) {
  return new Promise((resolve, reject) => {
    const req = { params, query };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      setHeader() { return this; },
      json(data) { resolve(data); return this; },
    };
    Promise.resolve(fn(req, res, (err) => {
      if (err) reject(err);
      else resolve(null);
    })).catch(reject);
  });
}

// In-memory state tracking for active background warming jobs
let activeWarmingState = {
  isRunning: false,
  startTime: null,
  totalTickers: 0,
  completedTickers: 0,
  currentTicker: null,
  errors: [],
};

function getWarmingState() {
  return { ...activeWarmingState };
}

/**
 * Warm all requested domains for a single ticker symbol.
 *
 * @param {string} symbol
 * @param {string[]} [domains=ALL_DOMAINS]
 * @returns {Promise<Record<string, { status: string, error?: string }>>}
 */
async function warmStock(symbol, domains = ALL_DOMAINS) {
  const sym = symbol.toUpperCase().trim();
  const selectedDomains = new Set(domains.map((d) => d.toLowerCase()));
  const results = {};

  // 1. Info
  if (selectedDomains.has('info') || selectedDomains.has('all')) {
    try {
      const data = await invokeController(screenerController.getTickerInfo, { symbol: sym }, {});
      results.info = data ? { status: 'CACHED' } : { status: 'NO_DATA' };
    } catch (err) {
      results.info = { status: 'ERROR', error: err.message };
    }
  }

  // 2. Financials
  if (selectedDomains.has('financials') || selectedDomains.has('all')) {
    try {
      const data = await invokeController(screenerController.getFinancials, { symbol: sym }, {});
      results.financials = data ? { status: 'CACHED' } : { status: 'NO_DATA' };
    } catch (err) {
      results.financials = { status: 'ERROR', error: err.message };
    }
  }

  // 3. Charts
  if (selectedDomains.has('charts') || selectedDomains.has('all')) {
    try {
      const data = await invokeController(prowessController.getCharts, { symbol: sym }, {});
      results.charts = data ? { status: 'CACHED', count: data.chartGroups?.length } : { status: 'NO_DATA' };
    } catch (err) {
      results.charts = { status: 'ERROR', error: err.message };
    }
  }

  // 4. Shareholding
  if (selectedDomains.has('shareholding') || selectedDomains.has('all')) {
    try {
      const data = await invokeController(prowessController.getShareholding, { symbol: sym }, {});
      results.shareholding = data ? { status: 'CACHED', sections: data.sections?.length } : { status: 'NO_DATA' };
    } catch (err) {
      results.shareholding = { status: 'ERROR', error: err.message };
    }
  }

  // 5. Peers
  if (selectedDomains.has('peers') || selectedDomains.has('all')) {
    try {
      const data = await invokeController(screenerController.getPeers, { symbol: sym }, {});
      results.peers = data ? { status: 'CACHED', peersCount: data.count } : { status: 'NO_DATA' };
    } catch (err) {
      results.peers = { status: 'ERROR', error: err.message };
    }
  }

  // 6. Technicals
  if (selectedDomains.has('technicals') || selectedDomains.has('all')) {
    try {
      const data = await invokeController(screenerController.getTechnicals, { symbol: sym }, {});
      results.technicals = data ? { status: 'CACHED', insightStatus: data.insightStatus } : { status: 'NO_DATA' };
    } catch (err) {
      results.technicals = { status: 'ERROR', error: err.message };
    }
  }

  // 7. MOD Analysis (L3 & L4)
  if (selectedDomains.has('mod') || selectedDomains.has('all')) {
    try {
      const l3Rows = await postHtmlAnalysisService.getPostHtmlAnalysis(sym, 'l3', L3_TYPES);
      if (l3Rows && l3Rows.length > 0) {
        await cache.set(`qc:analysis:${sym}:l3:${L3_TYPES_SORTED}`, l3Rows, 7 * 86400);
        for (const row of l3Rows) {
          if (row.type) {
            await cache.set(`qc:analysis:${sym}:l3:${row.type.toLowerCase()}`, [row], 7 * 86400);
          }
        }
      }

      const l4Rows = await postHtmlAnalysisService.getPostHtmlAnalysis(sym, 'l4', ['summary']);
      if (l4Rows && l4Rows.length > 0) {
        await cache.set(`qc:analysis:${sym}:l4:summary`, l4Rows, 7 * 86400);
      }

      results.mod = { status: 'CACHED', l3: l3Rows?.length || 0, l4: l4Rows?.length || 0 };
    } catch (err) {
      results.mod = { status: 'ERROR', error: err.message };
    }
  }

  // 8. Lenses
  if (selectedDomains.has('lenses') || selectedDomains.has('all')) {
    try {
      const latest = await prisma.lensScore.findFirst({
        where:   { ticker: sym, is_stale: false },
        select:  { call_id: true },
        orderBy: { computed_at: 'desc' },
      });
      if (latest) {
        const lensData = await getLensesByCategory(latest.call_id);
        const payload = { ...lensData, ticker: sym };
        await cache.set(`qc:lenses:${sym}:all`, payload, 7 * 86400);
        results.lenses = { status: 'CACHED', callId: latest.call_id };
      } else {
        results.lenses = { status: 'NO_LENS_SCORE' };
      }
    } catch (err) {
      results.lenses = { status: 'ERROR', error: err.message };
    }
  }

  // 9. Prices
  if (selectedDomains.has('prices') || selectedDomains.has('all')) {
    try {
      const data = await invokeController(screenerController.getPrices, { symbol: sym }, {});
      results.prices = data ? { status: 'CACHED' } : { status: 'NO_DATA' };
    } catch (err) {
      results.prices = { status: 'ERROR', error: err.message };
    }
  }

  return results;
}

/**
 * Warm a list of tickers with controlled concurrency.
 *
 * @param {string[]} symbols
 * @param {object} [options]
 * @param {string[]} [options.domains=ALL_DOMAINS]
 * @param {number} [options.concurrency=2]
 * @param {(progress: { completed: number, total: number, symbol: string }) => void} [options.onProgress]
 * @returns {Promise<{ total: number, succeeded: number, failed: number, summary: Record<string, any> }>}
 */
async function warmBatch(symbols, options = {}) {
  const domains = options.domains || ALL_DOMAINS;
  const concurrency = Math.max(1, Math.min(6, options.concurrency || 2));
  const onProgress = options.onProgress || (() => {});

  activeWarmingState = {
    isRunning: true,
    startTime: new Date().toISOString(),
    totalTickers: symbols.length,
    completedTickers: 0,
    currentTicker: null,
    errors: [],
  };

  const results = {};
  let idx = 0;

  async function worker() {
    while (idx < symbols.length) {
      const current = symbols[idx++];
      activeWarmingState.currentTicker = current;
      try {
        const stockResult = await warmStock(current, domains);
        results[current] = stockResult;
      } catch (err) {
        results[current] = { error: err.message };
        activeWarmingState.errors.push({ symbol: current, error: err.message });
      }
      activeWarmingState.completedTickers++;
      onProgress({
        completed: activeWarmingState.completedTickers,
        total: symbols.length,
        symbol: current,
      });
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  activeWarmingState.isRunning = false;
  activeWarmingState.currentTicker = null;

  return {
    total: symbols.length,
    completed: activeWarmingState.completedTickers,
    errors: activeWarmingState.errors,
    results,
  };
}

module.exports = {
  ALL_DOMAINS,
  warmStock,
  warmBatch,
  getWarmingState,
};
