'use strict';

/**
 * Dynamic resolution of a CompanyGroup into a ticker list. Always computed
 * fresh from current DB state — groups are never frozen snapshots.
 *
 * filter_config is a flat set of independent filters, ANDed together
 * (chained in series) when more than one is present:
 *   nameRange:    { from, to }                                — ticker starts with a letter in [from, to]
 *   transcript:   { status?, window?, minCount? }             — transcript_url based
 *   ppt:          { status?, window?, minCount? }              — ppt_url based
 *   annualReport: { status?, lastN? }                         — annual_report_url based (window/minCount not yet supported here)
 *   marketCap:    { min?, max? }                               — ₹ crore, latest known price
 *   industries:   string[]                                    — earnings_calls.basic_industry
 *
 * `status` (transcript/ppt/annualReport, default 'present'):
 *   'present'   — document exists
 *   'pending'   — document exists, no non-invalidated signal yet (L1 backlog)
 *   'extracted' — document exists AND a non-invalidated signal already exists
 *
 * `window` (transcript/ppt, optional): instead of checking "ever, across all
 * history", look only at the company's own N most recent *known reporting
 * periods* (quarters), whether or not the document actually exists for each
 * one. Omit for all-time.
 *
 * `minCount` (transcript/ppt, optional): how many periods within `window`
 * (or across all history, if `window` is omitted) must satisfy `status`.
 * Defaults to `window` itself when `window` is set (i.e. "every one of
 * them" — the "N consecutive quarters" case), or to 1 when `window` is
 * omitted (i.e. "at least once, ever" — the old default behavior).
 *
 * This one shape covers all of:
 *   - "8 consecutive quarters with a transcript present":  { status:'present',   window:8 }
 *   - "8 consecutive quarters with a signal extracted":    { status:'extracted', window:8 }
 *   - "at least 4 of the latest 8 quarters extracted":     { status:'extracted', window:8, minCount:4 }
 *   - "at least 4 quarters ever extracted (no window)":    { status:'extracted', minCount:4 }
 *
 * `rules` (transcript/ppt, optional): array of `{ window?, minCount? }`
 * clauses, ANDed together, for compound conditions the single-pair shape
 * above can't express. `{ window, minCount }` at the top level is just
 * sugar for `rules: [{ window, minCount }]` — a single clause — so this is
 * fully backward compatible; nothing existing changes shape.
 *   - "at least 4 of the last 8 quarters, AND at least 6 ever" (i.e. at
 *     least 2 more outside that recent window):
 *       { status:'extracted', rules: [{ window:8, minCount:4 }, { minCount:6 }] }
 *     No separate "outside the window" primitive is needed — the second
 *     rule is scoped to all history (a superset of the first rule's
 *     window), so once the first rule caps at 4 within the last 8, the
 *     second rule's threshold of 6 can only be reached with periods
 *     outside that window.
 *
 * The key distinction from the old `lastN` behavior: the window is built
 * from *every* known reporting period for the company (so a quarter with no
 * transcript still occupies a window slot and breaks a "consecutive"
 * streak), not just the periods where the document happens to already
 * exist. `annualReport` still uses the old `lastN` (existence-filtered
 * window) semantics for now — to be reworked the same way separately.
 */

const prisma = require('../../config/prisma');
const { fetchDoneCallIds } = require('../pipelineDispatch/signalStore');

function intersect(sets) {
  if (sets.length === 0) return new Set();
  return sets.reduce((acc, s) => new Set([...acc].filter(x => s.has(x))));
}

// Groups rows by `company`, sorts each group descending by sortKeys, keeps
// only the first `n` per company. n == null returns rows unchanged.
function windowPerCompany(rows, n, sortKeys) {
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

// Shared logic for transcript/ppt: window each company's own known reporting
// periods (regardless of doc status — a period with no doc still occupies a
// window slot), then keep companies where at least `minCount` of those
// periods satisfy `status` (present/pending/extracted) — evaluated once per
// `rules` clause and ANDed across clauses. See the module-level comment for
// the full shape and worked examples.
async function docTypeFilterSet(urlField, docType, { status = 'present', window, minCount, rules } = {}) {
  const ruleList = rules?.length ? rules : [{ window, minCount }];

  const rows = await prisma.earnings_calls.findMany({
    select: { id: true, company: true, fiscal_year: true, quarter: true, [urlField]: true },
  });
  const windowedSets = ruleList.map(rule => windowPerCompany(rows, rule.window, ['fiscal_year', 'quarter']));

  let satisfies;
  if (status === 'present') {
    satisfies = r => r[urlField] != null;
  } else {
    // Scope the signal lookup to the union of every rule's windowed rows
    // that actually have the doc — a period with no url can never have a
    // signal, so there's no point asking the DB about it (keeps this query
    // the same bounded size it was before window/minCount existed).
    const candidateIds = new Set();
    for (const ws of windowedSets) {
      for (const r of ws) if (r[urlField] != null) candidateIds.add(r.id);
    }
    const doneIds = await fetchDoneCallIds(docType, [...candidateIds]);
    satisfies = status === 'extracted'
      ? r => r[urlField] != null && doneIds.has(r.id)
      : r => r[urlField] != null && !doneIds.has(r.id); // pending
  }

  const ruleSets = ruleList.map((rule, i) => {
    const threshold = rule.minCount ?? (rule.window || 1);
    const counts = new Map();
    for (const r of windowedSets[i]) {
      if (satisfies(r)) counts.set(r.company, (counts.get(r.company) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, n]) => n >= threshold).map(([c]) => c));
  });

  return intersect(ruleSets);
}

async function annualReportFilterSet({ status = 'present', lastN } = {}) {
  const rows = await prisma.annual_reports.findMany({
    where:  { annual_report_url: { not: null }, company: { not: null } },
    select: { id: true, company: true, fiscal_year: true },
  });
  const windowed = windowPerCompany(rows, lastN, ['fiscal_year']);

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
