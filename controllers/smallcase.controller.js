'use strict';

const smallcaseService = require('../services/smallcase.service');

const connect = async (req, res) => {
  const { intent } = req.body || {};
  const result = await smallcaseService.createConnect(req.user.sub, { intent });
  return res.status(201).json({ success: true, data: result });
};

const confirmTransaction = async (req, res) => {
  const result = await smallcaseService.confirmTransaction(req.user.sub, req.params.id);
  return res.json({ success: true, data: result });
};

const syncHoldings = async (req, res) => {
  const result = await smallcaseService.syncHoldings(req.user.sub);
  return res.json({ success: true, data: result });
};

const getHoldings = async (req, res) => {
  const result = await smallcaseService.getHoldings(req.user.sub);
  return res.json({ success: true, data: result });
};

const getOrders = async (req, res) => {
  const { status, page, limit } = req.query;
  const result = await smallcaseService.getOrders(req.user.sub, {
    status,
    page:  page  ? parseInt(page)  : 1,
    limit: limit ? parseInt(limit) : 20,
  });
  return res.json({ success: true, data: result });
};

const createOrder = async (req, res) => {
  const { type, scid, smallcase_name, amount } = req.body || {};
  const result = await smallcaseService.createOrder(req.user.sub, {
    type,
    scid,
    smallcaseName: smallcase_name,
    amount,
  });
  return res.status(201).json({ success: true, data: result });
};

// Server-to-server webhook — authenticated by checksum, not by JWT. Receives a raw body.
const handleWebhook = async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  const ok = await smallcaseService.handleWebhook(payload);
  if (!ok) {
    return res.status(400).json({ success: false, error: 'Invalid checksum' });
  }
  return res.json({ success: true });
};

module.exports = {
  connect,
  confirmTransaction,
  syncHoldings,
  getHoldings,
  getOrders,
  createOrder,
  handleWebhook,
};
