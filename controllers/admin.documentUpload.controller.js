'use strict';

const { publicBaseUrl } = require('../config/env');
const { approveCandidate } = require('../services/bseDiscoveryApproval.service');

// POST /admin/documents/upload/:docType
// multer has already saved req.file to uploads/<docType>/<uuid>.pdf by this point.
// Reuses approveCandidate() (also used by BSE-discovery approval) so an uploaded
// doc upserts into earnings_calls/annual_reports exactly like a BSE-approved one.
const uploadDocument = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const { docType } = req.params;
    const { company, fiscal_year, quarter, call_date } = req.body;
    const url = `${publicBaseUrl}/uploads/${docType}/${req.file.filename}`;

    const record = await approveCandidate({
      docType, url, company, fiscal_year, quarter, call_date: call_date ?? null,
    });

    // annual_reports.id is a Prisma BigInt (see prisma/schema.prisma), which
    // JSON.stringify can't serialize on its own — stringify it for the response.
    res.json({ success: true, url, record: { ...record, id: record.id?.toString?.() ?? record.id } });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
};

module.exports = { uploadDocument };
