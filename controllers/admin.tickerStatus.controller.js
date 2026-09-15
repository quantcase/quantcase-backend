'use strict';

const service = require('../services/tickerStatus/tickerStatus.service');

async function previewTickerStatus(req, res, next) {
  try {
    const result = await service.previewTickerStatus(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getTickerStatusOptions(req, res, next) {
  try {
    const options = await service.getTickerStatusOptions();
    res.json(options);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  previewTickerStatus,
  getTickerStatusOptions,
};
