'use strict';

/**
 * Ticker Status / Ticker Completeness Service — period-wise document & signal availability
 * (TR, PPT, AR) across all fiscal years, plus current/latest L2, L3, L4 status flags.
 */

const prisma = require('../../config/prisma');
const { resolveGroupBySlug } = require('../companyGroups/groups.service');
const { paginateTickers } = require('../pipelineDispatch/paginate');
const { TtlCache, cacheKey } = require('../pipelineDispatch/cache');

const cache = new TtlCache();
const PREVIEW_CACHE_TTL_MS = 60_000;

/**
 * Resolve target ticker list based on options (groupSlug | tickers | all + startFrom)
 */
async function resolveTickers(options) {
  let tickers;
  if (options.groupSlug) {
    tickers = await resolveGroupBySlug(options.groupSlug);
  } else if (options.all) {
    const [ecSymbols, arSymbols] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
    ]);
    const set = new Set([
      ...ecSymbols.map(r => r.company).filter(Boolean),
      ...arSymbols.map(r => r.company).filter(Boolean),
    ]);
    tickers = [...set].sort();
  } else if (options.tickers && options.tickers.length > 0) {
    tickers = options.tickers.map(t => t.toUpperCase());
  } else {
    // Default to all distinct tickers in earnings calls + annual reports
    const [ecSymbols, arSymbols] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
    ]);
    const set = new Set([
      ...ecSymbols.map(r => r.company).filter(Boolean),
      ...arSymbols.map(r => r.company).filter(Boolean),
    ]);
    tickers = [...set].sort();
  }

  if (options.search) {
    const q = options.search.toUpperCase().trim();
    tickers = tickers.filter(t => t.includes(q));
  }

  if (options.startFrom) {
    const startFrom = options.startFrom.toUpperCase();
    tickers = tickers.filter(t => t >= startFrom);
  }

  return tickers;
}

/**
 * Main cached entry point for previewing Ticker Status completeness matrix
 */
async function previewTickerStatus(options = {}) {
  return cache.wrap(
    cacheKey('ticker-status-preview', options),
    PREVIEW_CACHE_TTL_MS,
    () => previewTickerStatusUncached(options)
  );
}

/**
 * Core query resolver for paginated ticker status
 */
