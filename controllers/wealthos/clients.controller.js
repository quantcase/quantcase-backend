'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/clients.service');

const listClients = asyncHandler(async (req, res) => {
  const { page, size, segment, rm_id, search } = req.query;
  const result = await service.listClients(page, size, { segment, rm_id, search });
  res.json({ success: true, ...result });
});

const createClient = asyncHandler(async (req, res) => {
  const client = await service.createClient(req.body);
  res.status(201).json({ success: true, data: client });
});

const getClient = asyncHandler(async (req, res) => {
  const client = await service.getClientById(req.params.clientId);
  res.json({ success: true, data: client });
});

const updateClient = asyncHandler(async (req, res) => {
  const client = await service.updateClient(req.params.clientId, req.body);
  res.json({ success: true, data: client });
});

const getPortfolio = asyncHandler(async (req, res) => {
  const portfolio = await service.getClientPortfolio(req.params.clientId);
  res.json({ success: true, data: portfolio });
});

const upsertPortfolio = asyncHandler(async (req, res) => {
  const portfolio = await service.upsertClientPortfolio(req.params.clientId, req.body);
  res.json({ success: true, data: portfolio });
});

const listInteractions = asyncHandler(async (req, res) => {
  const { page, size } = req.query;
  const result = await service.listClientInteractions(req.params.clientId, page, size);
  res.json({ success: true, ...result });
});

const createInteraction = asyncHandler(async (req, res) => {
  const interaction = await service.createInteraction(req.params.clientId, req.body);
  res.status(201).json({ success: true, data: interaction });
});

const listSuggestions = asyncHandler(async (req, res) => {
  const { status, priority } = req.query;
  const suggestionsSvc = require('../../services/wealthos/suggestions.service');
  const data = await suggestionsSvc.listSuggestionsForClient(req.params.clientId, { status, priority });
  res.json({ success: true, data });
});

const listActions = asyncHandler(async (req, res) => {
  const { page, size } = req.query;
  const actionsSvc = require('../../services/wealthos/actions.service');
  const result = await actionsSvc.listClientActions(req.params.clientId, page, size);
  res.json({ success: true, ...result });
});

const assignModel = asyncHandler(async (req, res) => {
  const { clientId, modelId } = req.params;
  const mapping = await service.assignModelToClient(clientId, modelId);
  res.status(201).json({ success: true, data: mapping });
});

const removeModel = asyncHandler(async (req, res) => {
  const { clientId, modelId } = req.params;
  await service.removeModelFromClient(clientId, modelId);
  res.json({ success: true, message: 'Model assignment removed' });
});

const generateMessage = asyncHandler(async (req, res) => {
  const { channel, context, rm_id } = req.body;
  const job = await service.enqueueMessageGeneration(req.params.clientId, channel, context, rm_id);
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
