'use strict';

/**
 * Dynamic resolution of a CompanyGroup into a ticker list. Always computed
 * fresh from current DB state — groups are never frozen snapshots.
 */

const prisma = require('../../config/prisma');
const { fetchDoneCallIds } = require('../pipelineDispatch/signalStore');

function intersect(sets) {
  if (sets.length === 0) return new Set();
  return sets.reduce((acc, s) => new Set([...acc].filter(x => s.has(x))));
}

// fiscalYear/quarter accept a single value or an array (OR'd together).
// quarter is meaningless for annual reports (no quarter field) — callers
// simply don't pass it there.
function periodMatches(row, { fiscalYear, quarter } = {}) {
  if (fiscalYear != null) {
    const years = (Array.isArray(fiscalYear) ? fiscalYear : [fiscalYear]).map(String);
    if (!years.includes(row.fiscal_year)) return false;
  }
  if (quarter != null) {
    const quarters = Array.isArray(quarter) ? quarter : [quarter];
    if (!quarters.includes(row.quarter)) return false;
  }
  return true;
}

async function docTypeCoverageSet(urlField, period) {
  const rows = await prisma.earnings_calls.findMany({
    where:  { [urlField]: { not: null }, company: { not: null } },
    select: { company: true, fiscal_year: true, quarter: true },
  });
  return new Set(rows.filter(r => periodMatches(r, period)).map(r => r.company));
}

async function annualReportCoverageSet({ fiscalYear } = {}) {
  const rows = await prisma.annual_reports.findMany({
    where:  { annual_report_url: { not: null }, company: { not: null } },
    select: { company: true, fiscal_year: true },
  });
  return new Set(rows.filter(r => periodMatches(r, { fiscalYear })).map(r => r.company));
}

// Companies with a call matching urlField+period, split into those with
// (done) vs without (pending) a non-invalidated `docType` signal.
async function splitByExtraction(urlField, docType, period) {
  const rows = await prisma.earnings_calls.findMany({
    where:  { [urlField]: { not: null }, company: { not: null } },
    select: { id: true, company: true, fiscal_year: true, quarter: true },
  });
  const matched = rows.filter(r => periodMatches(r, period));
  const doneIds = await fetchDoneCallIds(docType, matched.map(r => r.id));
  return {
    done:    new Set(matched.filter(r => doneIds.has(r.id)).map(r => r.company)),
    pending: new Set(matched.filter(r => !doneIds.has(r.id)).map(r => r.company)),
  };
}

async function splitAnnualReportByExtraction({ fiscalYear } = {}) {
  const rows = await prisma.annual_reports.findMany({
    where:  { annual_report_url: { not: null }, company: { not: null } },
    select: { id: true, company: true, fiscal_year: true },
  });
  const matched = rows.filter(r => periodMatches(r, { fiscalYear }));
  const doneIds = await fetchDoneCallIds('annual_report', matched.map(r => r.id.toString()));
  return {
    done:    new Set(matched.filter(r => doneIds.has(r.id.toString())).map(r => r.company)),
    pending: new Set(matched.filter(r => !doneIds.has(r.id.toString())).map(r => r.company)),
  };
}

// filter_config.coverage — companies with these documents present (regardless
// of extraction status). Each requested doc type is checked independently and
// combined per `match` ('any' = union, 'all' = intersection) — e.g.
// {transcript:true, ppt:true, match:'all'} requires BOTH, not either.
// Optional fiscalYear/quarter scope the check to a specific period instead of
// "ever, across all history".
async function getCoverageCompanies({ transcript, ppt, annualReport, match = 'any', fiscalYear, quarter }) {
  const period = { fiscalYear, quarter };
  const sets = [];
  if (transcript)   sets.push(await docTypeCoverageSet('transcript_url', period));
  if (ppt)          sets.push(await docTypeCoverageSet('ppt_url', period));
  if (annualReport) sets.push(await annualReportCoverageSet({ fiscalYear }));

  if (sets.length === 0) return new Set();
  return match === 'all' ? intersect(sets) : new Set(sets.flatMap(s => [...s]));
}

