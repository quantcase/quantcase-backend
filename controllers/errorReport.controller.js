'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const errorReportService = require('../services/errorReport.service');

// POST /api/error-reports — authenticated; req.user comes from the Bearer JWT.
const createErrorReport = asyncHandler(async (req, res) => {
  const { category, message, pageUrl, errorMessage, userAgent, metadata } = req.body;

  const report = await errorReportService.createErrorReport({
    userId: req.user?.sub,
    userEmail: req.user?.email,
    category,
    message,
    pageUrl,
    errorMessage,
    userAgent,
    metadata,
  });

  res.status(201).json({ success: true, data: report });
});

module.exports = { createErrorReport };
