'use strict';

const asyncHandler           = require('../middleware/asyncHandler');
const privateEquityService   = require('../services/privateEquity.service');

/**
 * POST /api/private-equity/drhp-analyser
 *
 * Accepts a multipart/form-data upload with a single `document` file field
 * (PDF or plain text). Returns the complete DRHP forensic analysis JSON.
 */
const analyseDrhp = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No document file uploaded. Send a PDF or text file in the `document` field.' });
  }

  const { buffer, mimetype } = req.file;
  const result = await privateEquityService.analyseDrhp(buffer, mimetype);

  res.json({ success: true, data: result });
});

module.exports = { analyseDrhp };
