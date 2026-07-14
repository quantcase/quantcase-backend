'use strict';

const fs = require('fs');
const prisma = require('../config/prisma');
const orchestrator = require('../services/prowess/prowessBatchOrchestrator.service');
const apiClient = require('../services/prowess/prowessBatchApiClient');
const batchRequests = require('../services/prowess/prowessBatchRequests.service');

// POST /admin/prowess/batch/send — multipart: batchfile (proprietary binary), mode, note?
async function sendBatch(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'batchfile is required' });
    const { mode, note } = req.body;

    const { row, rawSendResponse } = await orchestrator.sendBatchAndTrack({
      filePath: req.file.path,
      mode,
      requestMeta: { note: note || null, originalFilename: req.file.originalname },
    });

    res.json({ success: true, data: { token: row.token, status: row.status, sendResponse: rawSendResponse } });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
}

// POST /admin/prowess/batch/:token/check — on-demand GetBatch poll (same logic the scheduler uses)
async function checkBatch(req, res, next) {
  try {
    const row = await orchestrator.pollAndResolve(req.params.token);
    res.json({ success: true, data: row });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
}

// GET /admin/prowess/batch/:token — DB state only, no live Prowess call
async function getBatchStatus(req, res, next) {
  try {
    const row = await batchRequests.getByToken(req.params.token);
    if (!row) return res.status(404).json({ success: false, error: 'Unknown token' });
    res.json({ success: true, data: row });
  } catch (err) {
    next(err);
  }
}

// GET /admin/prowess/batch?status=pending
async function listBatches(req, res, next) {
  try {
    const { status } = req.query;
    const rows = await prisma.prowessBatchRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// POST /admin/prowess/batch/abort-all — cancels ALL pending batches for this API key at Prowess, then marks all pending rows aborted locally
async function abortAll(req, res, next) {
  try {
    const abortResponse = await apiClient.abortAll();
    const { count } = await batchRequests.markAllPendingAborted();
    res.json({ success: true, data: { rowsAborted: count, abortResponse: abortResponse.json ?? abortResponse.rawBody } });
  } catch (err) {
    next(err);
  }
}

module.exports = { sendBatch, checkBatch, getBatchStatus, listBatches, abortAll };
