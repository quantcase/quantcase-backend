'use strict';

const { ProwessHelper }                          = require('../../utils/prowessHelper');
const { FinHelper }                              = require('../../utils/finHelper');
const { growth, cagr, weightedAverage, average, kpiDuration } = require('../../utils/finMath');

// ─── KPI abbrs ────────────────────────────────────────────────────────────────

// Primary: prowess_values_new (annual audited)
const PROWESS_ABBRS = [
  'REV_OP', 'PAT', 'PBT', 'FIN_COST', 'ROCE',
  'TRADE_RECV', 'INVENTORY', 'TRADE_PAY', 'COST_MAT',
  'ASSET_PPE', 'ASSET_CWIP', 'CFO', 'CFI',
  'TOTAL_ASSETS', 'CURR_LIAB',
];

// Supplement: kpi_values (quarterly, QE-sourced only)
// EBITDA and EBITDA_MARGIN are computed from QE components: PBT + FIN_COST + DEP_AMORT
// CAPEX and ROCE are transcript-only — covered by prowess (PPE delta, ROCE directly)
const KPI_ABBRS = [
  'REV_OP', 'PBT', 'FIN_COST', 'DEP_AMORT', 'PAT',
  'TRADE_RECV', 'INVENTORY', 'TRADE_PAY', 'COST_MAT',
  'ASSET_PPE', 'ASSET_CWIP',
];

