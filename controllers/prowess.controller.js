'use strict';

const YahooFinance = require('yahoo-finance2').default;

const {
  r2,
  loadIdentityMap,
  loadFundamentalData,
  loadShareholdingData,
  fundPeriodData,
  shPeriodData,
  findFundCompanyRow,
  FUND_PERIOD_COUNT,
  SH_PERIOD_COUNT,
} = require('../lib/prowess');

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ── Charts ────────────────────────────────────────────────────────────────────

/**
 * GET /api/screener/:symbol/charts
 *
 * Chart groups:
 *   1. Price          — yfinance monthly (10 years)
 *   2. PE Ratio       — bar=Earnings Yield %, line=PE + Median PE
 *   3. Sales & Margin — bar=Quarter Sales (Cr), lines=GPM%/OPM%/NPM%
 *   4. EV / EBITDA    — bar=EV (Cr), line=EV/PBDITA + Median
 *   5. Price to Book  — bar=Stock Price (₹), line=P/B + Median PBV
 *   6. Market Cap / Sales — bar=Market Cap (Cr), line=MC/TTM Sales + Median
 */
async function getCharts(req, res, next) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const ticker = symbol + '.NS';

    const companyRow = findFundCompanyRow(symbol);
    if (!companyRow) {
      return res.status(404).json({
        error: `Symbol "${symbol}" not found in Prowess identity mapping or fundamentals data.`,
      });
    }
    const companyName = companyRow[0];

    const { quarterLabels } = loadFundamentalData();
    const periods = Array.from({ length: FUND_PERIOD_COUNT }, (_, i) => fundPeriodData(companyRow, i));
    const quarterLabel = quarterLabels[FUND_PERIOD_COUNT - 1];

    // ── 1. Price group — yfinance ─────────────────────────────────────────────
    const now = Date.now();
    const tenYearsAgo = new Date(now - 10 * 365 * 24 * 60 * 60 * 1000);

    let monthlyChart = null;
    try {
      monthlyChart = await yahooFinance.chart(ticker, {
        period1: tenYearsAgo,
        period2: new Date(now),
        interval: '1mo',
      });
    } catch (_) {
      // non-fatal
    }

    const monthlyQuotes = (monthlyChart?.quotes ?? [])
      .filter((q) => q.close != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

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

    // ── 2. PE Ratio group ─────────────────────────────────────────────────────
    const peValues = periods.map((p) => p.pe).filter((v) => v != null).sort((a, b) => a - b);
    let medianPe = null;
    if (peValues.length > 0) {
      const mid = Math.floor(peValues.length / 2);
      medianPe = peValues.length % 2 === 0
        ? r2((peValues[mid - 1] + peValues[mid]) / 2)
        : r2(peValues[mid]);
    }

    const peGroup = {
      group: 'PE Ratio',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'earningsYield',
          name: 'Earnings Yield %',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.pe != null && p.pe !== 0 ? r2((1 / p.pe) * 100) : null,
          })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'pe',
          name: 'PE',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.pe) })),
        },
        {
          dataKey: 'medianPe',
          name: 'Median PE',
          data: periods.map((_, i) => ({ x: quarterLabels[i], y: medianPe })),
        },
      ],
    };

    // ── 3. Sales & Margin group ───────────────────────────────────────────────
    const salesMarginGroup = {
      group: 'Sales & Margin',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'quarterSales',
          name: 'Quarter Sales (Cr)',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.totalIncomeCr) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'gpm',
          name: 'GPM %',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.totalIncomeCr && p.cogsCr != null
              ? r2(((p.totalIncomeCr - p.cogsCr) / p.totalIncomeCr) * 100) : null,
          })),
        },
        {
          dataKey: 'opm',
          name: 'OPM %',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.totalIncomeCr && p.totalExpCr != null
              ? r2(((p.totalIncomeCr - p.totalExpCr) / p.totalIncomeCr) * 100) : null,
          })),
        },
        {
          dataKey: 'npm',
          name: 'NPM %',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.totalIncomeCr && p.netProfitCr != null
              ? r2((p.netProfitCr / p.totalIncomeCr) * 100) : null,
          })),
        },
      ],
    };

    // ── 4. EV / EBITDA group ──────────────────────────────────────────────────
    const evEbitdaValues = periods.map((p) => p.evPbdita).filter((v) => v != null).sort((a, b) => a - b);
    let MEDIAN_EV_EBITDA = null;
    if (evEbitdaValues.length > 0) {
      const mid = Math.floor(evEbitdaValues.length / 2);
      MEDIAN_EV_EBITDA = evEbitdaValues.length % 2 === 0
        ? r2((evEbitdaValues[mid - 1] + evEbitdaValues[mid]) / 2)
        : r2(evEbitdaValues[mid]);
    }
    const evEbitdaGroup = {
      group: 'EV / EBITDA',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'ev',
          name: 'Enterprise Value (Cr)',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.ev) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'evToEbitda',
          name: 'EV / PBDITA',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.evPbdita) })),
        },
        {
          dataKey: 'medianEvMultiple',
          name: `Median EV Multiple = ${MEDIAN_EV_EBITDA}`,
          data: periods.map((_, i) => ({ x: quarterLabels[i], y: MEDIAN_EV_EBITDA })),
        },
      ],
    };

    // ── 5. Price to Book group ────────────────────────────────────────────────
    const pbValues = periods.map((p) => p.pb).filter((v) => v != null).sort((a, b) => a - b);
    let MEDIAN_PBV = null;
    if (pbValues.length > 0) {
      const mid = Math.floor(pbValues.length / 2);
      MEDIAN_PBV = pbValues.length % 2 === 0
        ? r2((pbValues[mid - 1] + pbValues[mid]) / 2)
        : r2(pbValues[mid]);
    }
    const priceToBookGroup = {
      group: 'Price to Book',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'pricePerShare',
          name: 'Stock Price (₹)',
          data: periods.map((p, i) => ({
            x: quarterLabels[i],
            y: p.marketCapCr != null && p.shares != null && p.shares > 0
              ? r2((p.marketCapCr * 1e7) / p.shares)
              : null,
          })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'priceToBV',
          name: 'Price to BV',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.pb) })),
        },
        {
          dataKey: 'medianPBV',
          name: `Median PBV = ${MEDIAN_PBV}`,
          data: periods.map((_, i) => ({ x: quarterLabels[i], y: MEDIAN_PBV })),
        },
      ],
    };

    // ── 6. Market Cap / Sales group ───────────────────────────────────────────
    const latestTotalIncomeCr = periods[FUND_PERIOD_COUNT - 1].totalIncomeCr;
    const ttmSalesCr = latestTotalIncomeCr != null ? latestTotalIncomeCr * 4 : null;
    const mcSalesValues = periods
      .map((p) => (p.marketCapCr != null && ttmSalesCr ? r2(p.marketCapCr / ttmSalesCr) : null))
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    let MEDIAN_MC_SALES = null;
    if (mcSalesValues.length > 0) {
      const mid = Math.floor(mcSalesValues.length / 2);
      MEDIAN_MC_SALES = mcSalesValues.length % 2 === 0
        ? r2((mcSalesValues[mid - 1] + mcSalesValues[mid]) / 2)
        : r2(mcSalesValues[mid]);
    }

    const mcSalesGroup = {
      group: 'Market Cap / Sales',
      source: 'prowess',
      quarter: quarterLabel,
      barSeries: [
        {
          dataKey: 'marketCap',
          name: 'Market Cap (Cr)',
          data: periods.map((p, i) => ({ x: quarterLabels[i], y: r2(p.marketCapCr) })),
        },
      ],
      lineSeries: [
        {
          dataKey: 'mcToSales',
          name: 'Market Cap / Sales',
          data: periods.map((p, i) => {
            const ratio = p.marketCapCr != null && ttmSalesCr
              ? r2(p.marketCapCr / ttmSalesCr)
              : null;
            return { x: quarterLabels[i], y: ratio };
          }),
        },
        {
          dataKey: 'medianMcToSales',
          name: `Median Market Cap to Sales = ${MEDIAN_MC_SALES}`,
          data: periods.map((_, i) => ({ x: quarterLabels[i], y: MEDIAN_MC_SALES })),
        },
      ],
    };

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
      ],
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
    const { quarterLabels, companyMap } = loadShareholdingData();

    const companyName = identityMap[symbol];
    if (!companyName) {
      return res.status(404).json({
        error: `Symbol "${symbol}" not found in Prowess identity mapping.`,
      });
    }
    const row = companyMap[companyName];
    if (!row) {
      return res.status(404).json({
        error: `No shareholding data found for "${companyName}".`,
      });
    }

    const periods = Array.from({ length: SH_PERIOD_COUNT }, (_, i) => shPeriodData(row, i));

    // Build [{quarter, value}] series for a given field key
    const series = (key) =>
      periods.map((p, i) => ({ quarter: quarterLabels[i], value: r2(p[key]) }));

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
          { id: 'indianPromoters',        label: 'Indian Promoters',              data: series('indianPromoters') },
          { id: 'indianPromoterIndvHuf',  label: 'Individuals & HUF',             data: series('indianPromoterIndvHuf') },
          { id: 'indianCentralStateGovt', label: 'Central & State Govt.',          data: series('indianCentralStateGovt') },
          { id: 'indianPromoterCorp',     label: 'Corporate Bodies',               data: series('indianPromoterCorp') },
          { id: 'indianPromoterFiBanks',  label: 'FIs & Banks',                    data: series('indianPromoterFiBanks') },
          { id: 'otherIndianPromoters',   label: 'Other Indian Promoters',         data: series('otherIndianPromoters') },
          { id: 'foreignPromoters',       label: 'Foreign Promoters',              data: series('foreignPromoters') },
          { id: 'foreignIndvNri',         label: 'Foreign Individuals (NRIs)',      data: series('foreignIndvNri') },
          { id: 'foreignPromoterCorp',    label: 'Foreign Corporate Bodies',       data: series('foreignPromoterCorp') },
          { id: 'foreignPromoterInst',    label: 'Foreign Institutions',           data: series('foreignPromoterInst') },
          { id: 'promoterQfi',            label: 'Qualified Foreign Investor',     data: series('promoterQfi') },
          { id: 'otherForeignPromoters',  label: 'Other Foreign Promoters',        data: series('otherForeignPromoters') },
          { id: 'personsActingInConcert', label: 'Persons Acting in Concert',      data: series('personsActingInConcert') },
        ],
      },
      {
        id: 'nonPromoters',
        label: 'Non-Promoters',
        isExpandable: true,
        data: series('nonPromoters'),
        children: [
          { id: 'nonPromoterInst',   label: 'Institutions',                       data: series('nonPromoterInst') },
          { id: 'npMutualFunds',     label: 'Mutual Funds / UTI',                 data: series('npMutualFunds') },
          { id: 'npBanksFiIns',      label: 'Banks, FIs, Insurance',              data: series('npBanksFiIns') },
          { id: 'npInsurance',       label: 'Insurance Companies',                data: series('npInsurance') },
          { id: 'npFiBanks',         label: 'Financial Institutions & Banks',     data: series('npFiBanks') },
          { id: 'npCentralStateGovt',label: 'Central & State Govt.',              data: series('npCentralStateGovt') },
          { id: 'npFiis',            label: 'FIIs',                               data: series('npFiis') },
          { id: 'npVentureCapital',  label: 'Venture Capital Funds',              data: series('npVentureCapital') },
          { id: 'npForeignVenture',  label: 'Foreign Venture Capital',            data: series('npForeignVenture') },
          { id: 'npQfiInst',         label: 'Qualified Foreign Investor (Inst)',  data: series('npQfiInst') },
          { id: 'otherInstNp',       label: 'Other Institutional',                data: series('otherInstNp') },
          { id: 'npNonInst',         label: 'Non-Institutions',                   data: series('npNonInst') },
          { id: 'npCorpBodies',      label: 'Corporate Bodies',                   data: series('npCorpBodies') },
          { id: 'npIndividuals',     label: 'Individuals',                        data: series('npIndividuals') },
          { id: 'npIndvUpto1L',      label: 'Individuals (up to ₹1 lakh)',        data: series('npIndvUpto1L') },
          { id: 'npIndvOver1L',      label: 'Individuals (over ₹1 lakh)',         data: series('npIndvOver1L') },
          { id: 'npQfi',             label: 'Qualified Foreign Investor',         data: series('npQfi') },
          { id: 'otherNonInstNp',    label: 'Other Non-Institutional',            data: series('otherNonInstNp') },
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
      quarters: quarterLabels,
      sections,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getCharts, getShareholding };
