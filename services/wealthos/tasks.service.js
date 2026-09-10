'use strict';

const prisma = require('../../config/prisma');
const { writeAuditLog } = require('./clients.service');

async function listTasks(orgId, filters = {}, wealthRole = null, rmProfileId = null) {
  const page = parseInt(filters.page, 10) || 1;
  const size = parseInt(filters.size, 10) || 20;

  const where = { org_id: orgId };

  if (wealthRole === 'rm' && rmProfileId) {
    where.rm_profile_id = rmProfileId;
  } else if (filters.rm_profile_id) {
    where.rm_profile_id = filters.rm_profile_id;
  }

  if (filters.client_id) {
    where.client_id = filters.client_id;
  }

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.task_type) {
    where.task_type = filters.task_type;
  }

  if (filters.due_before) {
    where.due_date = { lte: new Date(filters.due_before) };
  }

  const [total, data] = await Promise.all([
    prisma.wealthTask.count({ where }),
    prisma.wealthTask.findMany({
      where,
      skip:    (page - 1) * size,
      take:    size,
      orderBy: [
        { due_date:   'asc' },
        { created_at: 'desc' },
      ],
      include: {
        client: {
          select: {
            id:      true,
            name:    true,
            segment: true,
            aum_cr:  true,
            phone:   true,
            email:   true,
          },
        },
        rm: {
          select: {
            id:           true,
            display_name: true,
            team:         true,
          },
        },
        linked_interaction: {
          select: {
            id:        true,
            type:      true,
            timestamp: true,
          },
        },
      },
    }),
  ]);

  return {
    data,
    pagination: {
      page,
      size,
      totalItems:      total,
      totalPages:      Math.ceil(total / size),
      hasNextPage:     page * size < total,
      hasPreviousPage: page > 1,
    },
  };
}

async function createTask(orgId, data, wealthRole = null, rmProfileId = null, authorMemberId = null) {
  const taskPayload = {
    org_id:                orgId,
    client_id:             data.client_id || null,
    rm_profile_id:         wealthRole === 'rm' ? rmProfileId : (data.rm_profile_id || rmProfileId || null),
    created_by_member_id:  authorMemberId || null,
    title:                 data.title,
    description:           data.description || null,
    task_type:             data.task_type,
    status:                data.status || 'open',
    due_date:              data.due_date ? new Date(data.due_date) : null,
    linked_interaction_id: data.linked_interaction_id || null,
  };

  const task = await prisma.wealthTask.create({
    data: taskPayload,
    include: {
      client: {
        select: { id: true, name: true },
      },
      rm: {
        select: { id: true, display_name: true },
      },
    },
  });

  await writeAuditLog(orgId, 'task', task.id, 'created', rmProfileId, taskPayload);
  return task;
}

async function updateTask(orgId, taskId, data, wealthRole = null, rmProfileId = null) {
  const existing = await prisma.wealthTask.findFirst({
    where: { id: taskId, org_id: orgId },
  });

  if (!existing) {
    const err = new Error('Task not found');
    err.status = 404;
    throw err;
  }

  if (wealthRole === 'rm' && rmProfileId && existing.rm_profile_id && existing.rm_profile_id !== rmProfileId) {
    const err = new Error('Access denied to update this task');
    err.status = 403;
    throw err;
  }

  const updateData = { ...data };
  delete updateData.id;
  delete updateData.org_id;

  if (updateData.due_date) {
    updateData.due_date = new Date(updateData.due_date);
  }

  if (updateData.status === 'done' && existing.status !== 'done') {
    updateData.completed_at = new Date();
  } else if (updateData.status && updateData.status !== 'done') {
    updateData.completed_at = null;
  }

  const updated = await prisma.wealthTask.update({
    where: { id: taskId },
    data:  updateData,
    include: {
      client: {
        select: { id: true, name: true },
      },
      rm: {
        select: { id: true, display_name: true },
      },
    },
  });

  await writeAuditLog(orgId, 'task', taskId, 'updated', rmProfileId, updateData);
  return updated;
}

async function deleteTask(orgId, taskId, wealthRole = null, rmProfileId = null) {
  const existing = await prisma.wealthTask.findFirst({
    where: { id: taskId, org_id: orgId },
  });

  if (!existing) {
    const err = new Error('Task not found');
    err.status = 404;
    throw err;
  }

  if (wealthRole === 'rm' && rmProfileId && existing.rm_profile_id && existing.rm_profile_id !== rmProfileId) {
    const err = new Error('Access denied to delete this task');
    err.status = 403;
    throw err;
  }

  await prisma.wealthTask.delete({ where: { id: taskId } });
  await writeAuditLog(orgId, 'task', taskId, 'deleted', rmProfileId, null);
}

module.exports = { listTasks, createTask, updateTask, deleteTask };
