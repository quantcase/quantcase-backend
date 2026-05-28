'use strict';

const { Router } = require('express');
const prisma = require('../config/prisma');
const { querySignals, getSignalLineage } = require('../services/db/signals.db');

const router = Router();

// GET /api/signals?ticker=&signalType=&metricFamily=&sourceType=
// Returns signals for the latest available quarter for that ticker.
router.get('/', async (req, res, next) => {
  try {
    const { ticker, signalType, metricFamily, sourceType } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    // Resolve the latest call_id for this ticker from extracted_signals
    const latest = await prisma.extractedSignal.findFirst({
      where:   { ticker, is_invalidated: false },
      select:  { call_id: true },
      orderBy: { call_id: 'desc' },
    });
    if (!latest) return res.json({ ticker, callId: null, count: 0, signals: [] });

    const filters = {
      callId:      latest.call_id,
      metricFamily,
      signalTypes: signalType ? signalType.split(',') : undefined,
      sourceTypes: sourceType ? sourceType.split(',') : undefined,
    };
    const signals = await querySignals(filters);
    res.json({ ticker, callId: latest.call_id, count: signals.length, signals });
  } catch (err) {
    next(err);
  }
});

// GET /api/signals/lineage/:lineageId
router.get('/lineage/:lineageId', async (req, res, next) => {
  try {
    const signals = await getSignalLineage(req.params.lineageId);
    res.json({ lineageId: req.params.lineageId, count: signals.length, signals });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
