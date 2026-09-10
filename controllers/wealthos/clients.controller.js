'use strict';

const asyncHandler    = require('../../middleware/asyncHandler');
const service         = require('../../services/wealthos/clients.service');
const suggestionsSvc  = require('../../services/wealthos/suggestions.service');
const actionsSvc      = require('../../services/wealthos/actions.service');

const listClients = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const page = parseInt(req.query.page, 10) || 1;
  const size = parseInt(req.query.size, 10) || 20;
  const { segment, lifecycle_status, kyc_status, risk_profile, search } = req.query;
  const rm_profile_id = req.query.rm_profile_id || req.query.rm_id;

  const result = await service.listClients(
    orgId,
    page,
    size,
    { segment, lifecycle_status, kyc_status, risk_profile, rm_profile_id, search },
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, ...result });
});

const createClient = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const client = await service.createClient(
    orgId,
    req.body,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.status(201).json({ success: true, data: client });
});

const getClient = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const client = await service.getClientById(
    orgId,
    req.params.clientId,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, data: client });
});

const updateClient = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const client = await service.updateClient(
    orgId,
    req.params.clientId,
    req.body,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, data: client });
});

const getPortfolio = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const portfolio = await service.getClientPortfolio(
    orgId,
    req.params.clientId,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, data: portfolio });
});

const upsertPortfolio = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const portfolio = await service.upsertClientPortfolio(
    orgId,
    req.params.clientId,
    req.body,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, data: portfolio });
});

const listInteractions = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const page = parseInt(req.query.page, 10) || 1;
  const size = parseInt(req.query.size, 10) || 20;
  const result = await service.listClientInteractions(
    orgId,
    req.params.clientId,
    page,
    size,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, ...result });
});

const createInteraction = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const interaction = await service.createInteraction(
    orgId,
    req.params.clientId,
    req.body,
    req.wealthRmProfile?.id
  );
  res.status(201).json({ success: true, data: interaction });
});

const listSuggestions = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const { status, priority } = req.query;
  const data = await suggestionsSvc.listSuggestionsForClient(
    orgId,
    req.params.clientId,
    { status, priority }
  );
  res.json({ success: true, data });
});

const listActions = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const page = parseInt(req.query.page, 10) || 1;
  const size = parseInt(req.query.size, 10) || 20;
  const result = await actionsSvc.listClientActions(orgId, req.params.clientId, page, size);
  res.json({ success: true, ...result });
});

const assignModel = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const { clientId, modelId } = req.params;
  const mapping = await service.assignModelToClient(
    orgId,
    clientId,
    modelId,
    req.wealthMember.id
  );
  res.status(201).json({ success: true, data: mapping });
});

const removeModel = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const { clientId, modelId } = req.params;
  await service.removeModelFromClient(
    orgId,
    clientId,
    modelId,
    req.wealthMember.id
  );
  res.json({ success: true, message: 'Model assignment removed' });
});

const generateMessage = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const { channel, context } = req.body;
  const rmProfileId = req.wealthRmProfile?.id || req.body.rm_id || req.body.rm_profile_id;
  const job = await service.enqueueMessageGeneration(
    orgId,
    req.params.clientId,
    channel,
    context,
    rmProfileId
  );
  res.json({ success: true, message: 'Message generation job queued', job });
});

module.exports = {
  listClients,
  createClient,
  getClient,
  updateClient,
  getPortfolio,
  upsertPortfolio,
  listInteractions,
  createInteraction,
  listSuggestions,
  listActions,
  assignModel,
  removeModel,
  generateMessage,
};
