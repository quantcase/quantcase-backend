'use strict';

const prisma = require('../config/prisma');
const { resolveProwess } = require('../utils/prowessResolver');
const { isBFSI } = require('../utils/industryClassifier');

// KPI abbrs needed for industry-analysis and competition peer context
// EBITDA_MARGIN is not stored — fetch its components (PBT, FIN_COST, DEP_AMORT) to derive it
const PEER_ABBRS = ['REV_OP', 'EBITDA_MARGIN', 'ROCE', 'EPS_DILUTED', 'EPS_BASIC', 'DE', 'PBT', 'FIN_COST', 'DEP_AMORT'];

// Additional BFSI-specific KPI abbrs
// NIM stored as NIM_PCT; LOAN_ADVANCES stored as LOAN_ADV_TOTAL; AUM stored as AUM_TOTAL; ROA derived from PAT/TOTAL_ASSETS
// GNPA_RATIO, CASA_RATIO, DEPOSITS not in prowess schema — will be N/A
const BFSI_PEER_ABBRS = ['NIM_PCT', 'AUM_TOTAL', 'GNPA_RATIO', 'CASA_RATIO', 'DEPOSITS', 'TOTAL_INCOME', 'PAT', 'TOTAL_ASSETS', 'LOAN_ADV_TOTAL'];

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

  // 2b. Resolve NSE tickers → prowess company names for prowess_values_new lookup
  const tickerToProwess = {};
  for (const ticker of allTickers) {
    const resolved = resolveProwess(ticker);
    if (resolved) tickerToProwess[ticker] = resolved.prowessName;
  }
  const prowessNames = Object.values(tickerToProwess);
  // Inverse map: prowess name → NSE ticker
  const prowessToTicker = Object.fromEntries(
    Object.entries(tickerToProwess).map(([t, p]) => [p, t])
  );

  if (prowessNames.length === 0) {
    console.log(`[peerMetrics] No prowess mappings found for industry "${industry}"`);
    return null;
  }

  const isBfsiIndustry = isBFSI(industry);
  const abbrsToFetch = isBfsiIndustry ? [...PEER_ABBRS, ...BFSI_PEER_ABBRS] : PEER_ABBRS;

  // 3. Pull the latest annual KPIs for every peer from prowess_values_new in one query
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (company, kpi_abbr)
           company, kpi_abbr, value, fiscal_year
    FROM   prowess_values_new
    WHERE  company  = ANY(${prowessNames}::text[])
      AND  kpi_abbr = ANY(${abbrsToFetch}::text[])
      AND  call_id LIKE 'prowess_new_%'
    ORDER  BY company, kpi_abbr, fiscal_year DESC, source_type ASC
  `;

  // 3b. For BFSI: AUM_TOTAL is only in quarterly data — fetch it separately
  const qtrRows = isBfsiIndustry ? await prisma.$queryRaw`
    SELECT DISTINCT ON (company, kpi_abbr)
           company, kpi_abbr, value, fiscal_year
    FROM   prowess_values_new
    WHERE  company  = ANY(${prowessNames}::text[])
      AND  kpi_abbr = 'AUM_TOTAL'
      AND  call_id LIKE 'prowess_qtr_%'
    ORDER  BY company, kpi_abbr, fiscal_year DESC, quarter DESC
  ` : [];

  // 4. Build per-ticker kpiMap (keyed by NSE ticker)
  const tickerMap = {};
  for (const row of [...rows, ...qtrRows]) {
    const ticker = prowessToTicker[row.company] ?? row.company;
    if (!tickerMap[ticker]) tickerMap[ticker] = {};
    // Annual rows take precedence; only fill if not already set
    if (tickerMap[ticker][row.kpi_abbr] == null) {
      tickerMap[ticker][row.kpi_abbr] = row.value != null ? parseFloat(row.value) : null;
    }
  }

  // Derive computed metrics where not stored
  for (const km of Object.values(tickerMap)) {
    // EBITDA_MARGIN = (PBT + FIN_COST + DEP_AMORT) / REV_OP * 100
    if (km['EBITDA_MARGIN'] == null && km['PBT'] != null && km['FIN_COST'] != null && km['DEP_AMORT'] != null && km['REV_OP']) {
      km['EBITDA_MARGIN'] = parseFloat(((km['PBT'] + km['FIN_COST'] + km['DEP_AMORT']) / km['REV_OP'] * 100).toFixed(2));
    }
    // ROA = PAT / TOTAL_ASSETS * 100
    if (km['ROA'] == null && km['PAT'] != null && km['TOTAL_ASSETS']) {
      km['ROA'] = parseFloat((km['PAT'] / km['TOTAL_ASSETS'] * 100).toFixed(2));
    }
  }

  // 5. Compute 3-year revenue CAGR per ticker from prowess annual time-series
  const cagrRows = await prisma.$queryRaw`
    SELECT DISTINCT ON (company, fiscal_year)
           company, fiscal_year, value
    FROM   prowess_values_new
    WHERE  company  = ANY(${prowessNames}::text[])
      AND  kpi_abbr = 'REV_OP'
      AND  call_id LIKE 'prowess_new_%'
    ORDER  BY company, fiscal_year ASC, source_type ASC
  `;

  const cagrByTicker = {};
  const tickerSeries = {};
  for (const row of cagrRows) {
    const ticker = prowessToTicker[row.company] ?? row.company;
    if (!tickerSeries[ticker]) tickerSeries[ticker] = [];
    tickerSeries[ticker].push({ fiscal_year: row.fiscal_year, value: row.value != null ? parseFloat(row.value) : null });
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
      const km  = tickerMap[ticker] ?? {};
      // Prefer EPS_DILUTED; fall back to EPS_BASIC
      const eps = km['EPS_DILUTED'] ?? km['EPS_BASIC'] ?? null;
      const base = {
        ticker,
        is_subject:       ticker === subjectTicker,
        REV_OP:           km['REV_OP']       ?? null,
        REV_OP_cagr_3y:   cagrByTicker[ticker] ?? null,
        EBITDA_MARGIN:    km['EBITDA_MARGIN'] ?? null,
        ROCE:             km['ROCE']          ?? null,
        DE:               km['DE']            ?? null,
        EPS:              eps,
      };
      if (isBfsiIndustry) {
        base.NIM          = km['NIM_PCT']       ?? null;
        base.ROA          = km['ROA']           ?? null;
        base.AUM          = km['AUM_TOTAL']     ?? null;
        base.GNPA_RATIO   = km['GNPA_RATIO']    ?? null;
        base.CASA_RATIO   = km['CASA_RATIO']    ?? null;
        base.LOAN_ADVANCES= km['LOAN_ADV_TOTAL']?? null;
        base.DEPOSITS     = km['DEPOSITS']      ?? null;
        base.TOTAL_INCOME = km['TOTAL_INCOME']  ?? null;
      }
      return base;
    })
    .filter(p => p.REV_OP != null || p.EBITDA_MARGIN != null || p.ROCE != null || p.NIM != null || p.ROA != null);

  if (peers.length === 0) {
    console.log(`[peerMetrics] No peer KPI data found for industry "${industry}"`);
    return null;
  }

  // 7. Industry aggregates (all peers including subject)
  const withRev   = peers.filter(p => p.REV_OP != null);
  const withCagr  = peers.filter(p => p.REV_OP_cagr_3y != null);
  const withOpm   = peers.filter(p => p.EBITDA_MARGIN != null);
  const withRoce  = peers.filter(p => p.ROCE != null);
  const withDe    = peers.filter(p => p.DE != null);
  const withEps   = peers.filter(p => p.EPS != null);

  const avg = (arr, key) => arr.length ? parseFloat((arr.reduce((s, p) => s + p[key], 0) / arr.length).toFixed(2)) : null;

  const industry_agg = {
    total_REV_OP:       withRev.length  ? parseFloat(withRev.reduce((s, p) => s + p.REV_OP, 0).toFixed(0)) : null,
    avg_REV_OP_cagr_3y: avg(withCagr, 'REV_OP_cagr_3y'),
    avg_EBITDA_MARGIN:  avg(withOpm,  'EBITDA_MARGIN'),
    weighted_avg_ROCE:  withRoce.length ? _weightedAvgRoce(withRoce) : null,
    avg_DE:             avg(withDe,   'DE'),
    avg_EPS:            avg(withEps,  'EPS'),
    peer_count:         peers.length,
  };

  if (isBfsiIndustry) {
    const withNim  = peers.filter(p => p.NIM  != null);
    const withRoa  = peers.filter(p => p.ROA  != null);
    const withAum  = peers.filter(p => p.AUM  != null);
    const withGnpa = peers.filter(p => p.GNPA_RATIO != null);
    const withCasa = peers.filter(p => p.CASA_RATIO != null);
    const withLoans= peers.filter(p => p.LOAN_ADVANCES != null);
    const withDeps = peers.filter(p => p.DEPOSITS != null);
    const withTotalIncome = peers.filter(p => p.TOTAL_INCOME != null);
    industry_agg.avg_NIM          = avg(withNim,  'NIM');
    industry_agg.avg_ROA          = avg(withRoa,  'ROA');
    industry_agg.total_AUM        = withAum.length  ? parseFloat(withAum.reduce((s, p) => s + p.AUM, 0).toFixed(0)) : null;
    industry_agg.avg_GNPA_RATIO   = avg(withGnpa, 'GNPA_RATIO');
    industry_agg.avg_CASA_RATIO   = avg(withCasa, 'CASA_RATIO');
    industry_agg.total_LOAN_ADVANCES = withLoans.length ? parseFloat(withLoans.reduce((s, p) => s + p.LOAN_ADVANCES, 0).toFixed(0)) : null;
    industry_agg.total_DEPOSITS   = withDeps.length  ? parseFloat(withDeps.reduce((s, p) => s + p.DEPOSITS, 0).toFixed(0)) : null;
    industry_agg.total_TOTAL_INCOME = withTotalIncome.length ? parseFloat(withTotalIncome.reduce((s, p) => s + p.TOTAL_INCOME, 0).toFixed(0)) : null;
  }

  console.log(`[peerMetrics] "${industry}" — ${peers.length} peers, subject=${subjectTicker}${isBfsiIndustry ? ' (BFSI)' : ''}`);

  return { industry, is_bfsi: isBfsiIndustry, subject_ticker: subjectTicker, peers, industry_agg };
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
 * For BFSI industries, shows NIM, ROA, AUM, GNPA, CASA instead of OPM/ROCE/D/E.
 */
function formatPeerMetricsBlock(pm) {
  if (!pm) return '';

  const lines = [
    '',
    `PEER CONTEXT — Industry: ${pm.industry} (${pm.industry_agg.peer_count} peers)${pm.is_bfsi ? ' [BFSI]' : ''}`,
    `Industry Aggregates:`,
  ];

  if (pm.is_bfsi) {
    lines.push(`  Avg Industry NIM: ${pm.industry_agg.avg_NIM != null ? pm.industry_agg.avg_NIM + '%' : 'N/A'}`);
    lines.push(`  Avg Industry ROA: ${pm.industry_agg.avg_ROA != null ? pm.industry_agg.avg_ROA + '%' : 'N/A'}`);
    lines.push(`  Total Industry AUM: ${pm.industry_agg.total_AUM != null ? pm.industry_agg.total_AUM + ' Cr' : 'N/A'}`);
    lines.push(`  Avg Industry GNPA Ratio: ${pm.industry_agg.avg_GNPA_RATIO != null ? pm.industry_agg.avg_GNPA_RATIO + '%' : 'N/A'}`);
    lines.push(`  Avg Industry CASA Ratio: ${pm.industry_agg.avg_CASA_RATIO != null ? pm.industry_agg.avg_CASA_RATIO + '%' : 'N/A'}`);
    lines.push(`  Total Industry Loan/Advances: ${pm.industry_agg.total_LOAN_ADVANCES != null ? pm.industry_agg.total_LOAN_ADVANCES + ' Cr' : 'N/A'}`);
    lines.push(`  Total Industry Deposits: ${pm.industry_agg.total_DEPOSITS != null ? pm.industry_agg.total_DEPOSITS + ' Cr' : 'N/A'}`);
    lines.push(`  Total Industry Income: ${pm.industry_agg.total_TOTAL_INCOME != null ? pm.industry_agg.total_TOTAL_INCOME + ' Cr' : 'N/A'}`);
    lines.push(`  Avg 3Y Revenue CAGR: ${pm.industry_agg.avg_REV_OP_cagr_3y != null ? pm.industry_agg.avg_REV_OP_cagr_3y + '%' : 'N/A'}`);
    lines.push(`  Avg Industry EPS: ${pm.industry_agg.avg_EPS != null ? '₹' + pm.industry_agg.avg_EPS : 'N/A'}`);
    lines.push('');
    lines.push('Peer Breakdown (ticker | Total Income Cr | NIM% | ROA% | AUM Cr | GNPA% | CASA% | 3Y CAGR | EPS):');
    for (const p of pm.peers) {
      const tag = p.is_subject ? ' ← subject' : '';
      lines.push(
        `  ${p.ticker}${tag} | ` +
        `INCOME=${p.TOTAL_INCOME != null ? p.TOTAL_INCOME + ' Cr' : 'N/A'} | ` +
        `NIM=${p.NIM != null ? p.NIM + '%' : 'N/A'} | ` +
        `ROA=${p.ROA != null ? p.ROA + '%' : 'N/A'} | ` +
        `AUM=${p.AUM != null ? p.AUM + ' Cr' : 'N/A'} | ` +
        `GNPA=${p.GNPA_RATIO != null ? p.GNPA_RATIO + '%' : 'N/A'} | ` +
        `CASA=${p.CASA_RATIO != null ? p.CASA_RATIO + '%' : 'N/A'} | ` +
        `CAGR=${p.REV_OP_cagr_3y != null ? p.REV_OP_cagr_3y + '%' : 'N/A'} | ` +
        `EPS=${p.EPS != null ? '₹' + p.EPS : 'N/A'}`
      );
    }
  } else {
    lines.push(`  Total Industry Revenue (REV_OP): ${pm.industry_agg.total_REV_OP != null ? pm.industry_agg.total_REV_OP + ' Cr' : 'N/A'}`);
    lines.push(`  Avg 3Y Revenue CAGR: ${pm.industry_agg.avg_REV_OP_cagr_3y != null ? pm.industry_agg.avg_REV_OP_cagr_3y + '%' : 'N/A'}`);
    lines.push(`  Avg Industry OPM (EBITDA_MARGIN): ${pm.industry_agg.avg_EBITDA_MARGIN != null ? pm.industry_agg.avg_EBITDA_MARGIN + '%' : 'N/A'}`);
    lines.push(`  Weighted Avg Industry ROCE: ${pm.industry_agg.weighted_avg_ROCE != null ? pm.industry_agg.weighted_avg_ROCE + '%' : 'N/A'}`);
    lines.push(`  Avg Industry D/E: ${pm.industry_agg.avg_DE != null ? pm.industry_agg.avg_DE : 'N/A'}`);
    lines.push(`  Avg Industry EPS: ${pm.industry_agg.avg_EPS != null ? '₹' + pm.industry_agg.avg_EPS : 'N/A'}`);
    lines.push('');
    lines.push('Peer Breakdown (ticker | REV_OP Cr | 3Y Rev CAGR | OPM% | ROCE% | D/E | EPS):');
    for (const p of pm.peers) {
      const tag = p.is_subject ? ' ← subject' : '';
      lines.push(
        `  ${p.ticker}${tag} | ` +
        `REV=${p.REV_OP != null ? p.REV_OP + ' Cr' : 'N/A'} | ` +
        `CAGR=${p.REV_OP_cagr_3y != null ? p.REV_OP_cagr_3y + '%' : 'N/A'} | ` +
        `OPM=${p.EBITDA_MARGIN != null ? p.EBITDA_MARGIN + '%' : 'N/A'} | ` +
        `ROCE=${p.ROCE != null ? p.ROCE + '%' : 'N/A'} | ` +
        `DE=${p.DE != null ? p.DE : 'N/A'} | ` +
        `EPS=${p.EPS != null ? '₹' + p.EPS : 'N/A'}`
      );
    }
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

  // Latest PE + EPS + close per ticker from nse_equity_new (has both PE and TTM EPS, weekly updated)
  const escaped = allTickers.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  const equityRows = allTickers.length > 0
    ? await prisma.$queryRawUnsafe(`
        SELECT DISTINCT ON (symbol)
               symbol,
               pe::float           AS pe,
               eps::float          AS eps,
               close::float        AS close,
               market_cap_cr::float AS market_cap_cr,
               datetime            AS as_of
        FROM   nse_equity_new
        WHERE  symbol = ANY(ARRAY[${escaped}])
          AND  pe IS NOT NULL
        ORDER  BY symbol, datetime DESC
      `)
    : [];

  if (equityRows.length === 0) return null;

  // Build per-ticker map
  const equityMap = {};
  for (const row of equityRows) {
    equityMap[row.symbol] = {
      pe:            row.pe            != null ? parseFloat(row.pe.toFixed(1))            : null,
      eps:           row.eps           != null ? parseFloat(row.eps.toFixed(2))           : null,
      market_cap_cr: row.market_cap_cr != null ? parseFloat(row.market_cap_cr.toFixed(0)) : null,
      close:         row.close         != null ? parseFloat(row.close.toFixed(2))         : null,
      as_of:         row.as_of,
    };
  }

  // Industry aggregates — exclude PE > 200x (negative earnings distortion)
  const validPeRows   = equityRows.filter(r => r.pe != null && r.pe > 0 && r.pe <= 200);
  const validMcapRows = equityRows.filter(r => r.market_cap_cr != null);
  const validEpsRows  = equityRows.filter(r => r.eps != null);

  const avgPe     = validPeRows.length   ? parseFloat((validPeRows.reduce((s, r)  => s + r.pe, 0)  / validPeRows.length).toFixed(1))  : null;
  const medianPe  = _median(validPeRows.map(r => r.pe));
  const totalMcap = validMcapRows.length ? parseFloat(validMcapRows.reduce((s, r) => s + r.market_cap_cr, 0).toFixed(0)) : null;
  const avgEps    = validEpsRows.length  ? parseFloat((validEpsRows.reduce((s, r) => s + r.eps, 0) / validEpsRows.length).toFixed(1)) : null;
  const medianEps = _median(validEpsRows.map(r => r.eps));

  const subject = equityMap[subjectTicker] ?? null;

  const peers = allTickers
    .filter(t => equityMap[t])
    .map(t => ({ ticker: t, is_subject: t === subjectTicker, ...equityMap[t] }));

  console.log(`[equityMetrics] "${industry}" — ${peers.length} peers, subject PE=${subject?.pe ?? 'N/A'} EPS=${subject?.eps ?? 'N/A'}`);

  return {
    industry,
    subject_ticker: subjectTicker,
    subject,
    peers,
    industry_agg: {
      avg_pe:              avgPe,
      median_pe:           medianPe,
      total_market_cap_cr: totalMcap,
      avg_eps:             avgEps,
      median_eps:          medianEps,
      peer_count_with_pe:  validPeRows.length,
      peer_count_with_eps: validEpsRows.length,
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
    `Subject (${em.subject_ticker}): CMP=₹${em.subject?.close ?? 'N/A'} | PE=${fmt(em.subject?.pe, 'x')} | EPS=₹${em.subject?.eps ?? 'N/A'} | Market Cap=${fmt(em.subject?.market_cap_cr, ' Cr')}`,
    `IMPORTANT: All target price calculations MUST be anchored to the subject CMP above. Target Price = FY EPS × Exit P/E. Do NOT use peer EPS values as a proxy for the subject's EPS scale.`,
    `Industry (${em.industry_agg.peer_count_with_pe} peers): Avg PE=${fmt(em.industry_agg.avg_pe, 'x')} | Median PE=${fmt(em.industry_agg.median_pe, 'x')} | Avg EPS=₹${em.industry_agg.avg_eps ?? 'N/A'} | Median EPS=₹${em.industry_agg.median_eps ?? 'N/A'} | Total MCap=${fmt(em.industry_agg.total_market_cap_cr, ' Cr')}`,
    '',
    'Peer PE, EPS & Market Cap:',
  ];

  for (const p of em.peers) {
    const tag = p.is_subject ? ' ← subject' : '';
    lines.push(`  ${p.ticker}${tag} | PE=${fmt(p.pe, 'x')} | EPS=₹${p.eps ?? 'N/A'} | MCap=${fmt(p.market_cap_cr, ' Cr')}`);
  }

  lines.push('');
  return lines.join('\n');
}

module.exports = { fetchPeerMetrics, formatPeerMetricsBlock, fetchEquityMetrics, formatEquityMetricsBlock };
