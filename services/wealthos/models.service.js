'use strict';

const prisma = require('../../config/prisma');

async function listModels() {
  return prisma.wealthApprovedModel.findMany({ orderBy: { name: 'asc' } });
}

async function createModel(data) {
  return prisma.wealthApprovedModel.create({ data });
}

async function getModelById(modelId) {
  const model = await prisma.wealthApprovedModel.findUnique({ where: { id: modelId } });
  if (!model) {
    const err = new Error('Approved model not found');
    err.status = 404;
    throw err;
  }
  return model;
}

module.exports = { listModels, createModel, getModelById };
