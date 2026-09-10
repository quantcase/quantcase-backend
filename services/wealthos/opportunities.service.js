'use strict';

const prisma = require('../../config/prisma');
const { writeAuditLog, getClientById } = require('./clients.service');

async function listOpportunities(orgId, filters = {}, wealthRole = null, rmProfileId = null) {
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

  if (filters.category && filters.category !== 'all') {
    where.category = filters.category;
  }

  if (filters.status && filters.status !== 'all') {
    where.status = filters.status;
  } else if (!filters.status) {
    where.status = 'open';
  }

  const [total, data] = await Promise.all([
    prisma.wealthOpportunity.count({ where }),
    prisma.wealthOpportunity.findMany({
      where,
      skip:    (page - 1) * size,
      take:    size,
      orderBy: [
        { fit_score:  'desc' },
        { created_at: 'desc' },
      ],
      include: {
        client: {
          select: {
            id:           true,
            name:         true,
            segment:      true,
            aum_cr:       true,
            risk_profile: true,
          },
        },
        rm: {
          select: {
            id:           true,
            display_name: true,
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

async function createOpportunity(orgId, data, wealthRole = null, rmProfileId = null) {
  const client = await getClientById(orgId, data.client_id, wealthRole, rmProfileId);

  const payload = {
    org_id:              orgId,
    client_id:           data.client_id,
    rm_profile_id:       wealthRole === 'rm' ? rmProfileId : (data.rm_profile_id || client.rm_profile_id || rmProfileId),
    category:            data.category,
    sub_category:        data.sub_category || null,
    headline:            data.headline,
    evidence:            data.evidence || null,
    source_type:         data.source_type || 'manual',
    source_ref:          data.source_ref || null,
    fit_score:           data.fit_score !== undefined ? Number(data.fit_score) : 0.8,
    indicative_value_cr: data.indicative_value_cr !== undefined ? Number(data.indicative_value_cr) : null,
    status:              data.status || 'open',
    talking_points:      data.talking_points || [],
  };

  const opp = await prisma.wealthOpportunity.create({
    data: payload,
    include: {
      client: {
        select: { id: true, name: true, aum_cr: true },
      },
      rm: {
        select: { id: true, display_name: true },
      },
    },
  });

  await writeAuditLog(orgId, 'opportunity', opp.id, 'created', rmProfileId, payload);
  return opp;
}

async function updateOpportunity(orgId, oppId, data, wealthRole = null, rmProfileId = null, memberId = null) {
  const existing = await prisma.wealthOpportunity.findFirst({
    where: { id: oppId, org_id: orgId },
  });

  if (!existing) {
    const err = new Error('Opportunity not found');
    err.status = 404;
    throw err;
  }

  if (wealthRole === 'rm' && rmProfileId && existing.rm_profile_id && existing.rm_profile_id !== rmProfileId) {
    const err = new Error('Access denied to this opportunity');
    err.status = 403;
    throw err;
  }

  const updateData = { ...data };
  delete updateData.id;
  delete updateData.org_id;

  if (updateData.status === 'dismissed' && existing.status !== 'dismissed') {
    updateData.dismissed_at = new Date();
    updateData.dismissed_by = memberId || null;
  } else if (updateData.status === 'actioned' && existing.status !== 'actioned') {
    updateData.converted_at = new Date();
  }

  const updated = await prisma.wealthOpportunity.update({
    where: { id: oppId },
    data:  updateData,
    include: {
      client: {
        select: { id: true, name: true, aum_cr: true },
      },
      rm: {
        select: { id: true, display_name: true },
      },
    },
  });

  await writeAuditLog(orgId, 'opportunity', oppId, 'updated', rmProfileId, updateData);
  return updated;
}

async function getOpportunitiesSummary(orgId, wealthRole = null, rmProfileId = null) {
  const where = { org_id: orgId, status: 'open' };
  if (wealthRole === 'rm' && rmProfileId) {
    where.rm_profile_id = rmProfileId;
  }

  const opps = await prisma.wealthOpportunity.findMany({
    where,
    select: {
      id: true,
      category: true,
      fit_score: true,
      indicative_value_cr: true,
      client_id: true,
    },
  });

  const totalCount = opps.length;
  let totalAumCr = 0;
  let highReceptivityCount = 0;
  let idleCashCr = 0;
  const idleCashClients = new Set();
  let coverageGapsCount = 0;

  for (const opp of opps) {
    const val = Number(opp.indicative_value_cr) || 0;
    totalAumCr += val;
    if (opp.category === 'client_asked' || opp.category === 'life_event' || (opp.fit_score && opp.fit_score >= 80)) {
      highReceptivityCount++;
    }
    if (opp.category === 'idle_cash') {
      idleCashCr += val;
      if (opp.client_id) idleCashClients.add(opp.client_id);
    }
    if (opp.category === 'rebalance' || opp.category === 'coverage_gap') {
      coverageGapsCount++;
    }
  }

  return {
    total_count: totalCount,
    total_aum_cr: Number(totalAumCr.toFixed(2)),
    high_receptivity_count: highReceptivityCount,
    idle_cash_cr: Number(idleCashCr.toFixed(2)),
    idle_cash_clients_count: idleCashClients.size,
    coverage_gaps_count: coverageGapsCount,
  };
}

module.exports = { listOpportunities, getOpportunitiesSummary, createOpportunity, updateOpportunity };
