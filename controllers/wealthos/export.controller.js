'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/export.service');

const exportClients = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const format = (req.query.format || 'csv').toLowerCase();

  const { content, buffer, contentType, filename } = await service.exportClients(
    orgId,
    req.wealthRole,
    req.wealthRmProfile?.id,
    format
  );

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  if (buffer) {
    return res.send(buffer);
  }
  return res.send(content);
});

const exportHoldings = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const format = (req.query.format || 'csv').toLowerCase();

  const { content, buffer, contentType, filename } = await service.exportHoldings(
    orgId,
    req.wealthRole,
    req.wealthRmProfile?.id,
    format
  );

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  if (buffer) {
    return res.send(buffer);
  }
  return res.send(content);
});

module.exports = { exportClients, exportHoldings };
