'use strict';

const prisma = require('../config/prisma');

// ── Basket definitions ────────────────────────────────────────────────────────
// Baskets are derived from the Mutual Fund Screening Framework PDF.
// Each basket maps to investor profiles, conditions drawn from DB fields:
//   category, risk_label, expense_ratio, aum, morningstar, plan_type

const BASKETS = [
  // ── Investor Fit & Allocation ─────────────────────────────────────────────
  {
    id: 'conservative-debt',
    category: 'Investor Fit',
    title: 'Conservative Debt',
    description: 'Low-risk funds for capital preservation — liquid, overnight, and short-term debt funds. Suited for investors who cannot tolerate equity volatility.',
    searchIntent: 'Safe capital parking with stable short-term returns',
    conditions: 'Category: Liquid / Overnight / Short Duration / Money Market; Risk Label: Low / Low to Moderate; AUM > ₹1,000 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'nav', 'morningstar'],
  },
  {
    id: 'balanced-hybrid',
    category: 'Investor Fit',
    title: 'Balanced Hybrid',
    description: 'Moderate-risk funds blending equity upside with debt stability. Suitable for investors seeking growth with a cushion against sharp drawdowns.',
    searchIntent: 'Growth with downside cushion via equity-debt mix',
    conditions: 'Category: Aggressive Hybrid / Balanced Advantage / Balanced Hybrid; Risk Label: Moderately High; AUM > ₹500 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'nav', 'morningstar'],
  },
  {
    id: 'high-risk-equity',
    category: 'Investor Fit',
    title: 'High Risk Equity',
    description: 'Pure equity funds across small, mid, or thematic segments. Best for investors with high risk tolerance and a 5+ year investment horizon.',
    searchIntent: 'Aggressive equity exposure for long-term wealth creation',
    conditions: 'Category: Small Cap / Mid Cap / Sectoral / Thematic; Risk Label: Very High; AUM > ₹100 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'nav', 'morningstar'],
  },

  // ── Performance & Consistency ─────────────────────────────────────────────
  {
    id: 'top-rated-large-cap',
    category: 'Performance & Consistency',
    title: 'Top-Rated Large Cap',
    description: '4–5 star rated large cap funds that have consistently outperformed peers and benchmarks. Strong risk-adjusted track record over multiple cycles.',
    searchIntent: 'Proven large cap performers with top peer ranking',
    conditions: 'Category: Large Cap; Morningstar Rating ≥ 4; Plan Type: Direct; AUM > ₹1,000 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'morningstar', 'nav'],
  },
  {
    id: 'top-rated-flexi-cap',
    category: 'Performance & Consistency',
    title: 'Top-Rated Flexi Cap',
    description: 'Highly rated flexi/multi-cap funds where managers dynamically shift across market caps. Combines diversification with consistent alpha generation.',
    searchIntent: 'Flexible mandate with top quartile consistency across cycles',
    conditions: 'Category: Flexi Cap / Multi Cap; Morningstar Rating ≥ 4; Plan Type: Direct; AUM > ₹500 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'morningstar', 'nav'],
  },
  {
    id: 'consistent-midcap',
    category: 'Performance & Consistency',
    title: 'Consistent Mid Cap',
    description: 'Mid cap funds with strong Morningstar ratings and meaningful AUM — indicating sustained institutional trust and peer outperformance.',
    searchIntent: 'Mid cap funds with proven consistency and peer rank stability',
    conditions: 'Category: Mid Cap; Morningstar Rating ≥ 3; AUM > ₹500 Cr; Risk Label: Very High',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'morningstar', 'nav'],
  },

  // ── Risk & Risk-Adjusted Returns ──────────────────────────────────────────
  {
    id: 'low-cost-index',
    category: 'Risk & Cost Efficiency',
    title: 'Low Cost Index',
    description: 'Passive index funds with ultra-low expense ratios. Ideal for investors who prefer market returns over active management risk, at minimal cost.',
    searchIntent: 'Market returns at the lowest possible cost via passive funds',
    conditions: 'Category: Index Fund / ETF; Expense Ratio < 0.3%; Plan Type: Direct; AUM > ₹500 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'nav', 'morningstar'],
  },
  {
    id: 'low-expense-active',
    category: 'Risk & Cost Efficiency',
    title: 'Low Expense Active',
    description: 'Actively managed direct plans where expense drag is minimised (<0.8%). Lower costs directly improve net returns for the investor over time.',
    searchIntent: 'Active management with minimal expense ratio drag',
    conditions: 'Plan Type: Direct; Expense Ratio < 0.8%; Category excludes Index / ETF / Liquid; AUM > ₹200 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'nav', 'morningstar'],
  },

  // ── Portfolio Construction ─────────────────────────────────────────────────
  {
    id: 'large-aum-institutional',
    category: 'Portfolio Construction',
    title: 'Large AUM Institutional',
    description: 'Well-established funds managing ₹5,000 Cr+ in AUM, reflecting institutional confidence, deep liquidity, and robust fund house governance.',
    searchIntent: 'High-conviction, large-scale funds with institutional backing',
    conditions: 'AUM > ₹5,000 Cr; Plan Type: Direct; Category: Equity or Hybrid; AUM > ₹5,000 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'morningstar', 'nav'],
  },
  {
    id: 'direct-plan-advantage',
    category: 'Portfolio Construction',
    title: 'Direct Plan Advantage',
    description: 'Direct plans across all categories — saving the distributor commission (0.5–1.5%) that compounds into significant alpha over the long run.',
    searchIntent: 'Switch from regular to direct to save commission drag',
    conditions: 'Plan Type: Direct; All categories; Morningstar Rating ≥ 3; AUM > ₹100 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'morningstar', 'nav'],
  },

  // ── Track Record & External Validation ───────────────────────────────────
  {
    id: 'five-star-all',
    category: 'Track Record & Validation',
    title: 'Five Star Rated Funds',
    description: 'Top-rated funds (5-star Morningstar) across all categories. Validated by third-party research combining risk-adjusted performance, consistency, and peer ranking.',
    searchIntent: 'Best-in-class rated funds across all categories',
    conditions: 'Morningstar Rating = 5; All categories; AUM > ₹100 Cr',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'morningstar', 'nav'],
  },
  {
    id: 'established-debt-funds',
    category: 'Track Record & Validation',
    title: 'Established Debt Funds',
    description: 'Large, well-rated debt funds across medium-to-long duration categories. Chosen for their credit quality governance and interest rate management track record.',
    searchIntent: 'Trusted debt funds with proven credit and duration management',
    conditions: 'Category: Medium Duration / Corporate Bond / Gilt / Banking and PSU; Morningstar Rating ≥ 3; AUM > ₹500 Cr; Risk Label: Moderate or Low to Moderate',
    columns: ['name', 'category', 'amc_name', 'risk_label', 'expense_ratio', 'aum', 'morningstar', 'nav'],
  },
];

