'use strict';

const tickerMetrics = require('../services/tickerMetrics.service');
const cache         = require('../lib/cache');

const MAX_TICKERS = 100;

function setCacheTillMidnightIst(res) {
  const nowUtc = new Date();
  const midnight = new Date(nowUtc);
  midnight.setUTCHours(18, 30, 0, 0); // midnight IST = 18:30 UTC
  if (midnight <= nowUtc) midnight.setUTCDate(midnight.getUTCDate() + 1);
  const maxAge = Math.floor((midnight - nowUtc) / 1000);
  res.set('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=60`);
}

/**
 * Accepts either ?tickers=A,B,C / ?tickers[]=A&tickers[]=B (GET)
 * or { tickers: ["A","B"] } (POST). Returns a normalised string[].
 */
function parseTickers(req) {
  const raw = req.method === 'POST' ? req.body?.tickers : req.query.tickers;
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((t) => t.trim()).filter(Boolean);
  return null; // signals a bad type (object/number)
}

/**
 * GET  /api/tickers?tickers=TCS,INFY
 * POST /api/tickers  { "tickers": ["TCS", "INFY"] }
 *
 * Batch equivalent of the peers table in GET /api/screener/:symbol/peers —
 * same row shape, but the caller chooses the tickers.
 */
async function getTickers(req, res, next) {
  try {
    const tickers = parseTickers(req);

    if (tickers === null) {
      return res.status(400).json({ error: '"tickers" must be an array or a comma-separated string' });
    }
    if (tickers.length === 0) {
      return res.status(400).json({
        error: 'Provide at least one ticker via ?tickers=A,B,C or a JSON body { "tickers": ["A","B"] }',
      });
    }
    if (tickers.length > MAX_TICKERS) {
      return res.status(400).json({
        error: `Too many tickers: ${tickers.length}. Maximum is ${MAX_TICKERS} per request.`,
      });
    }

    const sortedKey = tickers.slice().sort().join(',');
    const cacheKey = `qc:tickers:${sortedKey}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      setCacheTillMidnightIst(res);
      return res.json(cached);
    }

    const { tickers: rows, notFound } = await tickerMetrics.getMetricsForTickers(tickers);
    const { latestQuarter, yearAgoQuarter } = await tickerMetrics.getQuarterLabels();

    const payload = {
      count: rows.length,
      latestQuarter,
      yearAgoQuarter,
      notFound,
      tickers: rows,
    };

    cache.set(cacheKey, payload, 86400).catch(() => {});
    setCacheTillMidnightIst(res);
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

module.exports = { getTickers, MAX_TICKERS };
