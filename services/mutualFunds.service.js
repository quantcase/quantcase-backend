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

async function listSchemes({ page, size, category, amc_slug, plan_type } = {}) {
  const where = {};
  if (category)  where.category  = category;
  if (amc_slug)  where.amc_slug  = amc_slug;
  if (plan_type) where.plan_type = plan_type;

  const paginated = size !== undefined;
  const limit     = paginated ? Math.min(Number(size) || 50, 200) : undefined;
  const offset    = paginated ? (Math.max(Number(page) || 1, 1) - 1) * limit : undefined;

  const [total, schemes] = await Promise.all([
    prisma.mutualFundScheme.count({ where }),
    prisma.mutualFundScheme.findMany({
      where,
      orderBy: { aum: 'desc' },
      ...(paginated ? { skip: offset, take: limit } : {}),
    }),
  ]);

  return {
    total,
    ...(paginated ? { page: Math.max(Number(page) || 1, 1), size: limit } : {}),
    schemes,
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

    // Sibling plan variants (direct/regular, growth/idcw) with their expense ratios
    related_variants:  detail?.related_variants ?? [],

    // Portfolio holdings (current month, from families endpoint)
    holdings: settled(holdings),

    // Sector allocation — array of { sector, total_weight, stock_count, total_market_value }
    sectors: settled(sectors),

    // Month-over-month AUM / allocation history
    holdings_history: settled(holdingsHistory),

    // Fund managers & team
    people: settled(people),

    // Calendar-year annual returns & growth of ₹10K
    performance: settled(performance),

    // Risk: capture ratios, drawdown, analyst ratings
    risk_detail: settled(riskDetail),

    // NAV history (5Y monthly) for rolling return chart — { summary, data: [{period, open, high, low, close}] }
    nav_history: settled(navHistory),
  };
}

module.exports = { listSchemes, getSchemeDetails };