// ── Category keyword maps ─────────────────────────────────────────────────────

const DEBT_SHORT_CATEGORIES = ['Liquid', 'Overnight', 'Short Duration', 'Money Market', 'Ultra Short Duration', 'Low Duration'];
const HYBRID_CATEGORIES     = ['Aggressive Hybrid', 'Balanced Advantage', 'Balanced Hybrid', 'Dynamic Asset Allocation', 'Equity Savings', 'Multi Asset Allocation'];
const HIGH_RISK_CATEGORIES  = ['Small Cap', 'Mid Cap', 'Sectoral', 'Thematic', 'Small and Mid Cap'];
const FLEXI_CATEGORIES      = ['Flexi Cap', 'Multi Cap'];
const INDEX_CATEGORIES      = ['Index Fund', 'ETF', 'Index Funds', 'Exchange Traded Fund'];
const DEBT_MEDIUM_CATEGORIES = ['Medium Duration', 'Corporate Bond', 'Gilt', 'Banking and PSU', 'Long Duration', 'Medium to Long Duration'];
const RISK_LOW              = ['Low', 'Low to Moderate'];
const RISK_MODERATE_HIGH    = ['Moderate', 'Low to Moderate'];

function categoryIn(category, keywords) {
  if (!category) return false;
  return keywords.some(k => category.toLowerCase().includes(k.toLowerCase()));
}

function riskIn(riskLabel, labels) {
  if (!riskLabel) return false;
  return labels.some(l => riskLabel.toLowerCase().includes(l.toLowerCase()));
}

// ── Screeners per basket ──────────────────────────────────────────────────────

