'use strict';

const prisma = require('../config/prisma');

// KPI abbrs needed for industry-analysis and competition peer context
const PEER_ABBRS = ['REV_OP', 'EBITDA_MARGIN', 'ROCE'];

/**
 * Fetch peer KPI metrics for all tickers in the same basic_industry as callId.
 *
 * Returns a structured block ready to be injected into the L2 prompt:
 *   {
 *     industry: string,
 *     peers: [{ ticker, REV_OP, REV_OP_cagr_3y, EBITDA_MARGIN, ROCE }],
 *     industry_agg: { avg_REV_OP_cagr_3y, avg_EBITDA_MARGIN, avg_ROCE, total_REV_OP }
 *   }
 *
 * Only returns peers that have at least one of the required KPIs in prowess_values_new.
 * The subject ticker is included so the LLM can compare it against the peer set.
 */
async function fetchPeerMetrics(callId) {
  // 1. Resolve basic_industry and ticker for this call
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, basic_industry: true },
  });

  if (!call?.basic_industry) {
    console.log(`[peerMetrics] ${callId} — no basic_industry, skipping peer fetch`);
    return null;
  }

  const { company: subjectTicker, basic_industry: industry } = call;

  // 2. Find all distinct tickers in the same industry
  const peerRows = await prisma.earnings_calls.findMany({
    where:    { basic_industry: industry },
    select:   { company: true },
    distinct: ['company'],
  });
  const allTickers = peerRows.map(r => r.company);

  if (allTickers.length === 0) {
    console.log(`[peerMetrics] No tickers found for industry "${industry}"`);
    return null;
  }

  // 3. Pull the latest annual KPIs for every peer from prowess_values_new in one query
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (company, kpi_abbr)
           company, kpi_abbr, value, fiscal_year
    FROM   prowess_values_new
    WHERE  company  = ANY(${allTickers}::text[])
      AND  kpi_abbr = ANY(${PEER_ABBRS}::text[])
      AND  call_id LIKE 'prowess_new_%'
    ORDER  BY company, kpi_abbr, fiscal_year DESC, source_type ASC
  `;

  // 4. Build per-ticker kpiMap
  const tickerMap = {};
  for (const row of rows) {
    if (!tickerMap[row.company]) tickerMap[row.company] = {};
    tickerMap[row.company][row.kpi_abbr] = row.value != null ? parseFloat(row.value) : null;
  }

  // 5. Compute 3-year revenue CAGR per ticker from prowess annual time-series
  const cagrRows = await prisma.$queryRaw`
    SELECT DISTINCT ON (company, fiscal_year)
           company, fiscal_year, value
    FROM   prowess_values_new
    WHERE  company  = ANY(${allTickers}::text[])
      AND  kpi_abbr = 'REV_OP'
      AND  call_id LIKE 'prowess_new_%'
    ORDER  BY company, fiscal_year ASC, source_type ASC
  `;

  const cagrByTicker = {};
  const tickerSeries = {};
  for (const row of cagrRows) {
    if (!tickerSeries[row.company]) tickerSeries[row.company] = [];
    tickerSeries[row.company].push({ fiscal_year: row.fiscal_year, value: row.value != null ? parseFloat(row.value) : null });
  }

  for (const [ticker, series] of Object.entries(tickerSeries)) {
    const valid = series.filter(s => s.value != null && s.value > 0);
    if (valid.length < 2) { cagrByTicker[ticker] = null; continue; }
    // Use up to 3 years back
    const latest = valid.at(-1);
    const base   = valid.length >= 4 ? valid[valid.length - 4] : valid[0];
    const years  = valid.length >= 4 ? 3 : valid.length - 1;
    const cagrVal = years > 0 ? (Math.pow(latest.value / base.value, 1 / years) - 1) * 100 : null;
    cagrByTicker[ticker] = cagrVal != null ? parseFloat(cagrVal.toFixed(1)) : null;
  }

  // 6. Build peer list (only tickers with any data)
  const peers = allTickers
    .map(ticker => {
      const km = tickerMap[ticker] ?? {};
      return {
        ticker,
        is_subject:       ticker === subjectTicker,
        REV_OP:           km['REV_OP']          ?? null,
        REV_OP_cagr_3y:   cagrByTicker[ticker]  ?? null,
        EBITDA_MARGIN:    km['EBITDA_MARGIN']    ?? null,
        ROCE:             km['ROCE']             ?? null,
      };
    })
    .filter(p => p.REV_OP != null || p.EBITDA_MARGIN != null || p.ROCE != null);

  if (peers.length === 0) {
    console.log(`[peerMetrics] No peer KPI data found for industry "${industry}"`);
    return null;
  }

  // 7. Industry aggregates (all peers including subject)
  const withRev   = peers.filter(p => p.REV_OP != null);
  const withCagr  = peers.filter(p => p.REV_OP_cagr_3y != null);
  const withOpm   = peers.filter(p => p.EBITDA_MARGIN != null);
  const withRoce  = peers.filter(p => p.ROCE != null);

  const avg = (arr, key) => arr.length ? parseFloat((arr.reduce((s, p) => s + p[key], 0) / arr.length).toFixed(1)) : null;

  const industry_agg = {
    total_REV_OP:       withRev.length  ? parseFloat(withRev.reduce((s, p) => s + p.REV_OP, 0).toFixed(0)) : null,
    avg_REV_OP_cagr_3y: avg(withCagr, 'REV_OP_cagr_3y'),
    avg_EBITDA_MARGIN:  avg(withOpm,  'EBITDA_MARGIN'),
    weighted_avg_ROCE:  withRoce.length ? _weightedAvgRoce(withRoce) : null,
    peer_count:         peers.length,
  };

  console.log(`[peerMetrics] "${industry}" — ${peers.length} peers, subject=${subjectTicker}`);

  return { industry, subject_ticker: subjectTicker, peers, industry_agg };
}

function _weightedAvgRoce(peers) {
  const withBoth = peers.filter(p => p.REV_OP != null && p.ROCE != null);
  if (!withBoth.length) {
    const avg = peers.reduce((s, p) => s + p.ROCE, 0) / peers.length;
    return parseFloat(avg.toFixed(1));
  }
  const totalRev = withBoth.reduce((s, p) => s + p.REV_OP, 0);
  if (!totalRev) return null;
  const weighted = withBoth.reduce((s, p) => s + p.ROCE * (p.REV_OP / totalRev), 0);
  return parseFloat(weighted.toFixed(1));
}

/**
 * Format peer metrics as a compact text block for injection into the L2 prompt.
 */
function formatPeerMetricsBlock(pm) {
  if (!pm) return '';

  const lines = [
    '',
    `PEER CONTEXT — Industry: ${pm.industry} (${pm.industry_agg.peer_count} peers)`,
    `Industry Aggregates:`,
    `  Total Industry Revenue (REV_OP): ${pm.industry_agg.total_REV_OP != null ? pm.industry_agg.total_REV_OP + ' Cr' : 'N/A'}`,
    `  Avg 3Y Revenue CAGR: ${pm.industry_agg.avg_REV_OP_cagr_3y != null ? pm.industry_agg.avg_REV_OP_cagr_3y + '%' : 'N/A'}`,
    `  Avg Industry OPM (EBITDA_MARGIN): ${pm.industry_agg.avg_EBITDA_MARGIN != null ? pm.industry_agg.avg_EBITDA_MARGIN + '%' : 'N/A'}`,
    `  Weighted Avg Industry ROCE: ${pm.industry_agg.weighted_avg_ROCE != null ? pm.industry_agg.weighted_avg_ROCE + '%' : 'N/A'}`,
    '',
    'Peer Breakdown (ticker | REV_OP Cr | 3Y Rev CAGR | OPM% | ROCE%):',
  ];

  for (const p of pm.peers) {
    const tag = p.is_subject ? ' ← subject' : '';
    lines.push(
      `  ${p.ticker}${tag} | ` +
      `REV=${p.REV_OP != null ? p.REV_OP + ' Cr' : 'N/A'} | ` +
      `CAGR=${p.REV_OP_cagr_3y != null ? p.REV_OP_cagr_3y + '%' : 'N/A'} | ` +
      `OPM=${p.EBITDA_MARGIN != null ? p.EBITDA_MARGIN + '%' : 'N/A'} | ` +
      `ROCE=${p.ROCE != null ? p.ROCE + '%' : 'N/A'}`
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Fetch PE and market-cap from nse_equity for the subject ticker and all
 * industry peers (derived from earnings_calls.basic_industry).
 *
 * Returns the latest available row per symbol (data is monthly/yearly snapshots).
 * Industry-level averages exclude extreme outliers (PE > 200x treated as N/A).
 *
 * @param {string} callId
 * @returns {Promise<object|null>}
 */
async function fetchEquityMetrics(callId) {
  const call = await prisma.earnings_calls.findUnique({
    where:  { id: callId },
    select: { company: true, basic_industry: true },
  });
  if (!call?.basic_industry) return null;

  const { company: subjectTicker, basic_industry: industry } = call;

  // Resolve all peer tickers in the same industry
  const peerRows = await prisma.earnings_calls.findMany({
    where:    { basic_industry: industry },
    select:   { company: true },
    distinct: ['company'],
  });
  const allTickers = peerRows.map(r => r.company);

  // Latest PE + mcap per ticker from nse_equity
  const equityRows = await prisma.nse_equity.findMany({
    where:    { symbol: { in: allTickers }, pe: { not: null } },
    select:   { symbol: true, pe: true, market_cap_cr: true, datetime: true },
    orderBy:  [{ symbol: 'asc' }, { datetime: 'desc' }],
    distinct: ['symbol'],
  });

  if (equityRows.length === 0) return null;

  // Build per-ticker map
  const equityMap = {};
  for (const row of equityRows) {
    equityMap[row.symbol] = {
      pe:           row.pe   != null ? parseFloat(row.pe.toFixed(1))           : null,
      market_cap_cr: row.market_cap_cr != null ? parseFloat(row.market_cap_cr.toFixed(0)) : null,
      as_of:        row.datetime,
    };
  }

  // Industry aggregates — exclude PE > 200x (negative earnings distortion)
  const validPeRows  = equityRows.filter(r => r.pe != null && r.pe > 0 && r.pe <= 200);
  const validMcapRows = equityRows.filter(r => r.market_cap_cr != null);

  const avgPe       = validPeRows.length  ? parseFloat((validPeRows.reduce((s, r)  => s + r.pe, 0) / validPeRows.length).toFixed(1)) : null;
  const medianPe    = _median(validPeRows.map(r  => r.pe));
  const totalMcap   = validMcapRows.length ? parseFloat(validMcapRows.reduce((s, r) => s + r.market_cap_cr, 0).toFixed(0)) : null;

  const subject = equityMap[subjectTicker] ?? null;

  const peers = allTickers
    .filter(t => equityMap[t])
    .map(t => ({ ticker: t, is_subject: t === subjectTicker, ...equityMap[t] }));

  console.log(`[equityMetrics] "${industry}" — ${peers.length} peers with PE data, subject PE=${subject?.pe ?? 'N/A'}`);

  return {
    industry,
    subject_ticker: subjectTicker,
    subject,
    peers,
    industry_agg: {
      avg_pe:    avgPe,
      median_pe: medianPe,
      total_market_cap_cr: totalMcap,
      peer_count_with_pe:  validPeRows.length,
    },
  };
}

function _median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const val = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return parseFloat(val.toFixed(1));
}

/**
 * Format equity (PE + mcap) metrics as a compact text block for L2 prompt injection.
 */
function formatEquityMetricsBlock(em) {
  if (!em) return '';

  const fmt = (v, suffix = '') => v != null ? `${v}${suffix}` : 'N/A';

  const lines = [
    '',
    `EQUITY VALUATION CONTEXT — Industry: ${em.industry}`,
    `Subject (${em.subject_ticker}): PE=${fmt(em.subject?.pe, 'x')} | Market Cap=${fmt(em.subject?.market_cap_cr, ' Cr')}`,
    `Industry (${em.industry_agg.peer_count_with_pe} peers with data): Avg PE=${fmt(em.industry_agg.avg_pe, 'x')} | Median PE=${fmt(em.industry_agg.median_pe, 'x')} | Total MCap=${fmt(em.industry_agg.total_market_cap_cr, ' Cr')}`,
    '',
    'Peer PE & Market Cap:',
  ];

  for (const p of em.peers) {
    const tag = p.is_subject ? ' ← subject' : '';
    lines.push(`  ${p.ticker}${tag} | PE=${fmt(p.pe, 'x')} | MCap=${fmt(p.market_cap_cr, ' Cr')}`);
  }

  lines.push('');
  return lines.join('\n');
}

module.exports = { fetchPeerMetrics, formatPeerMetricsBlock, fetchEquityMetrics, formatEquityMetricsBlock };
