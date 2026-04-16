'use strict';
require('dotenv').config();
const { FinHelper } = require('../utils/finHelper');
const { isBFSI } = require('../utils/industryClassifier');
const prisma = require('../lib/prisma');

async function checkTicker(ticker, callId) {
  // Get the call to determine industry
  const call = await prisma.earnings_calls.findUnique({
    where: { id: callId },
    select: { basic_industry: true }
  });
  const industry = call?.basic_industry ?? 'Unknown';
  const bfsi = isBFSI(industry);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Ticker: ${ticker}  |  Call: ${callId}`);
  console.log(`Industry: ${industry}  |  BFSI: ${bfsi}`);
  console.log('='.repeat(60));

  // Raw KPIs from summary
  const summary = await prisma.summaryNew.findFirst({
    where: { callId },
    select: { kpis: true }
  });
  const kpis = Array.isArray(summary?.kpis) ? summary.kpis : [];
  console.log(`\nTotal KPI entries in summary: ${kpis.length}`);

  const DIRECT = [
    'REV_OP','COST_MAT','PURCH_STOCK','INV_CHG','EMP_EXP','OTH_EXP',
    'DEP_AMORT','FIN_COST','PAT','PBT','CFO','PROV_CONT',
    'TRADE_RECV','TRADE_PAY','INVENTORY',
    'DEBT_LT','DEBT_ST','CASH_EQUIV',
    'EQ_SHARE_CAP','RES_SURPLUS','ASSET_PPE','ASSET_CWIP',
    'TOTAL_ASSETS','CURR_LIAB'
  ];

  console.log('\n--- DIRECT KPIs (in this summary) ---');
  let directFound = 0;
  for (const abbr of DIRECT) {
    const match = kpis.find(k => k.kpi_abbr === abbr && (k.kpi_value != null || k.value != null));
    const val = match ? (match.kpi_value ?? match.value) : null;
    if (val != null) directFound++;
    console.log(`  ${abbr.padEnd(15)}: ${val ?? 'MISSING'}`);
  }
  console.log(`\n  Direct: ${directFound}/${DIRECT.length} found`);

  // Batch functions (all quarters for ticker)
  const helper = new FinHelper(prisma);
  const [rawBatch, derivedBatch] = await Promise.all([
    helper.getTimeSeriesBatch(ticker, DIRECT),
    helper.getDerivedKpiBatch(ticker, bfsi),
  ]);

  console.log('\n--- DERIVED KPIs (Q4 only, all available years) ---');
  for (const [abbr, series] of Object.entries(derivedBatch)) {
    const q4 = series.filter(s => s.quarter === 'Q4' && s.value != null);
    const status = q4.length > 0 ? `${q4.length} yr(s): ${q4.map(s => `${s.period}=${s.value}`).join(' | ')}` : 'MISSING (check source KPIs)';
    console.log(`  ${abbr.padEnd(12)}: ${status}`);
  }

  // Summary counts
  const derivedWithData = Object.entries(derivedBatch).filter(([, s]) => s.some(r => r.value != null)).length;
  console.log(`\n  Derived: ${derivedWithData}/${Object.keys(derivedBatch).length} computable`);
}

async function main() {
  await checkTicker('360ONE', '360ONE_FY2025_Q4');
}

main().catch(console.error).finally(() => prisma.$disconnect());