const SCREENERS = {
  'conservative-debt': {
    where: () => ({
      aum: { gt: 1000 },
    }),
    filter: s => categoryIn(s.category, DEBT_SHORT_CATEGORIES) && riskIn(s.risk_label, RISK_LOW),
  },
  'balanced-hybrid': {
    where: () => ({
      aum: { gt: 500 },
    }),
    filter: s => categoryIn(s.category, HYBRID_CATEGORIES),
  },
  'high-risk-equity': {
    where: () => ({
      aum: { gt: 100 },
      risk_label: { in: ['Very High', 'High'] },
    }),
    filter: s => categoryIn(s.category, HIGH_RISK_CATEGORIES),
  },
  'top-rated-large-cap': {
    where: () => ({
      morningstar: { gte: 4 },
      plan_type:   'Direct',
      aum:         { gt: 1000 },
    }),
    filter: s => categoryIn(s.category, ['Large Cap']),
  },
  'top-rated-flexi-cap': {
    where: () => ({
      morningstar: { gte: 4 },
      plan_type:   'Direct',
      aum:         { gt: 500 },
    }),
    filter: s => categoryIn(s.category, FLEXI_CATEGORIES),
  },
  'consistent-midcap': {
    where: () => ({
      morningstar: { gte: 3 },
      aum:         { gt: 500 },
    }),
    filter: s => categoryIn(s.category, ['Mid Cap']),
  },
  'low-cost-index': {
    where: () => ({
      expense_ratio: { lt: 0.3 },
      plan_type:     'Direct',
      aum:           { gt: 500 },
    }),
    filter: s => categoryIn(s.category, INDEX_CATEGORIES),
  },
  'low-expense-active': {
    where: () => ({
      expense_ratio: { lt: 0.8 },
      plan_type:     'Direct',
      aum:           { gt: 200 },
    }),
    filter: s => !categoryIn(s.category, [...INDEX_CATEGORIES, ...DEBT_SHORT_CATEGORIES]),
  },
  'large-aum-institutional': {
    where: () => ({
      aum:       { gt: 5000 },
      plan_type: 'Direct',
    }),
    filter: s => categoryIn(s.category, [...['Large Cap', 'Mid Cap', 'Small Cap', 'Flexi Cap', 'Multi Cap'], ...HYBRID_CATEGORIES]),
  },
  'direct-plan-advantage': {
    where: () => ({
      plan_type:   'Direct',
      morningstar: { gte: 3 },
      aum:         { gt: 100 },
    }),
    filter: () => true,
  },
  'five-star-all': {
    where: () => ({
      morningstar: 5,
      aum:         { gt: 100 },
    }),
    filter: () => true,
  },
  'established-debt-funds': {
    where: () => ({
      morningstar: { gte: 3 },
      aum:         { gt: 500 },
    }),
    filter: s => categoryIn(s.category, DEBT_MEDIUM_CATEGORIES) && riskIn(s.risk_label, RISK_MODERATE_HIGH),
  },
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/mutual-funds/baskets
 * Returns all basket definitions (no scheme data).
 */
function getMFBaskets(req, res) {
  const grouped = {};
  for (const basket of BASKETS) {
    if (!grouped[basket.category]) grouped[basket.category] = [];
    grouped[basket.category].push({
      id:          basket.id,
      title:       basket.title,
      description: basket.description,
      searchIntent: basket.searchIntent,
      conditions:  basket.conditions,
      columns:     basket.columns,
    });
  }

  res.json({
    baskets: BASKETS.map(b => ({
      id:          b.id,
      category:    b.category,
      title:       b.title,
      description: b.description,
      searchIntent: b.searchIntent,
      conditions:  b.conditions,
      columns:     b.columns,
    })),
    grouped,
  });
}

/**
 * GET /api/mutual-funds/baskets/:basketId/schemes
 * Runs the screen for the requested basket and returns matching schemes.
 * Query params:
 *   page  (default 1)
 *   size  (default 50, max 200)
 *   sort  (column name, default 'aum')
 *   order ('asc' | 'desc', default 'desc')
 */
async function getMFBasketSchemes(req, res) {
  const { basketId } = req.params;
  const basket = BASKETS.find(b => b.id === basketId);
  if (!basket) {
    return res.status(404).json({ error: `Basket '${basketId}' not found` });
  }

  const screener = SCREENERS[basketId];
  if (!screener) {
    return res.status(501).json({ error: `Screener for '${basketId}' not implemented` });
  }

  const ALLOWED_SORT = new Set(['aum', 'expense_ratio', 'morningstar', 'nav', 'nav_date', 'name']);
  const sortField = ALLOWED_SORT.has(req.query.sort) ? req.query.sort : 'aum';
  const order     = req.query.order === 'asc' ? 'asc' : 'desc';

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(200, Math.max(1, parseInt(req.query.size) || 50));

  const where = screener.where();

  // Fetch enough candidates from DB then apply JS-level filter (for LIKE-style category checks)
  const candidates = await prisma.mutualFundScheme.findMany({
    where,
    orderBy: { [sortField]: order },
  });

  const filtered = candidates.filter(screener.filter);

  // Pagination on filtered results
  const total  = filtered.length;
  const start  = (page - 1) * size;
  const items  = filtered.slice(start, start + size);

  res.json({
    basket: {
      id:          basket.id,
      category:    basket.category,
      title:       basket.title,
      description: basket.description,
      conditions:  basket.conditions,
      columns:     basket.columns,
    },
    pagination: { page, size, total, pages: Math.ceil(total / size) },
    schemes: items,
  });
}

module.exports = { getMFBaskets, getMFBasketSchemes };
