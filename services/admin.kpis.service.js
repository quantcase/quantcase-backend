'use strict';

/**
 * Minimal Kpi CRUD for the admin Prowess-ingestion flow — lets an admin add a
 * new quarterly/annual indicator (with its raw Prowess column name) without a
 * code deploy. See prowess_mappers/ProwessUploader.js for how `prowess_name`
 * is used to resolve CSV columns that aren't in the hardcoded column maps.
 */

const prisma = require('../config/prisma');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function listKpis({ search, limit }) {
  // This endpoint is scoped to the Prowess ingestion flow — only QE-source
  // KPIs are relevant here (transcript-source KPIs come from LLM extraction
  // of earnings calls, unrelated to Prowess CSV/indicator mapping).
  const where = {
    source: 'QE',
    ...(search
      ? {
          OR: [
            { abbr:         { contains: search, mode: 'insensitive' } },
            { full_form:    { contains: search, mode: 'insensitive' } },
            { prowess_name: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  return prisma.kpi.findMany({
    where,
    orderBy: { abbr: 'asc' },
    take: Math.min(limit ?? 50, 200),
  });
}

async function createKpi({ abbr, full_form, denomination, industry, kpi_type, prowess_name }) {
  const existing = await prisma.kpi.findFirst({ where: { abbr } });
  if (existing) throw new HttpError(409, `Kpi with abbr "${abbr}" already exists.`);

  return prisma.kpi.create({
    data: {
      abbr,
      full_form,
      denomination: denomination ?? null,
      industry: industry ?? [],
      kpi_type: kpi_type ?? null,
      source: 'QE',
      // Defaults to abbr when the admin doesn't supply a distinct raw Prowess name.
      prowess_name: prowess_name?.trim() || abbr,
    },
  });
}

module.exports = { listKpis, createKpi, HttpError };
