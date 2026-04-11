'use strict';

const asyncHandler  = require('../middleware/asyncHandler');
const skillsService = require('../services/admin.skills.service');

const listSkills = asyncHandler(async (req, res) => {
  const data = await skillsService.listSkills();
  res.json({ success: true, data });
});

const getSkill = asyncHandler(async (req, res) => {
  const data = await skillsService.getSkill(req.params.id);
  res.json({ success: true, data });
});

const createSkill = asyncHandler(async (req, res) => {
  const data = await skillsService.createSkill(req.body);
  res.status(201).json({ success: true, data });
});

const updateSkill = asyncHandler(async (req, res) => {
  const data = await skillsService.updateSkill(req.params.id, req.body);
  res.json({ success: true, data });
});

const deleteSkill = asyncHandler(async (req, res) => {
  await skillsService.deleteSkill(req.params.id);
  res.json({ success: true });
});

module.exports = { listSkills, getSkill, createSkill, updateSkill, deleteSkill };
