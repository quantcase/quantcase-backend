'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const callsService = require('../services/calls.service');

const getCalls = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 10));
  const result = await callsService.listCalls(page, size);
  res.json({ success: true, ...result });
});

const getCallById = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const call = await callsService.getCallById(callId);
  if (!call) return res.status(404).json({ success: false, error: 'Call not found' });
  res.json({ success: true, data: call });
});

const getTranscriptStocks = asyncHandler(async (_, res) => {
  const data = await callsService.getTranscriptStocks();
  res.json({ success: true, data });
});

const getTranscriptCalls = asyncHandler(async (req, res) => {
  const { symbol } = req.query;
  const calls = await callsService.getTranscriptCalls(symbol);
  res.json({ success: true, data: calls.reverse() });
});

module.exports = { getCalls, getCallById, getTranscriptStocks, getTranscriptCalls };
