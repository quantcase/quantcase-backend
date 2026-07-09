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

// Interim fix until a master ticker table exists: earnings_calls alone misses
// tickers that only have an annual report ingested (e.g. ORIENTHOT — no
// earnings call, but present in annual_reports). Merge both sources so the
// stock picker doesn't silently drop them.
async function getTranscriptStocks() {
  const [earningsCompanies, annualCompanies] = await Promise.all([
    prisma.earnings_calls.findMany({
      distinct: ['company'],
      select:   { company: true, company_name: true, basic_industry: true },
      orderBy:  { company: 'asc' },
    }),
    prisma.annual_reports.findMany({
      distinct: ['company'],
      select:   { company: true },
      orderBy:  { company: 'asc' },
    }),
  ]);

  const known = new Set(earningsCompanies.map(c => c.company));
  const annualOnlyTickers = [...new Set(
    annualCompanies.map(c => c.company).filter(c => c && !known.has(c))
  )];

  // Best-effort company_name backfill for annual-only tickers; basic_industry
  // has no equivalent source outside earnings_calls, so it stays null for these.
  const nameRows = annualOnlyTickers.length
    ? await prisma.nse_equity_new.findMany({
        where:    { symbol: { in: annualOnlyTickers } },
        distinct: ['symbol'],
        orderBy:  [{ symbol: 'asc' }, { datetime: 'desc' }],
        select:   { symbol: true, company_name: true },
      })
    : [];
  const nameBySymbol = new Map(nameRows.map(r => [r.symbol, r.company_name]));

  const annualOnly = annualOnlyTickers.map(company => ({
    company,
    company_name:   nameBySymbol.get(company) ?? null,
    basic_industry: null,
    source:         'annual_report',
  }));

  return [...earningsCompanies.map(c => ({ ...c, source: 'earnings_call' })), ...annualOnly]
    .filter(item => item.company && item.company.trim().length > 0)
    .sort((a, b) => a.company.localeCompare(b.company));
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
