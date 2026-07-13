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
const { loadIdentityMap } = require('../lib/prowess');

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
// Merges earnings_calls + annual_reports tickers (mirrors the merge in
// calls.service.js's getTranscriptStocks / admin.pipelineDispatch.controller.js's
// getL1MultiOptions) — otherwise annual-only tickers (e.g. ORIENTHOT, no
// earnings call ingested yet) can never get a ticker suggestion here. Falls
// back to the osc_identity CSV (lib/prowess.js) for company_name, both for
// annual_reports rows (which have no company_name column at all) and for
// earnings_calls rows where company_name hasn't been backfilled.
async function loadCompanyTickerMap() {
  const [callRows, reportRows] = await Promise.all([
    prisma.earnings_calls.findMany({
      select:   { company: true, company_name: true },
      distinct: ['company'],
    }),
    prisma.annual_reports.findMany({
      select:   { company: true },
      distinct: ['company'],
    }),
  ]);

  const identityMap = loadIdentityMap();
  const map = new Map();
  for (const r of callRows) {
    if (!r.company) continue;
    const key = normalizeCompanyName(r.company_name ?? identityMap[r.company.toUpperCase()]);
    if (key && !map.has(key)) map.set(key, r.company);
  }
  for (const r of reportRows) {
    if (!r.company) continue;
    const key = normalizeCompanyName(identityMap[r.company.toUpperCase()]);
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

// Batched read-only lookup of what's already stored for a set of candidate
// (company, fiscal_year, quarter) / (company, fiscal_year) slots — lets
// listUrls warn an admin "you're about to overwrite X" before they approve,
// without one findUnique/findFirst per row. Mirrors the write-side upsert
// keys used by approveTranscriptOrPpt/approveAnnualReport below, but never
// writes.
//
// @param {{company, fiscal_year, quarter}[]} transcriptPptKeys
// @param {{company, fiscal_year}[]} annualReportKeys
// @returns {{ transcriptPptMap: Map<string,{transcript_url,ppt_url}>, annualReportMap: Map<string,string> }}
async function loadExistingUrls({ transcriptPptKeys = [], annualReportKeys = [] } = {}) {
  const transcriptPptMap = new Map();
  const annualReportMap  = new Map();

  if (transcriptPptKeys.length) {
    const rows = await prisma.earnings_calls.findMany({
      where:  { OR: transcriptPptKeys.map(({ company, fiscal_year, quarter }) => ({ company, fiscal_year, quarter })) },
      select: { company: true, fiscal_year: true, quarter: true, transcript_url: true, ppt_url: true },
    });
    for (const r of rows) {
      transcriptPptMap.set(`${r.company}|${r.fiscal_year}|${r.quarter}`, { transcript_url: r.transcript_url, ppt_url: r.ppt_url });
    }
  }

  if (annualReportKeys.length) {
    const rows = await prisma.annual_reports.findMany({
      where:  { document_type: 'annual_report', OR: annualReportKeys.map(({ company, fiscal_year }) => ({ company, fiscal_year })) },
      select: { company: true, fiscal_year: true, annual_report_url: true },
    });
    // findFirst-equivalent: keep the first row seen per key, matching approveAnnualReport's semantics.
    for (const r of rows) {
      const key = `${r.company}|${r.fiscal_year}`;
      if (!annualReportMap.has(key)) annualReportMap.set(key, r.annual_report_url);
    }
  }

  return { transcriptPptMap, annualReportMap };
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
      company_name: loadIdentityMap()[company.toUpperCase()] ?? null,
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

module.exports = { suggestFiscalYearQuarter, loadCompanyTickerMap, matchCompanyTicker, loadExistingUrls, approveCandidate };