async function previewTickerStatusUncached(options) {
  const allResolvedTickers = await resolveTickers(options);

  // 1. Fetch Tier classifications for all resolved tickers
  const tierRecords = await prisma.tierClassification.findMany({
    where: { company: { in: allResolvedTickers } },
    select: { company: true, tier: true },
  });
  const tierMap = new Map();
  tierRecords.forEach(r => tierMap.set(r.company, r.tier));

  // Filter by Tier if specified
  let filteredTickers = allResolvedTickers;
  if (options.tier && options.tier !== 'All') {
    const targetTier = options.tier;
    filteredTickers = allResolvedTickers.filter(t => (tierMap.get(t) || 'Tier 0') === targetTier);
  }

  // Paginate ticker list
  const { pageTickers: tickers, page, pageSize, totalPages, totalTickers } = paginateTickers(filteredTickers, options);

  if (tickers.length === 0) {
    return {
      tickers: [],
      years: [],
      pagination: { total: 0, page, pageSize, totalPages: 0 },
    };
  }

  // 2. Query earnings_calls, annual_reports, transcript_signals_v2, html_incremental_skill_outputs, post_html_analysis, and system-wide fiscal years
  const [calls, reports, ecYears, arYears] = await Promise.all([
    prisma.earnings_calls.findMany({
      where: { company: { in: tickers } },
      select: { id: true, company: true, fiscal_year: true, quarter: true, transcript_url: true, ppt_url: true },
      orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    }),
    prisma.annual_reports.findMany({
      where: { company: { in: tickers } },
      select: { id: true, company: true, fiscal_year: true, annual_report_url: true },
      orderBy: { fiscal_year: 'asc' },
    }),
    prisma.earnings_calls.findMany({ select: { fiscal_year: true }, distinct: ['fiscal_year'] }),
    prisma.annual_reports.findMany({ select: { fiscal_year: true }, distinct: ['fiscal_year'] }),
  ]);

  const callIds = [
    ...calls.map(c => c.id),
    ...reports.map(r => String(r.id)),
  ].filter(Boolean);

  const [l1Signals, l2Outputs, l3Outputs, l4Outputs] = await Promise.all([
    callIds.length > 0
      ? prisma.$queryRaw`
          SELECT call_id, source_doc_type
          FROM transcript_signals_v2
          WHERE call_id = ANY(${callIds}::text[]) AND is_invalidated = false
          GROUP BY call_id, source_doc_type
        `
      : [],
    prisma.$queryRaw`
      SELECT h.ticker, h.fiscal_year, h.quarter, h.skill_id, h.is_historic
      FROM html_incremental_skill_outputs h
      WHERE h.ticker = ANY(${tickers}::text[])
    `,
    prisma.$queryRaw`
      SELECT p.ticker, p.fiscal_year, p.quarter, p.type
      FROM post_html_analysis p
      WHERE p.ticker = ANY(${tickers}::text[]) AND p.layer_id = 'l3'
    `,
    prisma.$queryRaw`
      SELECT p.ticker, p.fiscal_year, p.quarter, p.type
      FROM post_html_analysis p
      WHERE p.ticker = ANY(${tickers}::text[]) AND p.layer_id = 'l4' AND p.type = 'summary'
    `,
  ]);

  // Build L1 signal lookup maps: call_id -> { transcript: bool, ppt: bool, annual_report: bool }
  const l1SignalMap = new Map();
  for (const row of l1Signals) {
    const callId = row.call_id;
    const docType = row.source_doc_type;
    if (!l1SignalMap.has(callId)) {
      l1SignalMap.set(callId, { transcript: false, ppt: false, annual_report: false });
    }
    const entry = l1SignalMap.get(callId);
    if (docType === 'transcript') entry.transcript = true;
    if (docType === 'ppt') entry.ppt = true;
    if (docType === 'annual_report') entry.annual_report = true;
  }

  // Build L2 status map: ticker_fy_q -> { count: number, is_historic: bool, is_incremental: bool }
  const l2Map = new Map();
  for (const row of l2Outputs) {
    const key = `${row.ticker}_${row.fiscal_year}_${row.quarter || ''}`;
    if (!l2Map.has(key)) {
      l2Map.set(key, { count: 0, hasHistoric: false, hasIncremental: false });
    }
    const entry = l2Map.get(key);
    entry.count++;
    if (row.is_historic) entry.hasHistoric = true;
    else entry.hasIncremental = true;
  }

  // Build L3 status map: ticker_fy_q -> count
  const l3Map = new Map();
  for (const row of l3Outputs) {
    const key = `${row.ticker}_${row.fiscal_year}_${row.quarter || ''}`;
    l3Map.set(key, (l3Map.get(key) || 0) + 1);
  }

  // Build L4 status map: ticker_fy_q -> count
  const l4Map = new Map();
  for (const row of l4Outputs) {
    const key = `${row.ticker}_${row.fiscal_year}_${row.quarter || ''}`;
    l4Map.set(key, (l4Map.get(key) || 0) + 1);
  }

  // Extract all system-wide fiscal years (descending order: FY2026, FY2025, ..., FY2011)
  const fySet = new Set([
    ...ecYears.map(r => r.fiscal_year).filter(Boolean),
    ...arYears.map(r => r.fiscal_year).filter(Boolean),
  ]);
  const allFYs = [...fySet].sort((a, b) => b.localeCompare(a));
  const latestFY = allFYs[0] || 'FY2026';

  const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];

  // Construct status per ticker
  const resultTickers = tickers.map(symbol => {
    const tTier = tierMap.get(symbol) || 'Tier 0';

    // Calls and Reports for this ticker
    const tCalls   = calls.filter(c => c.company === symbol);
    const tReports = reports.filter(r => r.company === symbol);

    // Call lookup: "FY2026 Q1" -> call object
    const callMap = {};
    tCalls.forEach(c => {
      callMap[`${c.fiscal_year} ${c.quarter}`] = c;
    });

    // Report lookup: "FY2026" -> report object
    const reportMap = {};
    tReports.forEach(r => {
      reportMap[r.fiscal_year] = r;
    });

    // Build period matrix for every FY
    const periods = {};
    allFYs.forEach(fy => {
      const qData = {};
      quarters.forEach(q => {
        const c = callMap[`${fy} ${q}`];
        const trDoc = c && c.transcript_url ? 1 : 0;
        const pptDoc = c && c.ppt_url ? 1 : 0;

        const sigs = c ? l1SignalMap.get(c.id) : null;
        const trSig  = sigs && sigs.transcript ? 1 : 0;
        const pptSig = sigs && sigs.ppt ? 1 : 0;

        qData[q] = {
          trDoc,
          trSig,
          pptDoc,
          pptSig,
        };
      });

      // Annual Report for FY
      const r = reportMap[fy];
      const arDoc = r && r.annual_report_url ? 1 : 0;
      const arSigs = r ? l1SignalMap.get(r.id.toString()) : null;
      const arSig  = arSigs && arSigs.annual_report ? 1 : 0;

      periods[fy] = {
        quarters: qData,
        arDoc,
        arSig,
      };
    });

    // Calculate L2, L3, L4 period & status (returning latest period and H, I, or 0)
    const periodQuarters = ['Q4', 'Q3', 'Q2', 'Q1', ''];

    let latestL2Period = '-';
    let latestL2 = '0';
    let latestL3Period = '-';
    let latestL3 = 0;
    let latestL4Period = '-';
    let latestL4 = 0;

    // Find latest L2 output period & status
    l2Loop: for (const fy of allFYs) {
      for (const q of periodQuarters) {
        const k = `${symbol}_${fy}_${q}`;
        const l2Entry = l2Map.get(k);
        if (l2Entry && l2Entry.count > 0) {
          latestL2Period = q ? `${fy} ${q}` : fy;
          latestL2 = l2Entry.hasHistoric ? 'H' : 'I';
          break l2Loop;
        }
      }
    }

    // Find latest L3 output period & status
    l3Loop: for (const fy of allFYs) {
      for (const q of periodQuarters) {
        const k = `${symbol}_${fy}_${q}`;
        const count = l3Map.get(k) || 0;
        if (count > 0) {
          latestL3Period = q ? `${fy} ${q}` : fy;
          latestL3 = 1;
          break l3Loop;
        }
      }
    }

    // Find latest L4 output period & status
    l4Loop: for (const fy of allFYs) {
      for (const q of periodQuarters) {
        const k = `${symbol}_${fy}_${q}`;
        const count = l4Map.get(k) || 0;
        if (count > 0) {
          latestL4Period = q ? `${fy} ${q}` : fy;
          latestL4 = 1;
          break l4Loop;
        }
      }
    }

    return {
      symbol,
      tier: tTier,
      latestL2,
      latestL2Period,
      latestL3,
      latestL3Period,
      latestL4,
      latestL4Period,
      periods,
    };
  });

  // Apply optional layer filters (l2Status, l3Status, l4Status)
  let finalItems = resultTickers;
  if (options.l2Status && options.l2Status !== 'All') {
    finalItems = finalItems.filter(t => t.latestL2 === options.l2Status);
  }
  if (options.l3Status && options.l3Status !== 'All') {
    const target = Number(options.l3Status);
    finalItems = finalItems.filter(t => t.latestL3 === target);
  }
  if (options.l4Status && options.l4Status !== 'All') {
    const target = Number(options.l4Status);
    finalItems = finalItems.filter(t => t.latestL4 === target);
  }

  return {
    tickers: finalItems,
    years: allFYs,
    pagination: {
      total: filteredTickers.length,
      page,
      pageSize,
      totalPages,
    },
  };
}

async function getTickerStatusOptions() {
  const [distinctTiers, ecSymbols, arSymbols, tcSymbols] = await Promise.all([
    prisma.tierClassification.findMany({
      select: { tier: true },
      distinct: ['tier'],
    }),
    prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
    prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
    prisma.tierClassification.findMany({ select: { company: true }, distinct: ['company'] }),
  ]);

  const foundTiers = distinctTiers.map(t => t.tier).filter(Boolean);
  const defaultTiers = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 0.5', 'Tier 0'];
  const combinedTiers = [...new Set([...defaultTiers, ...foundTiers])];

  const companySet = new Set([
    ...ecSymbols.map(r => r.company).filter(Boolean),
    ...arSymbols.map(r => r.company).filter(Boolean),
    ...tcSymbols.map(r => r.company).filter(Boolean),
  ]);
  const companies = [...companySet].sort();

  return {
    tiers: ['All', ...combinedTiers],
    l2Statuses: ['All', 'H', 'I', '0'],
    l3Statuses: ['All', '1', '0'],
    l4Statuses: ['All', '1', '0'],
    companies,
  };
}

module.exports = {
  previewTickerStatus,
  getTickerStatusOptions,
};
