'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/tasks.service');

const listTasks = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const result = await service.listTasks(
    orgId,
    req.query,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, ...result });
});

const createTask = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const task = await service.createTask(
    orgId,
    req.body,
    req.wealthRole,
    req.wealthRmProfile?.id,
    req.wealthMember.id
  );
  res.status(201).json({ success: true, data: task });
});

const updateTask = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const task = await service.updateTask(
    orgId,
    req.params.taskId,
    req.body,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, data: task });
});

const deleteTask = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  await service.deleteTask(
    orgId,
    req.params.taskId,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, message: 'Task deleted successfully' });
});

module.exports = { listTasks, createTask, updateTask, deleteTask };
