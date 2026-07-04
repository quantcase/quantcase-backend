'use strict';

/**
 * Dynamic resolution of a CompanyGroup into a ticker list. Always computed
 * fresh from current DB state — groups are never frozen snapshots.
 *
 * filter_config is a flat set of independent filters, ANDed together
 * (chained in series) when more than one is present:
 *   nameRange:    { from, to }                                — ticker starts with a letter in [from, to]
 *   transcript:   { status?, lastN? }                         — transcript_url based
 *   ppt:          { status?, lastN? }                         — ppt_url based
 *   annualReport: { status?, lastN? }                         — annual_report_url based
 *   marketCap:    { min?, max? }                               — ₹ crore, latest known price
 *   industries:   string[]                                    — earnings_calls.basic_industry
 *
 * `status` (transcript/ppt/annualReport, default 'present'):
 *   'present'   — document exists
 *   'pending'   — document exists, no non-invalidated signal yet (L1 backlog)
 *   'extracted' — document exists AND a non-invalidated signal already exists
 *
 * `lastN` (transcript/ppt/annualReport, optional): restricts the check to
 * each company's own N most recent reporting periods (quarters for
 * transcript/ppt, fiscal years for annualReport) instead of "ever, across
 * all history". Omit for all-time.
 */

const prisma = require('../../config/prisma');
const { fetchDoneCallIds } = require('../pipelineDispatch/signalStore');

function intersect(sets) {
  if (sets.length === 0) return new Set();
  return sets.reduce((acc, s) => new Set([...acc].filter(x => s.has(x))));
}

// Groups rows by `company`, sorts each group descending by sortKeys, keeps
// only the first `n` per company. n == null returns rows unchanged.
function latestNPerCompany(rows, n, sortKeys) {
  if (!n) return rows;
  const byCompany = new Map();
  for (const r of rows) {
    if (!byCompany.has(r.company)) byCompany.set(r.company, []);
    byCompany.get(r.company).push(r);
  }
  const result = [];
  for (const list of byCompany.values()) {
    list.sort((a, b) => {
      for (const k of sortKeys) {
        if (a[k] !== b[k]) return a[k] < b[k] ? 1 : -1; // desc
      }
      return 0;
    });
    result.push(...list.slice(0, n));
  }
  return result;
}

// Shared logic for transcript/ppt: fetch calls with the given URL field
// present, window to the latest N per company if requested, then filter by
// status (present/pending/extracted).
async function docTypeFilterSet(urlField, docType, { status = 'present', lastN } = {}) {
  const rows = await prisma.earnings_calls.findMany({
    where:  { [urlField]: { not: null } },
    select: { id: true, company: true, fiscal_year: true, quarter: true },
  });
  const windowed = latestNPerCompany(rows, lastN, ['fiscal_year', 'quarter']);

  if (status === 'present') return new Set(windowed.map(r => r.company));

  const doneIds = await fetchDoneCallIds(docType, windowed.map(r => r.id));
  const keep = status === 'extracted' ? r => doneIds.has(r.id) : r => !doneIds.has(r.id);
  return new Set(windowed.filter(keep).map(r => r.company));
}

async function annualReportFilterSet({ status = 'present', lastN } = {}) {
  const rows = await prisma.annual_reports.findMany({
    where:  { annual_report_url: { not: null }, company: { not: null } },
    select: { id: true, company: true, fiscal_year: true },
  });
  const windowed = latestNPerCompany(rows, lastN, ['fiscal_year']);

  if (status === 'present') return new Set(windowed.map(r => r.company));

  const doneIds = await fetchDoneCallIds('annual_report', windowed.map(r => r.id.toString()));
  const keep = status === 'extracted' ? r => doneIds.has(r.id.toString()) : r => !doneIds.has(r.id.toString());
  return new Set(windowed.filter(keep).map(r => r.company));
}

async function getMarketCapCompanies({ min, max } = {}) {
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

async function getIndustryCompanies(industries) {
  if (!industries?.length) return new Set();
  const rows = await prisma.earnings_calls.findMany({
    where:    { basic_industry: { in: industries } },
    select:   { company: true },
    distinct: ['company'],
  });
  return new Set(rows.map(r => r.company));
}

// filter_config.nameRange — companies whose ticker symbol falls within
// [from, to] alphabetically (inclusive on both ends), e.g. {from:'A', to:'C'}
// for an "A-C" bucket. Mirrors the startFrom cursor semantics already used in
// L1 multi-dispatch (services/pipelineDispatch/l1MultiDispatch.service.js).
async function getNameRangeCompanies({ from, to } = {}) {
  const rows = await prisma.earnings_calls.findMany({
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
  if (config.nameRange)    sets.push(await getNameRangeCompanies(config.nameRange));
  if (config.transcript)   sets.push(await docTypeFilterSet('transcript_url', 'transcript', config.transcript));
  if (config.ppt)          sets.push(await docTypeFilterSet('ppt_url', 'ppt', config.ppt));
  if (config.annualReport) sets.push(await annualReportFilterSet(config.annualReport));
  if (config.marketCap)    sets.push(await getMarketCapCompanies(config.marketCap));
  if (config.industries)   sets.push(await getIndustryCompanies(config.industries));

  if (sets.length === 0) return [];
  return [...intersect(sets)].filter(Boolean).sort();
}

async function resolveGroup(group) {
  if (group.filter_type === 'manual') {
    return (group.filter_config?.tickers ?? []).filter(Boolean);
  }
  return resolveDynamic(group.filter_config ?? {});
}

// Which config_key applies to a given ticker, via whichever config-mapped
// group it currently falls into (groups are live — this is recomputed every
// call, not cached). Groups are resolved oldest-created first; if a ticker
// ends up in more than one config-mapped group at once, the first one it
// matches wins. Returns null if the ticker isn't in any config-mapped group —
// callers treat that as "run blocked, no config resolved" rather than
// silently falling back to a skill's own default fields.
async function resolveConfigKeyForTicker(ticker) {
  const groups = await prisma.companyGroup.findMany({
    where:   { config_key: { not: null } },
    orderBy: { created_at: 'asc' },
  });
  for (const group of groups) {
    const tickers = await resolveGroup(group);
    if (tickers.includes(ticker)) return group.config_key;
  }
  return null;
}

module.exports = {
  resolveGroup,
  resolveConfigKeyForTicker,
  getMarketCapCompanies,
  getIndustryCompanies,
  getNameRangeCompanies,
  docTypeFilterSet,
  annualReportFilterSet,
};
