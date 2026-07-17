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

// ── KpiFilter attachment + recompute (filter_type: 'kpi_filter' groups) ──────

const listFilters = asyncHandler(async (req, res) => {
  const data = await companyGroups.listAttachedFilters(req.params.slug);
  res.json({ success: true, data });
});

const attachFilter = asyncHandler(async (req, res) => {
  const data = await companyGroups.attachFilter(req.params.slug, req.body);
  res.status(201).json({ success: true, data });
});

const detachFilter = asyncHandler(async (req, res) => {
  await companyGroups.detachFilter(req.params.slug, req.params.id);
  res.json({ success: true });
});

const recomputeGroup = asyncHandler(async (req, res) => {
  const data = await companyGroups.recomputeGroup(req.params.slug);
  res.json({ success: true, data });
});

module.exports = {
  listGroups, getGroup, createGroup, updateGroup, deleteGroup, resolveGroupEndpoint,
  listFilters, attachFilter, detachFilter, recomputeGroup,
};
