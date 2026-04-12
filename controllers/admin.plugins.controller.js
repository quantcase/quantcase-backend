'use strict';

const asyncHandler   = require('../middleware/asyncHandler');
const pluginsService = require('../services/admin.plugins.service');

const listPlugins = asyncHandler(async (req, res) => {
  const data = await pluginsService.listPlugins();
  res.json({ success: true, data });
});

const getPlugin = asyncHandler(async (req, res) => {
  const data = await pluginsService.getPlugin(req.params.id);
  res.json({ success: true, data });
});

const createPlugin = asyncHandler(async (req, res) => {
  const data = await pluginsService.createPlugin(req.body);
  res.status(201).json({ success: true, data });
});

const updatePlugin = asyncHandler(async (req, res) => {
  const data = await pluginsService.updatePlugin(req.params.id, req.body);
  res.json({ success: true, data });
});

const deletePlugin = asyncHandler(async (req, res) => {
  await pluginsService.deletePlugin(req.params.id);
  res.json({ success: true });
});

const listPluginSkills = asyncHandler(async (req, res) => {
  const data = await pluginsService.listPluginSkills(req.params.id);
  res.json({ success: true, data });
});

const addSkillToPlugin = asyncHandler(async (req, res) => {
  const { skillId, order } = req.body;
  const data = await pluginsService.addSkillToPlugin(req.params.id, skillId, order);
  res.status(201).json({ success: true, data });
});

const removeSkillFromPlugin = asyncHandler(async (req, res) => {
  await pluginsService.removeSkillFromPlugin(req.params.id, req.params.skillId);
  res.json({ success: true });
});

const reorderPluginSkills = asyncHandler(async (req, res) => {
  const { orderedSkillIds } = req.body;
  const data = await pluginsService.reorderPluginSkills(req.params.id, orderedSkillIds);
  res.json({ success: true, data });
});

module.exports = {
  listPlugins,
  getPlugin,
  createPlugin,
  updatePlugin,
  deletePlugin,
  listPluginSkills,
  addSkillToPlugin,
  removeSkillFromPlugin,
  reorderPluginSkills,
};
