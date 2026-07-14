'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const errorReportService = require('../services/errorReport.service');

const listErrorReports = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 20));
  const { status, category } = req.query;
  const result = await errorReportService.listErrorReports({ page, size, status, category });
  res.json({ success: true, ...result });
});

const getErrorReport = asyncHandler(async (req, res) => {
  const report = await errorReportService.getErrorReportById(req.params.id);
  res.json({ success: true, data: report });
});

const updateErrorReport = asyncHandler(async (req, res) => {
  const { status, adminNotes } = req.body;
  const report = await errorReportService.updateErrorReport(req.params.id, { status, adminNotes });
  res.json({ success: true, data: report });
});

module.exports = { listErrorReports, getErrorReport, updateErrorReport };