// filter_config.pendingExtraction — same shape as `coverage`, one level
// stricter: document present but no non-invalidated signal yet (L1 backlog).
async function getPendingExtractionCompanies({ transcript, ppt, annualReport, match = 'any', fiscalYear, quarter }) {
  const period = { fiscalYear, quarter };
  const sets = [];
  if (transcript)   sets.push((await splitByExtraction('transcript_url', 'transcript', period)).pending);
  if (ppt)          sets.push((await splitByExtraction('ppt_url', 'ppt', period)).pending);
  if (annualReport) sets.push((await splitAnnualReportByExtraction({ fiscalYear })).pending);

  if (sets.length === 0) return new Set();
  return match === 'all' ? intersect(sets) : new Set(sets.flatMap(s => [...s]));
}

// filter_config.extracted — same shape as `coverage`, requiring a
// non-invalidated signal to already exist. Inverse of pendingExtraction.
async function getExtractedCompanies({ transcript, ppt, annualReport, match = 'any', fiscalYear, quarter }) {
  const period = { fiscalYear, quarter };
  const sets = [];
  if (transcript)   sets.push((await splitByExtraction('transcript_url', 'transcript', period)).done);
  if (ppt)          sets.push((await splitByExtraction('ppt_url', 'ppt', period)).done);
  if (annualReport) sets.push((await splitAnnualReportByExtraction({ fiscalYear })).done);

  if (sets.length === 0) return new Set();
  return match === 'all' ? intersect(sets) : new Set(sets.flatMap(s => [...s]));
}

async function getMarketCapCompanies({ min, max }) {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (symbol)
           symbol,
           market_cap_cr::float AS market_cap_cr
    FROM   nse_equity_new
    WHERE  market_cap_cr IS NOT NULL
    ORDER  BY symbol, datetime DESC
  `;
  return new Set(
    rows
      .filter(r => (min == null || r.market_cap_cr >= min) && (max == null || r.market_cap_cr <= max))
      .map(r => r.symbol)
  );
}

async function getIndustryCompanies({ industries }) {
  if (!industries?.length) return new Set();
  const rows = await prisma.earnings_calls.findMany({
    where:    { basic_industry: { in: industries }, company: { not: null } },
    select:   { company: true },
    distinct: ['company'],
  });
  return new Set(rows.map(r => r.company));
}

// filter_config.nameRange — companies whose ticker symbol falls within
// [from, to] alphabetically (inclusive on both ends), e.g. {from:'A', to:'C'}
// for an "A-C" bucket. Mirrors the startFrom cursor semantics already used in
// L1 multi-dispatch (services/pipelineDispatch/l1MultiDispatch.service.js).
async function getNameRangeCompanies({ from, to }) {
  const rows = await prisma.earnings_calls.findMany({
    where:    { company: { not: null } },
    select:   { company: true },
    distinct: ['company'],
  });
  const lo = from ? from.toUpperCase() : null;
  const hi = to ? to.toUpperCase() + '￿' : null; // so "C" includes "CANBK", not just "C" itself
  return new Set(
    rows
      .map(r => r.company)
      .filter(c => (!lo || c.toUpperCase() >= lo) && (!hi || c.toUpperCase() <= hi))
  );
}

async function resolveDynamic(config) {
  const sets = [];
  if (config.coverage)          sets.push(await getCoverageCompanies(config.coverage));
  if (config.pendingExtraction) sets.push(await getPendingExtractionCompanies(config.pendingExtraction));
  if (config.extracted)         sets.push(await getExtractedCompanies(config.extracted));
  if (config.marketCap)         sets.push(await getMarketCapCompanies(config.marketCap));
  if (config.industries)        sets.push(await getIndustryCompanies({ industries: config.industries }));
  if (config.nameRange)         sets.push(await getNameRangeCompanies(config.nameRange));

  if (sets.length === 0) return [];
  return [...intersect(sets)].filter(Boolean).sort();
}

async function resolveGroup(group) {
  if (group.filter_type === 'manual') {
    return (group.filter_config?.tickers ?? []).filter(Boolean);
  }
  return resolveDynamic(group.filter_config ?? {});
}

module.exports = {
  resolveGroup,
  getCoverageCompanies,
  getPendingExtractionCompanies,
  getExtractedCompanies,
  getMarketCapCompanies,
  getIndustryCompanies,
  getNameRangeCompanies,
};
