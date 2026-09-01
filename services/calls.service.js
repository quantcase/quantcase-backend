'use strict';

const prisma = require('../config/prisma');
const { loadIdentityMap } = require('../lib/prowess');

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

  // Best-effort company_name backfill for annual-only tickers, from the
  // Prowess identity CSV (lib/osc_identity.csv, via lib/prowess.js) instead of
  // querying nse_equity_new — that DB query took ~9s on this 1.2M-row table
  // and only covered 795/985 tickers; the CSV is an in-memory lookup (covers
  // 888/985) with no query cost at all. basic_industry has no equivalent
  // source outside earnings_calls, so it stays null for these.
  const identityMap = loadIdentityMap();

  const annualOnly = annualOnlyTickers.map(company => ({
    company,
    company_name:   identityMap[company.toUpperCase()] ?? null,
    basic_industry: null,
    source:         'annual_report',
  }));

  return [...earningsCompanies.map(c => ({ ...c, source: 'earnings_call' })), ...annualOnly]
    .filter(item => item.company && item.company.trim().length > 0)
    .sort((a, b) => a.company.localeCompare(b.company));
}

async function getTranscriptCalls(symbol) {
  const tierRecord = await prisma.tierClassification.findUnique({
    where: { company: symbol }
  });
  const tier = tierRecord ? tierRecord.tier : 'Tier 0';

  let calls = [];
  if (tier === 'Tier 3' || tier === 'Tier 0.5') {
    const earningsCalls = await prisma.earnings_calls.findMany({
      where: {
        company: symbol,
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

    const reports = await prisma.annual_reports.findMany({
      where: { company: symbol, annual_report_url: { not: null } },
      select: { id: true, company: true, fiscal_year: true, call_date: true },
      orderBy: { fiscal_year: 'desc' }
    });

    const existingQ4s = new Set(earningsCalls.filter(c => c.quarter === 'Q4').map(c => c.fiscal_year));

    const reportCalls = reports
      .filter(r => !existingQ4s.has(r.fiscal_year))
      .map(r => ({
        ...r,
        id: r.id.toString(),
        quarter: 'Q4',
        source: 'annual_report'
      }));

    calls = [...earningsCalls, ...reportCalls];
    calls.sort((a, b) => {
      if (b.fiscal_year !== a.fiscal_year) return b.fiscal_year.localeCompare(a.fiscal_year);
      return (b.quarter || '').localeCompare(a.quarter || '');
    });
  } else {
    calls = await prisma.earnings_calls.findMany({
      where: {
        company: symbol,
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
    calls.sort((a, b) => {
      if (b.fiscal_year !== a.fiscal_year) return b.fiscal_year.localeCompare(a.fiscal_year);
      return b.quarter.localeCompare(a.quarter);
    });
  }

  return { calls, tier };
}

module.exports = { listCalls, getCallById, getTranscriptStocks, getTranscriptCalls };
