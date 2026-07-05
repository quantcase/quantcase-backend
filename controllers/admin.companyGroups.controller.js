'use strict';

const asyncHandler       = require('../middleware/asyncHandler');
const companyGroups      = require('../services/companyGroups');

const listGroups = asyncHandler(async (req, res) => {
  const data = await companyGroups.listGroups();
  res.json({ success: true, data });
});

const getGroup = asyncHandler(async (req, res) => {
  const data = await companyGroups.getGroup(req.params.slug);
  res.json({ success: true, data });
});

const createGroup = asyncHandler(async (req, res) => {
  const data = await companyGroups.createGroup(req.body);
  res.status(201).json({ success: true, data });
});

const updateGroup = asyncHandler(async (req, res) => {
  const data = await companyGroups.updateGroup(req.params.slug, req.body);
  res.json({ success: true, data });
});

const deleteGroup = asyncHandler(async (req, res) => {
  await companyGroups.deleteGroup(req.params.slug);
  res.json({ success: true });
});

const resolveGroupEndpoint = asyncHandler(async (req, res) => {
  const tickers = await companyGroups.resolveGroupBySlug(req.params.slug);
  res.json({ success: true, data: { tickers, count: tickers.length } });
});

module.exports = { listGroups, getGroup, createGroup, updateGroup, deleteGroup, resolveGroupEndpoint };
