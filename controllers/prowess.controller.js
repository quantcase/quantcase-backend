'use strict';

const { r2, loadIdentityMap } = require('../lib/prowess');

const prisma = require('../config/prisma');
const { fetchMonthlyOhlcv } = require('../utils/formulaRegistry/dataFetcherMarket');
const {
  resolveProwessName, createResolutionContext, resolveFormulaSeries, getDefinition,
} = require('../utils/formulaRegistry');

function roundTo(v, decimals) {
  if (v == null || isNaN(v)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function median(values) {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? r2((sorted[mid - 1] + sorted[mid]) / 2) : r2(sorted[mid]);
}

// Every chart group besides Price is built the same way: walk a
// ScreenConfig's items, resolve each via resolveFormulaSeries (the same
// per-index engine _buildTableFromConfig in lib/financials.js uses), route
// into bar/line by item.series_type, and — for groups with exactly one line
// series (every group except Sales & Margin, which has 3) — append a median
// line, matching the original chart structure. No CSV involved: every value
// comes from the Kpi catalogue via resCtx, the same resolveMetric path
// GET /admin/kpis/:abbr/preview uses.
//
// One shared frequency for the whole group ('quarterly', same as
// lib/financials.js#_buildTableFromKpiGroup's single `freq` param for a
// whole table) — NOT each item's own Kpi.frequency pin. Bar and line series
// share one x-axis, so they need one seriesMap/period list; a per-item pin
// (e.g. PRICE/MCAP_SNAPSHOT/PE_DAILY are all pinned 'daily', for single-
// value preview purposes) would desync a group's bar from its line, and for
// a mixed-frequency formula (PE_DAILY = PRICE/EPS_DILUTED) walking at
// 'daily' can't even resolve — EPS_DILUTED has no per-day value, only
// per-quarter. At 'quarterly' every item resolves cleanly instead: a daily-
// native raw abbr resamples onto the real fiscal-quarter boundaries via
// resolutionContext.js's daily-abbr merge (resampleToPeriods, 'latest' —
// that quarter's own most recent trading day), landing index-for-index next
// to genuine quarterly abbrs like EPS_DILUTED — no look-ahead risk, since
// nothing is forward-filled across quarters.
async function _buildChartGroup(configKey, resCtx) {
  const config = await prisma.screenConfig.findUnique({
    where:   { key: configKey },
    include: { items: { orderBy: { display_order: 'asc' } } },
  });
  if (!config || !config.items.length) return null;

  const freq = 'quarterly';
  const seriesMap  = await resCtx.getSeriesMap(freq);
  const anyAbbr    = Object.keys(seriesMap)[0];
  const periods    = anyAbbr ? seriesMap[anyAbbr] : [];

  const barSeries = [];
  const lineSeries = [];

  for (const item of config.items) {
    const def      = await getDefinition(item.kpi_abbr);
    const decimals = item.decimal_places ?? config.decimal_places;

    const values     = await resolveFormulaSeries(item.kpi_abbr, resCtx, { frequency: freq });

    const data = periods.map((p, i) => ({
      x: `${p.quarter} ${p.fiscal_year}`,
      y: roundTo(values[i] ?? null, decimals),
    }));

    const seriesObj = { dataKey: item.kpi_abbr, name: item.label ?? def?.name ?? item.kpi_abbr, data };
    (item.series_type === 'bar' ? barSeries : lineSeries).push(seriesObj);
  }

  if (lineSeries.length === 1) {
    const med = median(lineSeries[0].data.map((d) => d.y));
    lineSeries.push({
      dataKey: 'median',
      name: `Median = ${med}`,
      data: lineSeries[0].data.map((d) => ({ x: d.x, y: med })),
    });
  }

  return { group: config.label, source: 'registry', barSeries, lineSeries };
}

// ── Charts ────────────────────────────────────────────────────────────────────

/**
 * GET /api/screener/:symbol/charts
 *
 * Chart groups:
 *   1. Price          — yfinance-equivalent monthly (nse_equity_new, 10 years) — unchanged
 *   2-6. PE Ratio / Sales & Margin / EV-EBITDA / Price to Book / Market Cap-Sales
 *        — each is a ScreenConfig (charts.pe-ratio / charts.sales-margin /
 *        charts.ev-ebitda / charts.price-to-book / charts.mcap-sales), built by
 *        _buildChartGroup. No CSV involved anywhere — every value resolves
 *        through the Kpi catalogue via resCtx, the same path GET
 *        /admin/kpis/:abbr/preview uses, all at one shared 'quarterly'
 *        frequency per group (see _buildChartGroup's own docs for why).
 *        EV/EBITDA's and Price to Book's ratio lines (and some periods of
 *        their bar series) still come back null on periods missing a real
 *        start_date/end_date boundary — a data-completeness gap (admin needs
 *        to ingest quarterly period boundaries for those), not a frequency
 *        bug — see resampleToPeriods's docs.
 */
async function getCharts(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const companyName = await resolveProwessName(prisma, symbol);
    if (!companyName) {
      return res.status(404).json({
        error: `Symbol "${symbol}" not found in Prowess identity mapping.`,
      });
    }

    const resCtx = createResolutionContext({ symbol });

    // Latest known quarter label, for the top-level `quarter` field —
    // derived from the same quarterly seriesMap the chart groups below read.
    const quarterlySeriesMap = await resCtx.getSeriesMap('quarterly');
    const anyQAbbr  = Object.keys(quarterlySeriesMap)[0];
    const qPeriods  = anyQAbbr ? quarterlySeriesMap[anyQAbbr] : [];
    const quarterLabel = qPeriods.length ? `${qPeriods.at(-1).quarter} ${qPeriods.at(-1).fiscal_year}` : null;

    // ── 1. Price group — nse_equity_new (unchanged) ──────────────────────────
    const tenYearsAgo = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000);

    const monthlyPriceRows = await fetchMonthlyOhlcv(prisma, symbol, { since: tenYearsAgo });

    const monthlyQuotes = monthlyPriceRows
      .filter((q) => q.close != null)
      .map((q) => ({ date: q.month, close: parseFloat(q.close), volume: q.volume ? Number(q.volume) : null }));

    function rollingAvg(closes, window) {
      return closes.map((_, i) => {
        if (i < window - 1) return null;
        const slice = closes.slice(i - window + 1, i + 1);
        return r2(slice.reduce((s, v) => s + v, 0) / window);
      });
    }

    const fmtMonthLabel = (date) => {
      const d = date instanceof Date ? date : new Date(date);
      return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
    };

    const monthlyLabels = monthlyQuotes.map((q) => fmtMonthLabel(q.date));
    const monthlyCloses = monthlyQuotes.map((q) => q.close);
    const dma50Values = rollingAvg(monthlyCloses, 3);
    const dma200Values = rollingAvg(monthlyCloses, 10);

    const priceGroup = {
      group: 'Price',
      source: 'yfinance',
      barSeries: [
        {
          dataKey: 'volume',
          name: 'Volume',
          data: monthlyQuotes.map((q, i) => ({ x: monthlyLabels[i], y: q.volume ?? null })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'priceNSE',
          name: 'Price on NSE',
          data: monthlyQuotes.map((q, i) => ({ x: monthlyLabels[i], y: r2(q.close) })),
        },
        {
          dataKey: 'dma50',
          name: '50 DMA',
          data: monthlyLabels.map((x, i) => ({ x, y: dma50Values[i] })),
        },
        {
          dataKey: 'dma200',
          name: '200 DMA',
          data: monthlyLabels.map((x, i) => ({ x, y: dma200Values[i] })),
        },
      ],
    };

    // ── 2-6. Registry-driven groups ───────────────────────────────────────────
    const [peGroup, salesMarginGroup, evEbitdaGroup, priceToBookGroup, mcSalesGroup] = await Promise.all([
      _buildChartGroup('charts.pe-ratio', resCtx),
      _buildChartGroup('charts.sales-margin', resCtx),
      _buildChartGroup('charts.ev-ebitda', resCtx),
      _buildChartGroup('charts.price-to-book', resCtx),
      _buildChartGroup('charts.mcap-sales', resCtx),
    ]);

    res.json({
      company: companyName,
      symbol,
      quarter: quarterLabel,
      chartGroups: [
        priceGroup,
        peGroup,
        salesMarginGroup,
        evEbitdaGroup,
        priceToBookGroup,
        mcSalesGroup,
      ].filter(Boolean),
    });
  } catch (err) {
    next(err);
  }
}

// ── Shareholding ──────────────────────────────────────────────────────────────

/**
 * GET /api/screener/:symbol/shareholding
 *
 * Returns historical quarterly shareholding data as a tree of sections.
 * Top-level rows are expandable (promoters, non-promoters) with children rows.
 * Quarter columns run oldest → latest.
 *
 * Response shape:
 * {
 *   company, symbol, quarters: string[],
 *   sections: [
 *     {
 *       id, label, isExpandable,
 *       data: [{ quarter, value }],
 *       children: [{ id, label, data: [{ quarter, value }] }]
 *     }
 *   ]
 * }
 */
async function getShareholding(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const identityMap = loadIdentityMap();
    const companyName = identityMap[symbol];
    if (!companyName) {
      return res.status(404).json({
        error: `Symbol "${symbol}" not found in Prowess identity mapping.`,
      });
    }

    const dbRows = await prisma.shareholding_pattern.findMany({
      where:   { company: companyName },
      orderBy: [{ fiscal_year: 'asc' }, { quarter_code: 'asc' }],
    });

    if (!dbRows.length) {
      return res.status(404).json({
        error: `No shareholding data found for "${companyName}".`,
      });
    }

    const quarters = dbRows.map(r => r.quarter_label);

    // Build [{quarter, value}] series for a given DB field name
    const series = (field) =>
      dbRows.map(r => ({ quarter: r.quarter_label, value: r2(r[field]) }));

    const sections = [
      {
        id: 'total',
        label: 'Total Shares (%)',
        isExpandable: false,
        data: series('total'),
        children: [],
      },
      {
        id: 'promoters',
        label: 'Promoters',
        isExpandable: true,
        data: series('promoters'),
        children: [
          { id: 'indianPromoters',        label: 'Indian Promoters',              data: series('indian_promoters') },
          { id: 'indianPromoterIndvHuf',  label: 'Individuals & HUF',             data: series('indian_promoter_indv_huf') },
          { id: 'indianCentralStateGovt', label: 'Central & State Govt.',          data: series('indian_central_state_govt') },
          { id: 'indianPromoterCorp',     label: 'Corporate Bodies',               data: series('indian_promoter_corp') },
          { id: 'indianPromoterFiBanks',  label: 'FIs & Banks',                    data: series('indian_promoter_fi_banks') },
          { id: 'otherIndianPromoters',   label: 'Other Indian Promoters',         data: series('other_indian_promoters') },
          { id: 'foreignPromoters',       label: 'Foreign Promoters',              data: series('foreign_promoters') },
          { id: 'foreignIndvNri',         label: 'Foreign Individuals (NRIs)',      data: series('foreign_indv_nri') },
          { id: 'foreignPromoterCorp',    label: 'Foreign Corporate Bodies',       data: series('foreign_promoter_corp') },
          { id: 'foreignPromoterInst',    label: 'Foreign Institutions',           data: series('foreign_promoter_inst') },
          { id: 'promoterQfi',            label: 'Qualified Foreign Investor',     data: series('promoter_qfi') },
          { id: 'otherForeignPromoters',  label: 'Other Foreign Promoters',        data: series('other_foreign_promoters') },
          { id: 'personsActingInConcert', label: 'Persons Acting in Concert',      data: series('persons_acting_in_concert') },
        ],
      },
      {
        id: 'nonPromoters',
        label: 'Non-Promoters',
        isExpandable: true,
        data: series('non_promoters'),
        children: [
          { id: 'nonPromoterInst',    label: 'Institutions',                      data: series('non_promoter_inst') },
          { id: 'npMutualFunds',      label: 'Mutual Funds / UTI',                data: series('np_mutual_funds') },
          { id: 'npBanksFiIns',       label: 'Banks, FIs, Insurance',             data: series('np_banks_fi_ins') },
          { id: 'npInsurance',        label: 'Insurance Companies',               data: series('np_insurance') },
          { id: 'npFiBanks',          label: 'Financial Institutions & Banks',    data: series('np_fi_banks') },
          { id: 'npCentralStateGovt', label: 'Central & State Govt.',             data: series('np_central_state_govt') },
          { id: 'npFiis',             label: 'FIIs',                              data: series('np_fiis') },
          { id: 'npVentureCapital',   label: 'Venture Capital Funds',             data: series('np_venture_capital') },
          { id: 'npForeignVenture',   label: 'Foreign Venture Capital',           data: series('np_foreign_venture') },
          { id: 'npQfiInst',          label: 'Qualified Foreign Investor (Inst)', data: series('np_qfi_inst') },
          { id: 'otherInstNp',        label: 'Other Institutional',               data: series('other_inst_np') },
          { id: 'npNonInst',          label: 'Non-Institutions',                  data: series('np_non_inst') },
          { id: 'npCorpBodies',       label: 'Corporate Bodies',                  data: series('np_corp_bodies') },
          { id: 'npIndividuals',      label: 'Individuals',                       data: series('np_individuals') },
          { id: 'npIndvUpto1L',       label: 'Individuals (up to ₹1 lakh)',       data: series('np_indv_upto_1l') },
          { id: 'npIndvOver1L',       label: 'Individuals (over ₹1 lakh)',        data: series('np_indv_over_1l') },
          { id: 'npQfi',              label: 'Qualified Foreign Investor',        data: series('np_qfi') },
          { id: 'otherNonInstNp',     label: 'Other Non-Institutional',           data: series('other_non_inst_np') },
        ],
      },
      {
        id: 'custodians',
        label: 'Shares held by Custodians',
        isExpandable: false,
        data: series('custodians'),
        children: [],
      },
    ];

    res.json({
      company: companyName,
      symbol,
      quarters,
      sections,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getCharts, getShareholding };