// ─── Output schema (stored in DB as skill.outputSchema; kept here for reference) ─
// NOT sent to LLM as response_format. Embedded in OUTPUT_FORMAT_INSTRUCTIONS instead.

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['industry_analysis'],
  properties: {
    industry_analysis: {
      type: 'object',
      required: ['score_card', 'industry_metrics', 'key_takeaway', 'key_findings',
                 'coherence_checks', 'demand_drivers', 'supply_drivers',
                 'company_table', 'investment_implications'],
      properties: {
        score_card: {
          type: 'object',
          required: ['total', 'status', 'status_color', 'dimensions'],
          properties: {
            total:        { type: 'number' },
            status:       { type: 'string', enum: ['STRONG_INDUSTRY', 'MODERATE_INDUSTRY', 'WEAK_INDUSTRY'] },
            status_color: { type: 'string', enum: ['green', 'yellow', 'red'] },
            dimensions: {
              type: 'object',
              required: ['growth', 'demand', 'supply', 'profit_pool', 'global_competition'],
              properties: {
                growth:             { type: 'object', properties: { score: { type: 'number' }, max: { type: 'number' }, status: { type: 'string' } } },
                demand:             { type: 'object', properties: { score: { type: 'number' }, max: { type: 'number' }, status: { type: 'string' } } },
                supply:             { type: 'object', properties: { score: { type: 'number' }, max: { type: 'number' }, status: { type: 'string' } } },
                profit_pool:        { type: 'object', properties: { score: { type: 'number' }, max: { type: 'number' }, status: { type: 'string' } } },
                global_competition: { type: 'object', properties: { score: { type: 'number' }, max: { type: 'number' }, status: { type: 'string' } } },
              },
            },
          },
        },
        industry_metrics: {
          type: 'object',
          properties: {
            revenue_growth_yoy:        { type: 'object', properties: { value: {}, label: { type: 'string' } } },
            revenue_cagr_3y:           { type: 'object', properties: { value: {}, label: { type: 'string' } } },
            qoq_acceleration:          { type: 'object', properties: { value: {}, direction: { type: 'string' }, label: { type: 'string' } } },
            bullish_sentiment:         { type: 'object', properties: { count: { type: 'number' }, total: { type: 'number' }, label: { type: 'string' } } },
            rising_capex_count:        { type: 'object', properties: { count: { type: 'number' }, total: { type: 'number' }, label: { type: 'string' } } },
            falling_receivables_count: { type: 'object', properties: { count: { type: 'number' }, total: { type: 'number' }, label: { type: 'string' } } },
            avg_capacity_utilization:  { type: 'object', properties: { value: {}, label: { type: 'string' } } },
            high_utilization_count:    { type: 'object', properties: { count: { type: 'number' }, total: { type: 'number' }, label: { type: 'string' } } },
            inventory_trend:           { type: 'object', properties: { direction: { type: 'string' }, count: { type: 'number' }, total: { type: 'number' }, label: { type: 'string' } } },
            industry_roce:             { type: 'object', properties: { value: {}, vs_wacc_spread: {}, label: { type: 'string' } } },
            operating_margin:          { type: 'object', properties: { value: {}, trend: { type: 'string' }, label: { type: 'string' } } },
          },
        },
        key_takeaway:    { type: 'string' },
        key_findings:    { type: 'array', items: { type: 'object', required: ['theme', 'color', 'body'], properties: { theme: { type: 'string' }, color: { type: 'string' }, body: { type: 'string' } } } },
        coherence_checks:{ type: 'array', items: { type: 'object', required: ['pattern', 'type', 'explanation'], properties: { pattern: { type: 'string' }, type: { type: 'string' }, explanation: { type: 'string' } } } },
        demand_drivers: {
          type: 'object',
          properties: {
            positive:              { type: 'array', items: { type: 'object', properties: { driver: { type: 'string' }, mentioned_by: { type: 'number' }, total_companies: { type: 'number' } } } },
            negative:              { type: 'array', items: { type: 'object', properties: { concern: { type: 'string' }, mentioned_by: { type: 'number' }, total_companies: { type: 'number' } } } },
            representative_quotes: { type: 'array', items: { type: 'string' } },
          },
        },
        supply_drivers: {
          type: 'object',
          properties: {
            tightness_indicators:  { type: 'array', items: { type: 'object', properties: { indicator: { type: 'string' }, mentioned_by: { type: 'number' }, total_companies: { type: 'number' } } } },
            excess_indicators:     { type: 'array', items: { type: 'object', properties: { indicator: { type: 'string' }, mentioned_by: { type: 'number' }, total_companies: { type: 'number' } } } },
            representative_quotes: { type: 'array', items: { type: 'string' } },
          },
        },
        company_table: {
          type: 'array',
          items: {
            type: 'object',
            required: ['company', 'sentiment'],
            properties: {
              company:                  { type: 'string' },
              market_cap_cr:            { type: ['number', 'null'] },
              revenue_latest_cr:        { type: ['number', 'null'] },
              revenue_growth_yoy:       { type: ['string', 'null'] },
              revenue_cagr_3y:          { type: ['string', 'null'] },
              qoq_acceleration:         { type: ['string', 'null'] },
              capex_trend:              { type: 'string', enum: ['rising', 'flat', 'falling', 'unknown'] },
              receivable_days_current:  { type: ['number', 'null'] },
              receivable_days_prior:    { type: ['number', 'null'] },
              inventory_days_current:   { type: ['number', 'null'] },
              operating_margin_current: { type: ['string', 'null'] },
              operating_margin_prior:   { type: ['string', 'null'] },
              roce:                     { type: ['string', 'null'] },
              sentiment:                { type: 'string', enum: ['bullish', 'neutral', 'cautious'] },
            },
          },
        },
        investment_implications: {
          type: 'object',
          required: ['positive_signals', 'risks', 'recommended_strategy', 'next_quarter_watchpoints'],
          properties: {
            positive_signals: { type: 'array', items: { type: 'object', properties: { signal: { type: 'string' }, evidence: { type: 'string' } } } },
            risks:            { type: 'array', items: { type: 'object', properties: { risk:   { type: 'string' }, evidence: { type: 'string' } } } },
            recommended_strategy: {
              type: 'object',
              properties: {
                action:    { type: 'string', enum: ['BUY', 'AVOID', 'SELECTIVE'] },
                segment:   { type: 'string' },
                rationale: { type: 'string' },
                thesis:    { type: 'string' },
                timing:    { type: 'string' },
              },
            },
            next_quarter_watchpoints: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};


// ─── Output format instructions (appended to prompt — not enforced via response_format) ─

const OUTPUT_FORMAT_INSTRUCTIONS = `

---

## Required Output

Respond with a single valid JSON object only — no markdown fences, no explanation. Structure:

{
  "industry_analysis": {
    "score_card": {
      "total": 0,
      "status": "STRONG_INDUSTRY|MODERATE_INDUSTRY|WEAK_INDUSTRY",
      "status_color": "green|yellow|red",
      "dimensions": {
        "growth":             { "score": 0, "max": 2, "status": "Accelerating|Stable|Decelerating" },
        "demand":             { "score": 0, "max": 2, "status": "Strong|Mixed|Weak" },
        "supply":             { "score": 0, "max": 2, "status": "Tight|Balanced|Excess" },
        "profit_pool":        { "score": 0, "max": 2, "status": "Improving|Stable|Deteriorating" },
        "global_competition": { "score": 0, "max": 2, "status": "Protected|Moderate Competition|Heavy Competition" }
      }
    },
    "industry_metrics": {
      "revenue_growth_yoy":        { "value": null, "label": "Revenue Growth YoY (wtd avg)" },
      "revenue_cagr_3y":           { "value": null, "label": "Revenue 3Y CAGR (wtd avg)" },
      "qoq_acceleration":          { "value": null, "direction": "accelerating|stable|decelerating", "label": "QoQ Acceleration" },
      "bullish_sentiment":         { "count": 0, "total": 0, "label": "Bullish Sentiment (# companies)" },
      "rising_capex_count":        { "count": 0, "total": 0, "label": "Companies with Rising Capex" },
      "falling_receivables_count": { "count": 0, "total": 0, "label": "Companies with Falling Receivables" },
      "avg_capacity_utilization":  { "value": null, "label": "Avg Capacity Utilization %" },
      "high_utilization_count":    { "count": 0, "total": 0, "label": "Companies Above 85% Utilization" },
      "inventory_trend":           { "direction": "rising|stable|falling", "count": 0, "total": 0, "label": "Inventory Trend (majority)" },
      "industry_roce":             { "value": null, "vs_wacc_spread": null, "label": "Industry ROCE (%)" },
      "operating_margin":          { "value": null, "trend": "expanding|stable|contracting", "label": "Operating Margin (%)" }
    },
    "key_takeaway": "",
    "key_findings": [
      { "theme": "", "color": "green|amber|blue|red", "body": "" }
    ],
    "coherence_checks": [
      { "pattern": "", "type": "coherent|incoherent", "explanation": "" }
    ],
    "demand_drivers": {
      "positive":               [{ "driver": "", "mentioned_by": 0, "total_companies": 0 }],
      "negative":               [{ "concern": "", "mentioned_by": 0, "total_companies": 0 }],
      "representative_quotes":  [""]
    },
    "supply_drivers": {
      "tightness_indicators":  [{ "indicator": "", "mentioned_by": 0, "total_companies": 0 }],
      "excess_indicators":     [{ "indicator": "", "mentioned_by": 0, "total_companies": 0 }],
      "representative_quotes": [""]
    },
    "company_table": [
      {
        "company": "", "market_cap_cr": null, "revenue_latest_cr": null,
        "revenue_growth_yoy": null, "revenue_cagr_3y": null, "qoq_acceleration": null,
        "capex_trend": "rising|flat|falling|unknown",
        "receivable_days_current": null, "receivable_days_prior": null,
        "inventory_days_current": null,
        "operating_margin_current": null, "operating_margin_prior": null,
        "roce": null, "sentiment": "bullish|neutral|cautious"
      }
    ],
    "investment_implications": {
      "positive_signals": [{ "signal": "", "evidence": "" }],
      "risks":            [{ "risk": "",   "evidence": "" }],
      "recommended_strategy": {
        "action": "BUY|AVOID|SELECTIVE", "segment": "", "rationale": "", "thesis": "", "timing": ""
      },
      "next_quarter_watchpoints": [""]
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt    = (v, d = 1) => (v != null && !isNaN(v)) ? (+v).toFixed(d)             : 'N/A';
const fmtCr  = v          => (v != null && !isNaN(v)) ? `₹${(+v).toFixed(0)} Cr`    : 'N/A';
const fmtPct = v          => (v != null && !isNaN(v)) ? `${(+v).toFixed(1)}%`        : 'N/A';

function annualDays(balance, annualFlow) {
  if (balance == null || annualFlow == null || annualFlow === 0) return null;
  return (balance / annualFlow) * 365;
}

function quarterlyDays(balance, quarterlyFlow) {
  if (balance == null || quarterlyFlow == null || quarterlyFlow === 0) return null;
  return (balance / quarterlyFlow) * 91.25;
}

// ─── Company selection ────────────────────────────────────────────────────────

/**
 * Pick top N companies in the industry by market cap, subject always first.
 * Prefer companies with kpi_values data.
 *
 * @returns {Promise<Array<{ ticker, companyName, marketCapCr, hasKpi }>>}
 */
async function selectCompanies(prisma, subjectTicker, industry, maxCompanies = 5) {
  const industryRows = await prisma.earnings_calls.findMany({
    where:    { basic_industry: industry },
    select:   { company: true, company_name: true },
    distinct: ['company'],
  });

  const symbols = industryRows.map(c => c.company);

  const [mcRows, callRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT DISTINCT ON (symbol) symbol, "market_cap(Cr)"::float AS mc
      FROM market_cap WHERE symbol = ANY(${symbols})
      ORDER BY symbol, date DESC`,
    prisma.earnings_calls.findMany({
      where:  { company: { in: symbols } },
      select: { id: true, company: true },
    }),
  ]);

  const mcMap = Object.fromEntries(mcRows.map(r => [r.symbol, r.mc]));

  const callsByTicker = {};
  for (const c of callRows) {
    if (!callsByTicker[c.company]) callsByTicker[c.company] = [];
    callsByTicker[c.company].push(c.id);
  }

  const kpiHits = await prisma.kpiValue.groupBy({
    by:    ['callId'],
    where: { kpi_abbr: 'REV_OP', callId: { in: callRows.map(c => c.id) } },
    _count: { callId: true },
  });
  const kpiCallIds = new Set(kpiHits.map(r => r.callId));
  const hasKpi = t => (callsByTicker[t] ?? []).some(id => kpiCallIds.has(id));

  return industryRows
    .map(c => ({
      ticker:      c.company,
      companyName: c.company_name || c.company,
      marketCapCr: mcMap[c.company] ?? null,
      hasKpi:      hasKpi(c.company),
    }))
    .sort((a, b) => {
      if (a.ticker === subjectTicker) return -1;
      if (b.ticker === subjectTicker) return  1;
      if (a.hasKpi !== b.hasKpi)      return  a.hasKpi ? -1 : 1;
      return (b.marketCapCr ?? 0) - (a.marketCapCr ?? 0);
    })
    .slice(0, maxCompanies);
}

// ─── Data loading ─────────────────────────────────────────────────────────────

/**
 * Fetch prowess + kpi + summaries for all companies in parallel.
 */
async function loadCompanyData(prisma, companies) {
  const prowessHelper = new ProwessHelper(prisma);
  const finHelper     = new FinHelper(prisma);

  return Promise.all(companies.map(async ({ ticker, companyName, marketCapCr }) => {
    const [prowessBatch, kpiBatch, summaries, prowessName] = await Promise.all([
      prowessHelper.getTimeSeriesBatch(ticker, PROWESS_ABBRS),
      finHelper.getTimeSeriesBatch(ticker, KPI_ABBRS),
      prisma.summaryNew.findMany({
        where:   { callId: { startsWith: ticker + '_' } },
        select:  { callId: true, tone: true, industryAnalysis: true },
        orderBy: { callId: 'desc' },
        take:    2,
      }),
      prowessHelper.resolveProwessName(ticker),
    ]);
    return { ticker, companyName, marketCapCr, prowessName: prowessName ?? null, prowess: prowessBatch, kpi: kpiBatch, summaries };
  }));
}

// ─── Per-company block ────────────────────────────────────────────────────────

function buildCompanyBlock(cd) {
  const { ticker, companyName, marketCapCr, prowessName, prowess, kpi, summaries } = cd;
  const L = [];

  L.push(`${'═'.repeat(62)}`);
  L.push(`COMPANY    : ${ticker} — ${companyName}`);
  L.push(`Market Cap : ${marketCapCr != null ? `₹${marketCapCr.toLocaleString()} Cr` : 'N/A'}`);
  L.push(`Prowess    : ${prowessName ?? '(no match — kpi_values only)'}`);
  L.push(`${'═'.repeat(62)}`);

  // ── Annual trend from prowess ────────────────────────────────────────────
  const pRev  = prowess['REV_OP']     ?? [];
  const pPat  = prowess['PAT']        ?? [];
  const pRoce = prowess['ROCE']       ?? [];
  const pCfo  = prowess['CFO']        ?? [];
  const pPpe  = prowess['ASSET_PPE']  ?? [];
  const pCwip = prowess['ASSET_CWIP'] ?? [];
  const pRecv = prowess['TRADE_RECV'] ?? [];
  const pInv  = prowess['INVENTORY']  ?? [];
  const pPay  = prowess['TRADE_PAY']  ?? [];
  const pCogs = prowess['COST_MAT']   ?? [];

  const prowessRevRows = pRev.filter(s => s.value != null);

  if (prowessRevRows.length) {
    L.push('');
    L.push('▸ ANNUAL TREND  [Prowess — audited; Q4 = full-year figure]');
    L.push('  Period    | Revenue (Cr) | PAT (Cr) | ROCE (%) | CFO (Cr)');
    L.push('  ' + '─'.repeat(58));
    for (const r of prowessRevRows) {
      const pat  = pPat.find(s => s.fiscal_year === r.fiscal_year)?.value;
      const roce = pRoce.find(s => s.fiscal_year === r.fiscal_year)?.value;
      const cfo  = pCfo.find(s => s.fiscal_year === r.fiscal_year)?.value;
      L.push(`  ${r.fiscal_year.padEnd(9)} | ${fmtCr(r.value).padEnd(13)}| ${fmtCr(pat).padEnd(9)}| ${fmt(roce).padEnd(7)}%| ${fmtCr(cfo)}`);
    }
    if (prowessRevRows.length >= 2) {
      const yoy = growth(prowessRevRows.at(-1).value, prowessRevRows.at(-2).value);
      L.push(`  YoY revenue (annual)  : ${fmtPct(yoy)}`);
    }
    if (prowessRevRows.length >= 3) {
      const c = cagr(prowessRevRows.at(-3).value, prowessRevRows.at(-1).value, 2);
      L.push(`  2Y CAGR (annual)      : ${fmtPct(c)}`);
    }

    // Capex estimate from PPE+CWIP delta
    const ppeRows = pPpe.filter(s => s.value != null);
    if (ppeRows.length >= 2) {
      const curr  = ppeRows.at(-1).value + (pCwip.find(s => s.fiscal_year === ppeRows.at(-1).fiscal_year)?.value ?? 0);
      const prior = ppeRows.at(-2).value + (pCwip.find(s => s.fiscal_year === ppeRows.at(-2).fiscal_year)?.value ?? 0);
      const delta = curr - prior;
      L.push(`  Capex est (ΔPPEgross) : ${fmtCr(delta)} (${delta > 0 ? 'Rising ↑' : 'Falling ↓'})`);
    }

    // Working capital — annual basis ÷365
    const wcFYs = pRecv.filter(s => s.value != null).map(s => s.fiscal_year);
    if (wcFYs.length) {
      L.push('');
      L.push('▸ WORKING CAPITAL  [Prowess annual; days = balance ÷ (annual flow / 365)]');
      L.push('  Period    | RECV (Cr)  | INV (Cr)  | PAY (Cr)  | DSO   | DIO   | DPO');
      L.push('  ' + '─'.repeat(70));
      const dsoSeries = [];
      for (const fy of wcFYs) {
        const recv = pRecv.find(s => s.fiscal_year === fy)?.value;
        const inv  = pInv.find(s => s.fiscal_year === fy)?.value;
        const pay  = pPay.find(s => s.fiscal_year === fy)?.value;
        const rev  = pRev.find(s => s.fiscal_year === fy)?.value;
        const cogs = pCogs.find(s => s.fiscal_year === fy)?.value;
        const dso  = annualDays(recv, rev);
        const dio  = annualDays(inv, cogs);
        const dpo  = annualDays(pay, cogs);
        if (dso != null) dsoSeries.push(dso);
        L.push(
          `  ${fy.padEnd(9)} | ${fmtCr(recv).padEnd(10)}| ${fmtCr(inv).padEnd(10)}| ${fmtCr(pay).padEnd(10)}| ` +
          `${dso != null ? fmt(dso, 0) + 'd' : 'N/A'} | ${dio != null ? fmt(dio, 0) + 'd' : 'N/A'} | ${dpo != null ? fmt(dpo, 0) + 'd' : 'N/A'}`
        );
      }
      if (dsoSeries.length >= 2) {
        const d = dsoSeries.at(-1) - dsoSeries[0];
        L.push(`  DSO trend: ${fmt(dsoSeries[0], 0)}d → ${fmt(dsoSeries.at(-1), 0)}d (${d > 3 ? 'Rising ⚠' : d < -3 ? 'Falling ✓' : 'Stable'})`);
      }
    }
  }

  // ── Recent quarterly P&L from kpi_values (QE source only) ──────────────
  const qRev = (kpi['REV_OP']    ?? []).filter(s => s.value != null).slice(-6);
  const qPbt = kpi['PBT']        ?? [];
  const qFin = kpi['FIN_COST']   ?? [];
  const qDep = kpi['DEP_AMORT']  ?? [];

  if (qRev.length) {
    L.push('');
    L.push('▸ QUARTERLY P&L  [QE source; EBITDA = PBT + FIN_COST + DEP_AMORT; duration: Q=quarter]');
    L.push('  Quarter        | Revenue (Cr)    | EBITDA (Cr)     | EBITDA Margin');
    L.push('  ' + '─'.repeat(70));
    for (const r of qRev) {
      const pbt = qPbt.find(e => e.callId === r.callId)?.value;
      const fin = qFin.find(e => e.callId === r.callId)?.value;
      const dep = qDep.find(e => e.callId === r.callId)?.value;
      const ebitda = (pbt != null && fin != null && dep != null) ? pbt + fin + dep : null;
      const margin = (ebitda != null && r.value > 0) ? (ebitda / r.value) * 100 : null;
      const revStr = `${fmtCr(r.value)} ${kpiDuration(r)}`;
      const ebiStr = ebitda != null ? `${fmtCr(ebitda)} ${kpiDuration(r)}` : 'N/A';
      const opmStr = margin != null ? `${fmtPct(margin)} ${kpiDuration(r)}` : 'N/A';
      L.push(`  ${(r.fiscal_year + ' ' + r.quarter).padEnd(14)} | ${revStr.padEnd(16)}| ${ebiStr.padEnd(16)}| ${opmStr}`);
    }
    // QoQ growth + acceleration
    if (qRev.length >= 2) {
      const qoqs = [];
      for (let i = 1; i < qRev.length; i++) {
        const g = growth(qRev[i].value, qRev[i - 1].value);
        if (g != null) qoqs.push(g);
      }
      if (qoqs.length)      L.push(`  QoQ revenue    : ${qoqs.map(q => fmtPct(q)).join(' → ')}`);
      if (qoqs.length >= 2) {
        const accel = qoqs.at(-1) - qoqs.at(-2);
        L.push(`  QoQ accel      : ${fmtPct(accel)} (${accel > 1 ? 'Accelerating ↑' : accel < -1 ? 'Decelerating ↓' : 'Stable →'})`);
      }
    }
  }

  // ── Recent WC quarters not yet in prowess ────────────────────────────────
  const latestProwessFY = prowessRevRows.at(-1)?.fiscal_year ?? '';
  const extraRecv = (kpi['TRADE_RECV'] ?? []).filter(s => s.value != null && s.fiscal_year > latestProwessFY);
  const extraInv  = (kpi['INVENTORY']  ?? []).filter(s => s.value != null && s.fiscal_year > latestProwessFY);
  const extraPay  = (kpi['TRADE_PAY']  ?? []).filter(s => s.value != null && s.fiscal_year > latestProwessFY);
  const extraCids = [...new Set([...extraRecv, ...extraInv, ...extraPay].map(r => r.callId))].sort();

  if (extraCids.length) {
    L.push('');
    L.push('▸ WORKING CAPITAL — RECENT  [kpi_values; days = balance ÷ (quarterly rev / 91.25)]');
    L.push('  Quarter        | RECV (Cr)  | INV (Cr)  | PAY (Cr)  | DSO   | DIO   | DPO');
    L.push('  ' + '─'.repeat(72));
    for (const cid of extraCids) {
      const recv = (kpi['TRADE_RECV'] ?? []).find(r => r.callId === cid);
      const inv  = (kpi['INVENTORY']  ?? []).find(r => r.callId === cid);
      const pay  = (kpi['TRADE_PAY']  ?? []).find(r => r.callId === cid);
      const rev  = (kpi['REV_OP']     ?? []).find(r => r.callId === cid);
      const cogs = (kpi['COST_MAT']   ?? []).find(r => r.callId === cid);
      const dso  = quarterlyDays(recv?.value, rev?.value);
      const dio  = quarterlyDays(inv?.value,  cogs?.value);
      const dpo  = quarterlyDays(pay?.value,  cogs?.value);
      L.push(
        `  ${cid.replace(/^[A-Z]+_/, '').padEnd(14)} | ${fmtCr(recv?.value).padEnd(10)}| ${fmtCr(inv?.value).padEnd(10)}| ` +
        `${fmtCr(pay?.value).padEnd(10)}| ${dso != null ? fmt(dso, 0) + 'd' : 'N/A'} | ` +
        `${dio != null ? fmt(dio, 0) + 'd' : 'N/A'} | ${dpo != null ? fmt(dpo, 0) + 'd' : 'N/A'}`
      );
    }
  }

  // ── Transcript intelligence ──────────────────────────────────────────────
  if (summaries.length) {
    L.push('');
    L.push('▸ TRANSCRIPT INTELLIGENCE  [last 2 calls, newest first]');
    for (const s of summaries) {
      const ia = s.industryAnalysis;
      L.push(`  [${s.callId}]  tone: ${s.tone ?? 'N/A'}`);
      const demandF = ia?.demand?.factors_affecting ?? [];
      if (demandF.length) L.push(`    DEMAND : ${demandF.slice(0, 3).join('  |  ')}`);
      const demandK = (ia?.demand?.kpis ?? []).filter(k => k.value != null).slice(0, 3);
      if (demandK.length) L.push(`    D-KPIs : ${demandK.map(k => `${k.kpi_abbr}=${k.value}`).join('  |  ')}`);
      const supplyF = ia?.supply?.factors_affecting ?? [];
      if (supplyF.length) L.push(`    SUPPLY : ${supplyF.slice(0, 3).join('  |  ')}`);
      const capUtil = (ia?.supply?.kpis ?? []).find(k => k.value != null && ['SEG_GF_UTIL', 'CAP_UTIL', 'UTIL'].includes(k.kpi_abbr));
      if (capUtil) L.push(`    CAP UTIL: ${capUtil.value}% — ${capUtil.statement ?? ''}`);
      const opmF = ia?.operating_margins?.factors_affecting ?? [];
      if (opmF.length) L.push(`    OPM    : ${opmF.slice(0, 2).join('  |  ')}`);
    }
  }

  return L.join('\n');
}

// ─── Full data block ──────────────────────────────────────────────────────────

function buildDataBlock(industry, companies, bfsi = false) {
  const header = [
    `INDUSTRY    : ${industry}${bfsi ? '  [BFSI]' : ''}`,
    `Companies   : ${companies.length}  (subject first, then by market cap desc)`,
    `              ${companies.map(c => `${c.ticker} (${c.marketCapCr != null ? '₹' + c.marketCapCr.toLocaleString() + ' Cr' : 'N/A'})`).join('  |  ')}`,
    `Sources     : prowess_values_new (annual) → primary  |  kpi_values (quarterly) → supplement`,
    `Note        : Prowess Q4 = full-year annual total. kpi_values = per-quarter amount.`,
    '',
  ];
  return [...header, ...companies.map(c => buildCompanyBlock(c))].join('\n');
}

// ─── Main prompt builder ──────────────────────────────────────────────────────

/**
 * @param {string}      industry
 * @param {object[]}    companies           - CompanyData[] from loadCompanyData
 * @param {boolean}     [bfsi=false]
 * @param {string|null} template            - DB skill.promptTemplate (falls back to inline template)
 */
function nseIndustryPrompt(industry, companies, bfsi = false, dbTemplate = null) {
  if (!dbTemplate) throw new Error('[nseIndustryPrompt] dbTemplate is required — configure skill "nse-industry" in DB');

  const dataBlock = buildDataBlock(industry, companies, bfsi);

  const parts = [
    dbTemplate,
    '',
    '---',
    '',
    '## Data Provided for Analysis',
    '',
    dataBlock,
    OUTPUT_FORMAT_INSTRUCTIONS,
  ];

  return parts.join('\n');
}

module.exports = {
  nseIndustryPrompt,
  buildDataBlock,
  loadCompanyData,
  selectCompanies,
  OUTPUT_SCHEMA,
};
