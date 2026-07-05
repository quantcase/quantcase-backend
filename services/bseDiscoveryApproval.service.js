'use strict';

/**
 * Turns an admin-approved BSE discovery URL into a row in the canonical
 * tables (earnings_calls for transcript/ppt, annual_reports for annual
 * reports). BSE only gives us scrip_cd + company_name + scrape_date — there
 * is no existing mapping to the `company` ticker convention already used in
 * those tables, so the admin supplies/confirms company + fiscal_year +
 * quarter; this module only best-effort suggests values to prefill with.
 */

const prisma = require('../config/prisma');

// Same Indian-FY (Apr–Mar) derivation as scripts/importConcalls.js, applied
// to a BSE scrape_date instead of a concall call_date.
const MONTH_TO_QUARTER = {
  0: { q: 'Q3', fyOffset: 0 }, 1: { q: 'Q3', fyOffset: 0 }, 2:  { q: 'Q4', fyOffset: 0 },
  3: { q: 'Q4', fyOffset: 0 }, 4: { q: 'Q4', fyOffset: 0 }, 5:  { q: 'Q1', fyOffset: 1 },
  6: { q: 'Q1', fyOffset: 1 }, 7: { q: 'Q1', fyOffset: 1 }, 8:  { q: 'Q2', fyOffset: 1 },
  9: { q: 'Q2', fyOffset: 1 }, 10: { q: 'Q2', fyOffset: 1 }, 11: { q: 'Q3', fyOffset: 1 },
};

function suggestFiscalYearQuarter(scrapeDate) {
  const d = new Date(scrapeDate);
  if (Number.isNaN(d.getTime())) return { fiscal_year: null, quarter: null };
  const { q, fyOffset } = MONTH_TO_QUARTER[d.getUTCMonth()];
  return { fiscal_year: `FY${d.getUTCFullYear() + fyOffset}`, quarter: q };
}

function normalizeCompanyName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\b(ltd|limited|the)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// Load once per request (not per-URL) — building a normalized-name → ticker
// map so listUrls can look up suggestions for many rows without N queries.
async function loadCompanyTickerMap() {
  const rows = await prisma.earnings_calls.findMany({
    select:   { company: true, company_name: true },
    distinct: ['company'],
  });

  const map = new Map();
  for (const r of rows) {
    const key = normalizeCompanyName(r.company_name);
    if (key && !map.has(key)) map.set(key, r.company);
  }
  return map;
}

// Best-effort match of a BSE company_name against tickers already used in
// earnings_calls/annual_reports. Returns null if nothing lines up — the
// admin types the ticker manually in that case.
function matchCompanyTicker(companyTickerMap, bseCompanyName) {
  return companyTickerMap.get(normalizeCompanyName(bseCompanyName)) ?? null;
}

async function approveTranscriptOrPpt({ docType, url, company, fiscal_year, quarter, call_date }) {
  const field = docType === 'transcript' ? 'transcript_url' : 'ppt_url';

  const existing = await prisma.earnings_calls.findUnique({
    where: { company_fiscal_year_quarter: { company, fiscal_year, quarter } },
  });

  if (existing) {
    return prisma.earnings_calls.update({
      where: { id: existing.id },
      data:  { [field]: url },
    });
  }

  return prisma.earnings_calls.create({
    data: {
      id: `${company}_${fiscal_year}_${quarter}`,
      company, fiscal_year, quarter, call_date,
      [field]: url,
    },
  });
}

async function approveAnnualReport({ url, company, fiscal_year, call_date }) {
  // No unique constraint on annual_reports — check-then-write to avoid duplicates.
  const existing = await prisma.annual_reports.findFirst({
    where: { company, fiscal_year, document_type: 'annual_report' },
  });

  if (existing) {
    return prisma.annual_reports.update({
      where: { id: existing.id },
      data:  { annual_report_url: url },
    });
  }

  return prisma.annual_reports.create({
    data: { company, fiscal_year, document_type: 'annual_report', call_date, annual_report_url: url },
  });
}

/**
 * @param {object} params
 * @param {'transcript'|'ppt'|'annual_report'} params.docType
 * @param {string} params.url
 * @param {string} params.company      — ticker code, admin-confirmed
 * @param {string} params.fiscal_year  — e.g. "FY2026", admin-confirmed
 * @param {string} [params.quarter]    — required for transcript/ppt, e.g. "Q1"
 * @param {string} [params.call_date]  — free-text label stored alongside the row
 */
async function approveCandidate({ docType, url, company, fiscal_year, quarter, call_date }) {
  if (!['transcript', 'ppt', 'annual_report'].includes(docType)) {
    throw Object.assign(new Error(`Invalid docType "${docType}"`), { statusCode: 400 });
  }
  if (!url || !company || !fiscal_year) {
    throw Object.assign(new Error('url, company, and fiscal_year are required'), { statusCode: 400 });
  }

  if (docType === 'annual_report') {
    return approveAnnualReport({ url, company, fiscal_year, call_date: call_date ?? null });
  }

  if (!quarter) {
    throw Object.assign(new Error('quarter is required for transcript/ppt'), { statusCode: 400 });
  }
  return approveTranscriptOrPpt({ docType, url, company, fiscal_year, quarter, call_date: call_date ?? null });
}

module.exports = { suggestFiscalYearQuarter, loadCompanyTickerMap, matchCompanyTicker, approveCandidate };
