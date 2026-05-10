'use strict';

const { Router } = require('express');
const { querySignals, getSignalLineage } = require('../services/db/signals.db');

const router = Router();

// GET /api/signals?callId=&ticker=&signalType=&metricFamily=&sourceType=
router.get('/', async (req, res, next) => {
  try {
    const { callId, ticker, signalType, metricFamily, sourceType } = req.query;
    const filters = {
      callId,
      ticker,
      metricFamily,
      signalTypes:  signalType  ? signalType.split(',')  : undefined,
      sourceTypes:  sourceType  ? sourceType.split(',')  : undefined,
    };
    const signals = await querySignals(filters);
    res.json({ count: signals.length, signals });
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
