'use strict';

const prisma = require('../../config/prisma');

async function listModels(orgId, filters = {}) {
  const where = { org_id: orgId };
  if (filters.model_type) {
    where.model_type = filters.model_type;
  }
  if (filters.is_published !== undefined) {
    where.is_published = filters.is_published === 'true' || filters.is_published === true;
  }

  return prisma.wealthApprovedModel.findMany({
    where,
    orderBy: { created_at: 'desc' },
    include: {
      _count: {
        select: { client_mappings: true },
      },
    },
  });
}

async function getModelById(orgId, modelId) {
  const model = await prisma.wealthApprovedModel.findFirst({
    where: { id: modelId, org_id: orgId },
    include: {
      client_mappings: {
        include: {
          client: {
            select: {
              id:     true,
              name:   true,
              aum_cr: true,
              segment:true,
            },
          },
        },
      },
    },
  });

  if (!model) {
    const err = new Error('Approved model not found');
    err.status = 404;
    throw err;
  }
  return model;
}

async function createModel(orgId, data, approvedBy = null) {
  const isPublished = data.is_published || false;
  return prisma.wealthApprovedModel.create({
    data: {
      org_id:            orgId,
      name:              data.name,
      description:       data.description || null,
      model_type:        data.model_type,
      version:           data.version || '1.0',
      min_investment_cr: data.min_investment_cr !== undefined ? Number(data.min_investment_cr) : null,
      is_published:      isPublished,
      approved_by:       approvedBy,
      approved_at:       isPublished ? new Date() : null,
      data:              data.data || {},
    },
  });
}

async function publishModel(orgId, modelId, approvedBy) {
  await getModelById(orgId, modelId);
  return prisma.wealthApprovedModel.update({
    where: { id: modelId },
    data: {
      is_published: true,
      approved_by:  approvedBy,
      approved_at:  new Date(),
    },
  });
}

module.exports = { listModels, getModelById, createModel, publishModel };
