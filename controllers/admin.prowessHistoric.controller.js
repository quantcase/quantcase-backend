'use strict';

const { processHistoricCsv } = require('../services/prowessHistoric.service');

async function handle(req, res, next, doInsert) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'file is required' });
    const { mode, doClear, rowLimit } = req.body;

    const report = await processHistoricCsv({
      mode, doInsert, doClear, rowLimit,
      csvPath: req.file.path,
    });

    res.json({ success: true, data: report });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
}

// POST /admin/prowess/historic/preview — parse + validate, no DB writes.
const previewHistoricCsv = (req, res, next) => handle(req, res, next, false);

// POST /admin/prowess/historic/run — parse + validate + insert.
const runHistoricCsv = (req, res, next) => handle(req, res, next, true);

module.exports = { previewHistoricCsv, runHistoricCsv };
