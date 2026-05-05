'use strict';

const https = require('https');
const prisma = require('../config/prisma');

const MF_BASE = 'https://mfdata.in/api/v1';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'quantcase-backend' } }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
  });
}

function settled(result) {
  return result.status === 'fulfilled' ? result.value?.data ?? null : null;
}

const ALLOWED_SORT = new Set(['aum', 'expense_ratio', 'morningstar', 'name', 'nav']);

async function listSchemes({ page, size, q, category, risk, rating, amc_slug, plan_type, sort, order } = {}) {
  const where = {};

  if (q) {
    where.name = { contains: q, mode: 'insensitive' };
  }

  // category and risk support comma-separated multi-values
  if (category) {
    const cats = category.split(',').map(s => s.trim()).filter(Boolean);
    where.category = cats.length === 1 ? cats[0] : { in: cats };
  }

  if (risk) {
    const risks = risk.split(',').map(s => s.trim()).filter(Boolean);
    where.risk_label = risks.length === 1 ? risks[0] : { in: risks };
  }

  if (rating) {
    where.morningstar = { gte: Number(rating) };
  }

  if (amc_slug)  where.amc_slug  = amc_slug;
  if (plan_type) where.plan_type = plan_type;

  const sortField = ALLOWED_SORT.has(sort) ? sort : 'aum';
  const sortOrder = order === 'asc' ? 'asc' : 'desc';

  const limit  = Math.min(Number(size) || 50, 200);
  const pageNo = Math.max(Number(page) || 1, 1);
  const offset = (pageNo - 1) * limit;

  const orderBy = sortField === 'morningstar'
    ? { morningstar: { sort: sortOrder, nulls: sortOrder === 'asc' ? 'first' : 'last' } }
    : { [sortField]: sortOrder };

  const [total, schemes] = await Promise.all([
    prisma.mutualFundScheme.count({ where }),
    prisma.mutualFundScheme.findMany({
      where,
      orderBy,
      skip: offset,
      take: limit,
    }),
  ]);

  return { total, page: pageNo, size: limit, schemes };
}

async function getFilterOptions() {
  const [categories, risks, amcs, planTypes] = await Promise.all([
    prisma.mutualFundScheme.findMany({
      where:    { category: { not: null } },
      select:   { category: true },
      distinct: ['category'],
      orderBy:  { category: 'asc' },
    }),
    prisma.mutualFundScheme.findMany({
      where:    { risk_label: { not: null } },
      select:   { risk_label: true },
      distinct: ['risk_label'],
    }),
    prisma.mutualFundScheme.findMany({
      where:    { amc_slug: { not: null }, amc_name: { not: null } },
      select:   { amc_slug: true, amc_name: true },
      distinct: ['amc_slug'],
      orderBy:  { amc_name: 'asc' },
    }),
    prisma.mutualFundScheme.findMany({
      where:    { plan_type: { not: null } },
      select:   { plan_type: true },
      distinct: ['plan_type'],
    }),
  ]);

  // Sort risk labels by severity
  const riskOrder = ['Low Risk', 'Low to Moderate Risk', 'Moderate Risk', 'Moderately High risk', 'High Risk', 'Very High Risk'];
  const sortedRisks = risks
    .map(r => r.risk_label)
    .sort((a, b) => {
      const ai = riskOrder.indexOf(a);
      const bi = riskOrder.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  return {
    categories: categories.map(c => c.category),
    risks:      sortedRisks,
    amcs:       amcs.map(a => ({ slug: a.amc_slug, name: a.amc_name })),
    plan_types: planTypes.map(p => p.plan_type),
  };
}

async function getSchemeDetails(amfi_code) {
  const scheme = await prisma.mutualFundScheme.findUnique({ where: { amfi_code: String(amfi_code) } });
  if (!scheme) return null;

  const fid = scheme.family_id;

  const [
    schemeDetail,
    holdings,
    navHistory,
    sectors,
    holdingsHistory,
    people,
    performance,
    riskDetail,
  ] = await Promise.allSettled([
    fetchJson(`${MF_BASE}/schemes/${amfi_code}`),
    fid ? fetchJson(`${MF_BASE}/families/${fid}/holdings`)          : Promise.resolve(null),
    fetchJson(`${MF_BASE}/schemes/${amfi_code}/nav/history?period=5y&group_by=monthly&order=asc`),
    fid ? fetchJson(`${MF_BASE}/families/${fid}/sectors`)           : Promise.resolve(null),
    fid ? fetchJson(`${MF_BASE}/families/${fid}/holdings/history`)  : Promise.resolve(null),
    fid ? fetchJson(`${MF_BASE}/families/${fid}/people`)            : Promise.resolve(null),
    fid ? fetchJson(`${MF_BASE}/families/${fid}/performance`)       : Promise.resolve(null),
    fid ? fetchJson(`${MF_BASE}/families/${fid}/risk-detail`)       : Promise.resolve(null),
  ]);

  const detail = schemeDetail.status === 'fulfilled' ? schemeDetail.value?.data : null;

  return {
    // Identity
    amfi_code:      scheme.amfi_code,
    name:           scheme.name,
    isin:           scheme.isin,
    plan_type:      scheme.plan_type,
    option_type:    scheme.option_type,
    category:       scheme.category,
    amc_name:       scheme.amc_name,
    amc_slug:       scheme.amc_slug,
    family_name:    scheme.family_name,
    family_id:      scheme.family_id,

    // Live scalar fields (fallback to DB snapshot if API call fails)
    nav:            detail?.nav            ?? scheme.nav,
    nav_date:       detail?.nav_date       ?? scheme.nav_date,
    day_change:     detail?.day_change     ?? scheme.day_change,
    day_change_pct: detail?.day_change_pct ?? scheme.day_change_pct,
    expense_ratio:  detail?.expense_ratio  ?? scheme.expense_ratio,
    aum:            detail?.aum            ?? scheme.aum,
    risk_label:     detail?.risk_label     ?? scheme.risk_label,
    morningstar:    detail?.morningstar    ?? scheme.morningstar,

    // Returns from DB
    returns_1y:     scheme.returns_1y,
    returns_3y:     scheme.returns_3y,
    returns_5y:     scheme.returns_5y,

    // Costs & investment minimums
    min_sip:        detail?.min_sip        ?? null,
    min_lumpsum:    detail?.min_lumpsum    ?? null,
    min_additional: detail?.min_additional ?? null,
    exit_load:      detail?.exit_load      ?? null,

    // Fund metadata
    benchmark:      detail?.benchmark   ?? null,
    launch_date:    detail?.launch_date ?? null,
    is_active:      detail?.is_active   ?? null,

    // Returns & ratios (from base scheme endpoint)
    returns:           detail?.returns          ?? null,
    ratios:            detail?.ratios           ?? null,

    // Sibling plan variants
    related_variants:  detail?.related_variants ?? [],

    // Portfolio holdings (current month)
    holdings: settled(holdings),

    // Sector allocation
    sectors: settled(sectors),

    // Month-over-month AUM / allocation history
    holdings_history: settled(holdingsHistory),

    // Fund managers & team
    people: settled(people),

    // Calendar-year annual returns
    performance: settled(performance),

    // Risk: capture ratios, drawdown, analyst ratings
    risk_detail: settled(riskDetail),

    // NAV history (5Y monthly) for charts
    nav_history: settled(navHistory),
  };
}

module.exports = { listSchemes, getFilterOptions, getSchemeDetails };
