'use strict';

const prisma = require('../config/prisma');

async function listCalls(page, size) {
  const skip = (page - 1) * size;
  const [totalCount, calls] = await Promise.all([
    prisma.earnings_calls.count(),
    prisma.earnings_calls.findMany({ orderBy: { created_at: 'desc' }, skip, take: size }),
  ]);
  const totalPages = Math.ceil(totalCount / size);
  return {
    data: calls,
    pagination: {
      page,
      size,
      totalItems:      totalCount,
      totalPages,
      hasNextPage:     page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
}

async function getCallById(callId) {
  return prisma.earnings_calls.findUnique({ where: { id: callId } });
}

async function getTranscriptStocks() {
  const companies = await prisma.earnings_calls.findMany({
    distinct: ['company'],
    select:   { company: true, company_name: true, basic_industry: true },
    orderBy:  { company: 'asc' },
  });
  return companies.filter(item => item.company && item.company.trim().length > 0);
}

async function getTranscriptCalls(symbol) {
  const calls = await prisma.earnings_calls.findMany({
    where: {
      company: symbol,
      // URL presence, not text presence — a call can be ingested and even
      // L1-extracted via its PDF without ever backfilling transcript_text/
      // ppt_text on this row (e.g. HDFCBANK FY2026 Q4: has ppt_url and an
      // extracted signal, but ppt_text is still null).
      OR: [
        { transcript_url: { not: null } },
        { ppt_url:        { not: null } },
      ],
    },
    select: {
      id:            true,
      company:       true,
      company_name:  true,
      basic_industry: true,
      fiscal_year:   true,
      call_date:     true,
      quarter:       true,
      ppt_url:       true,
      transcript_text: false,
      ppt_text:        false,
    },
  });
  return calls.sort((a, b) => {
    if (b.fiscal_year !== a.fiscal_year) return b.fiscal_year.localeCompare(a.fiscal_year);
    return b.quarter.localeCompare(a.quarter);
  });
}

module.exports = { listCalls, getCallById, getTranscriptStocks, getTranscriptCalls };
