'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/import.service');

const preview = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const entityType = req.body.entity_type || 'clients';
  const result = await service.previewImport(
    req.file.buffer,
    req.file.originalname,
    entityType
  );

  res.json({ success: true, data: result });
});

const execute = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const orgId = req.wealthOrg.id;
  const result = await service.executeClientImport(
    orgId,
    req.file.buffer,
    req.file.originalname,
    req.wealthMember.id,
    req.wealthRole,
    req.wealthRmProfile?.id
  );

  res.json({ success: true, data: result });
});

const history = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const data = await service.listImportHistory(orgId);
  res.json({ success: true, data });
});

module.exports = { preview, execute, history };
