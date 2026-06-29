'use strict';

const smallcaseService = require('../services/smallcase.service');

const storeAuth = async (req, res) => {
  const { auth_token, broker, broker_client_id, smallcase_user_id } = req.body;
  const result = await smallcaseService.storeAuth(req.user.sub, { auth_token, broker, broker_client_id, smallcase_user_id });
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

module.exports = { storeAuth, syncHoldings, getHoldings, getOrders };
